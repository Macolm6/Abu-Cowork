/**
 * The file-edit runner's loop, judging and metrics, driven by a scripted
 * adapter (no model) against the REAL file tools running on an in-memory
 * `ToolFileAccess` — the same seam the Electron host provides per tool call.
 */
import { describe, expect, it } from 'vitest';
import type { LLMAdapter } from '@/core/llm/adapter';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { editFileTool, listDirectoryTool, readFileTool, writeFileTool } from '@/core/tools/definitions/fileTools';
import type { Message, StreamEvent, ToolDefinition } from '@/types';
import {
  applyFilters,
  buildUserInstruction,
  judgeFileEditCase,
  normalizeFileText,
  runFileEditCase,
  runFileEditEval,
  type EvalWorkspace,
  type FileEditRunDeps,
} from './fileEditRunner';
import type { EvalTarget, FileEditCase } from './types';

// ── In-memory file system shared by the tools and the workspace ──

function createMemoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const ensureDir = (dir: string) => {
    let current = dir;
    while (current && current !== '/') {
      dirs.add(current);
      current = parentOf(current);
    }
  };
  const isDir = (p: string) => dirs.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`));

  const access: ToolFileAccess = {
    executionInput: {},
    originalPath: (p) => p,
    prepare: async () => {},
    assertCurrent: async () => {},
    assertActive: () => {},
    resultGuard: () => ({ assertCurrent: async () => {}, assertActive: () => {} }),
    async stat(p) {
      if (files.has(p)) return { isFile: true, isDirectory: false, isSymlink: false, size: Buffer.byteLength(files.get(p)!), mtime: null };
      if (isDir(p)) return { isFile: false, isDirectory: true, isSymlink: false, size: 0, mtime: null };
      throw new Error(`ENOENT: ${p}`);
    },
    exists: async (p) => files.has(p) || isDir(p),
    async readTextFile(p) {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    readFile: async (p) => new TextEncoder().encode(await access.readTextFile(p)),
    processImage: () => { throw new Error('unsupported'); },
    runProcessor: () => { throw new Error('unsupported'); },
    openDocument: () => { throw new Error('unsupported'); },
    async writeTextFile(p, text) {
      if (!isDir(parentOf(p))) throw new Error(`ENOENT: parent of ${p}`);
      files.set(p, text);
    },
    writeFile: async (p, bytes) => access.writeTextFile(p, new TextDecoder().decode(bytes)),
    ensureParentDir: async (p) => ensureDir(parentOf(p)),
    async readDir(p) {
      const names = new Map<string, boolean>();
      for (const f of files.keys()) {
        if (!f.startsWith(`${p}/`)) continue;
        const rest = f.slice(p.length + 1);
        const [head] = rest.split('/');
        names.set(head, rest.includes('/'));
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false }));
    },
    async *walkFiles(p) {
      for (const f of [...files.keys()].sort()) {
        if (f.startsWith(`${p}/`)) yield { path: f, name: f.slice(f.lastIndexOf('/') + 1) };
      }
    },
    async searchLines(p, pattern, maxResults) {
      const regex = new RegExp(pattern);
      const matches: Array<{ lineNumber: number; line: string }> = [];
      const lines = (await access.readTextFile(p)).split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (regex.test(lines[i])) matches.push({ lineNumber: i + 1, line: lines[i] });
      }
      return { searchable: true, matches, bytesRead: 0 };
    },
    prepareDelete: async () => {},
    moveToTrash: async (p) => { files.delete(p); },
    dispose: async () => {},
  };

  const workspace: EvalWorkspace = {
    caseDir: (caseId) => `/eval/${caseId}`,
    async prepare(caseId, initial) {
      const dir = `/eval/${caseId}`;
      for (const f of [...files.keys()]) if (f.startsWith(`${dir}/`)) files.delete(f);
      ensureDir(dir);
      for (const [rel, content] of Object.entries(initial)) {
        const full = `${dir}/${rel}`;
        ensureDir(parentOf(full));
        files.set(full, content);
      }
    },
    readText: async (p) => files.get(p) ?? null,
    listFiles: async (dir) => [...files.keys()].filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)).sort(),
  };

  return { files, access, workspace };
}

// ── Scripted adapter: each chat() call replays the next event list ──

function scriptedAdapter(turns: StreamEvent[][]): LLMAdapter & { calls: Message[][] } {
  let index = 0;
  const calls: Message[][] = [];
  return {
    calls,
    async chat(messages, _options, onEvent) {
      calls.push(messages.map((m) => ({ ...m, toolCalls: m.toolCalls?.map((tc) => ({ ...tc })) })));
      const events = turns[index++];
      if (!events) throw new Error(`no scripted turn ${index}`);
      for (const event of events) onEvent(event);
    },
  };
}

const BOM = String.fromCharCode(0xfeff);
const target: EvalTarget = { providerId: 'test', modelId: 'test-model', label: 'test:test-model' };
const tools: ToolDefinition[] = [readFileTool, writeFileTool, editFileTool, listDirectoryTool];

const replaceCase: FileEditCase = {
  id: 'single-replace-01',
  category: 'single-replace',
  difficulty: 'easy',
  instruction: '把 config.json 里的端口从 3000 改成 8080。',
  files: { 'config.json': '{\n  "port": 3000\n}\n', 'README.md': '# demo\n' },
  expected: { 'config.json': '{\n  "port": 8080\n}\n' },
};

const createCase: FileEditCase = {
  id: 'create-03',
  category: 'create',
  difficulty: 'medium',
  instruction: '在 notes 子目录下新建 today.md。',
  files: { 'README.md': '# 笔记\n' },
  expected: { 'notes/today.md': '# 今日计划\n\n- 整理会议纪要\n' },
};

function deps(adapter: LLMAdapter, fs = createMemoryFs(), overrides: Partial<FileEditRunDeps> = {}): FileEditRunDeps {
  let tick = 1_000;
  return {
    adapter,
    tools,
    fileAccess: fs.access,
    workspace: fs.workspace,
    systemPrompt: 'You are Abu.',
    chatOptions: { model: 'test-model', apiKey: 'k', baseUrl: 'http://localhost' },
    runId: 'run-1',
    now: () => (tick += 10),
    ...overrides,
  };
}

const usage = (input: number, output: number): StreamEvent => ({ type: 'usage', usage: { inputTokens: input, outputTokens: output } });
const done = (stopReason: string): StreamEvent => ({ type: 'done', stopReason });

describe('runFileEditCase', () => {
  it('passes when edit_file produces the expected file, and records the metrics', async () => {
    const adapter = scriptedAdapter([
      [
        { type: 'text', text: '我来改。' },
        { type: 'tool_use', id: 'tu1', name: 'edit_file', input: { path: '/eval/single-replace-01/config.json', old_content: '"port": 3000', new_content: '"port": 8080' } },
        usage(100, 20),
        done('tool_use'),
      ],
      [{ type: 'text', text: '改好了。' }, usage(150, 10), done('end_turn')],
    ]);
    const result = await runFileEditCase(replaceCase, target, deps(adapter));

    expect(result.passed).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.extraFiles).toEqual([]);
    expect(result.turns).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.writeToolCallCount).toBe(1);
    expect(result.textOnlyEndTurn).toBe(false);
    expect(result.tokenUsage).toEqual({ input: 250, output: 30 });
    expect(result.finalText).toBe('改好了。');
    expect(result.toolCalls).toEqual([{ name: 'edit_file', path: '/eval/single-replace-01/config.json', isError: false }]);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();

    // The second request carried the tool call and its real result in the history.
    const second = adapter.calls[1];
    expect(second).toHaveLength(2);
    expect(second[0].role).toBe('user');
    expect(second[0].content).toBe(buildUserInstruction(replaceCase, '/eval/single-replace-01'));
    expect(second[1].role).toBe('assistant');
    expect(second[1].toolCalls?.[0]).toMatchObject({ id: 'tu1', name: 'edit_file', isError: false });
    expect(second[1].toolCalls?.[0].result).toMatch(/^Successfully edited/);
  });

  it('flags textOnlyEndTurn when the model never calls a write tool', async () => {
    const adapter = scriptedAdapter([[{ type: 'text', text: '好的，我把端口改成 8080。' }, done('end_turn')]]);
    const result = await runFileEditCase(replaceCase, target, deps(adapter));

    expect(result.passed).toBe(false);
    expect(result.textOnlyEndTurn).toBe(true);
    expect(result.writeToolCallCount).toBe(0);
    expect(result.mismatches).toEqual([
      { path: 'config.json', reason: 'content', expected: replaceCase.expected['config.json'], actual: replaceCase.files['config.json'] },
    ]);
  });

  it('counts a read-only run as textOnlyEndTurn too', async () => {
    const adapter = scriptedAdapter([
      [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: '/eval/single-replace-01/config.json' } }, done('tool_use')],
      [{ type: 'text', text: '看完了。' }, done('end_turn')],
    ]);
    const result = await runFileEditCase(replaceCase, target, deps(adapter));

    expect(result.toolCallCount).toBe(1);
    expect(result.writeToolCallCount).toBe(0);
    expect(result.textOnlyEndTurn).toBe(true);
    expect(result.passed).toBe(false);
    expect(adapter.calls[1][1].toolCalls?.[0].result).toBe(replaceCase.files['config.json']);
  });

  it('records a failed edit as an error call and still passes after a write_file rewrite', async () => {
    const adapter = scriptedAdapter([
      [{ type: 'tool_use', id: 'tu1', name: 'edit_file', input: { path: '/eval/single-replace-01/config.json', old_content: 'port = 3000', new_content: 'port = 8080' } }, done('tool_use')],
      [{ type: 'tool_use', id: 'tu2', name: 'write_file', input: { path: '/eval/single-replace-01/config.json', content: '{\n  "port": 8080\n}\n' } }, done('tool_use')],
      [{ type: 'text', text: '完成。' }, done('end_turn')],
    ]);
    const result = await runFileEditCase(replaceCase, target, deps(adapter));

    expect(result.passed).toBe(true);
    expect(result.toolCalls).toEqual([
      { name: 'edit_file', path: '/eval/single-replace-01/config.json', isError: true },
      { name: 'write_file', path: '/eval/single-replace-01/config.json', isError: false },
    ]);
    expect(result.writeToolCallCount).toBe(2);
    expect(adapter.calls[1][1].toolCalls?.[0].result).toMatch(/^Error: old_content not found/);
  });

  it('creates a file in a new subdirectory through write_file', async () => {
    const fs = createMemoryFs();
    const adapter = scriptedAdapter([
      [{ type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: '/eval/create-03/notes/today.md', content: '# 今日计划\n\n- 整理会议纪要\n' } }, done('tool_use')],
      [{ type: 'text', text: '新建好了。' }, done('end_turn')],
    ]);
    const result = await runFileEditCase(createCase, target, deps(adapter, fs));

    expect(result.passed).toBe(true);
    expect(fs.files.get('/eval/create-03/notes/today.md')).toBe('# 今日计划\n\n- 整理会议纪要\n');
  });

  it('fails a case whose untouched file was changed, and lists stray files', async () => {
    const adapter = scriptedAdapter([
      [
        { type: 'tool_use', id: 'tu1', name: 'edit_file', input: { path: '/eval/single-replace-01/config.json', old_content: '3000', new_content: '8080' } },
        { type: 'tool_use', id: 'tu2', name: 'edit_file', input: { path: '/eval/single-replace-01/README.md', old_content: '# demo', new_content: '# demo (8080)' } },
        { type: 'tool_use', id: 'tu3', name: 'write_file', input: { path: '/eval/single-replace-01/config.json.bak', content: 'x' } },
        done('tool_use'),
      ],
      [{ type: 'text', text: '完成。' }, done('end_turn')],
    ]);
    const result = await runFileEditCase(replaceCase, target, deps(adapter));

    expect(result.passed).toBe(false);
    expect(result.mismatches).toEqual([
      { path: 'README.md', reason: 'unexpected-change', expected: '# demo\n', actual: '# demo (8080)\n' },
    ]);
    expect(result.extraFiles).toEqual(['config.json.bak']);
    expect(result.toolCallCount).toBe(3);
    expect(result.writeToolCallCount).toBe(3);
  });

  it('answers an unknown tool with an error result instead of crashing', async () => {
    const adapter = scriptedAdapter([
      [{ type: 'tool_use', id: 'tu1', name: 'run_command', input: { command: 'sed -i s/3000/8080/ config.json' } }, done('tool_use')],
      [{ type: 'text', text: '完成。' }, done('end_turn')],
    ]);
    const result = await runFileEditCase(replaceCase, target, deps(adapter));

    expect(result.toolCalls).toEqual([{ name: 'run_command', path: undefined, isError: true }]);
    expect(adapter.calls[1][1].toolCalls?.[0].result).toBe('Error: unknown tool run_command');
    expect(result.passed).toBe(false);
    expect(result.textOnlyEndTurn).toBe(true);
  });

  it('stops at the turn limit with an error and without counting textOnlyEndTurn', async () => {
    const readTurn: StreamEvent[] = [
      { type: 'tool_use', id: 'tu', name: 'read_file', input: { path: '/eval/single-replace-01/config.json' } },
      done('tool_use'),
    ];
    const adapter = scriptedAdapter([readTurn, readTurn, readTurn, readTurn]);
    const result = await runFileEditCase(replaceCase, target, deps(adapter, undefined, { maxTurns: 3 }));

    expect(result.turns).toBe(3);
    expect(result.error).toBe('Turn limit reached (3) with tool calls still pending');
    expect(result.passed).toBe(false);
    expect(result.textOnlyEndTurn).toBe(false);
    expect(adapter.calls).toHaveLength(3);
  });

  it('surfaces an adapter error event and a thrown adapter error', async () => {
    const eventError = scriptedAdapter([[{ type: 'error', error: 'rate limited' }]]);
    const fromEvent = await runFileEditCase(replaceCase, target, deps(eventError));
    expect(fromEvent.error).toBe('rate limited');
    expect(fromEvent.passed).toBe(false);
    expect(fromEvent.textOnlyEndTurn).toBe(false);
    expect(fromEvent.turns).toBe(1);

    const throwing: LLMAdapter = { chat: async () => { throw new Error('ECONNRESET'); } };
    const fromThrow = await runFileEditCase(replaceCase, target, deps(throwing));
    expect(fromThrow.error).toBe('ECONNRESET');
    expect(fromThrow.passed).toBe(false);
  });

  it('keeps the larger usage figure when a request reports usage more than once', async () => {
    const adapter = scriptedAdapter([
      [usage(120, 0), { type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 7 } }],
    ]);
    const result = await runFileEditCase(replaceCase, target, deps(adapter));
    expect(result.tokenUsage).toEqual({ input: 120, output: 7 });
  });
});

describe('judgeFileEditCase', () => {
  it('reports a missing expected file', async () => {
    const fs = createMemoryFs();
    await fs.workspace.prepare(createCase.id, createCase.files);
    const { mismatches, extraFiles } = await judgeFileEditCase(createCase, '/eval/create-03', fs.workspace);
    expect(mismatches).toEqual([{ path: 'notes/today.md', reason: 'missing', expected: createCase.expected['notes/today.md'] }]);
    expect(extraFiles).toEqual([]);
  });

  it('ignores line endings, a BOM and the trailing newline', async () => {
    const fs = createMemoryFs();
    await fs.workspace.prepare(replaceCase.id, replaceCase.files);
    fs.files.set('/eval/single-replace-01/config.json', `${BOM}{\r\n  "port": 8080\r\n}`);
    const { mismatches } = await judgeFileEditCase(replaceCase, '/eval/single-replace-01', fs.workspace);
    expect(mismatches).toEqual([]);
  });
});

describe('normalizeFileText', () => {
  it('strips a BOM, CRLF and trailing newlines only', () => {
    expect(normalizeFileText(`${BOM}a\r\nb\n\n`)).toBe('a\nb');
    expect(normalizeFileText('a\tb  \n')).toBe('a\tb  ');
    expect(normalizeFileText('x\n\ny')).toBe('x\n\ny');
  });
});

describe('applyFilters', () => {
  const all = [replaceCase, createCase];
  it('filters by id and by category', () => {
    expect(applyFilters(all, { filter: ['create-03'] }).map((c) => c.id)).toEqual(['create-03']);
    expect(applyFilters(all, { category: 'single-replace' }).map((c) => c.id)).toEqual(['single-replace-01']);
    expect(applyFilters(all, {}).map((c) => c.id)).toEqual(['single-replace-01', 'create-03']);
  });
});

describe('runFileEditEval', () => {
  it('runs each selected case in order and logs one line per case', async () => {
    const adapter = scriptedAdapter([
      [{ type: 'text', text: 'nope' }, done('end_turn')],
      [{ type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: '/eval/create-03/notes/today.md', content: '# 今日计划\n\n- 整理会议纪要\n' } }, done('tool_use')],
      [{ type: 'text', text: 'done' }, done('end_turn')],
    ]);
    const lines: string[] = [];
    const results = await runFileEditEval([replaceCase, createCase], target, deps(adapter, undefined, { log: (l) => lines.push(l) }));

    expect(results.map((r) => [r.caseId, r.passed])).toEqual([['single-replace-01', false], ['create-03', true]]);
    expect(lines.some((l) => l.includes('❌ single-replace-01') && l.includes('textOnlyEndTurn'))).toBe(true);
    expect(lines.some((l) => l.includes('✅ create-03'))).toBe(true);
  });
});
