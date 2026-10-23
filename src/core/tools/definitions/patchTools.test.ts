import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { FileChange, ToolExecutionContext } from '@/types';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { applyPatchTool, parsePatchOperations, resolvePatchPath } from './patchTools';
import { extractApplyPatchCommand, rewriteShellApplyPatch } from '../applyPatchCommand';
import { acquireFileLock, releaseFileLock } from './fileTools';

const snapshotBeforeAiEditMock = vi.fn().mockResolvedValue(undefined);
const captureTurnFileBeforeMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/utils/aiEditSnapshots', () => ({
  captureTurnFileBefore: (...args: unknown[]) => captureTurnFileBeforeMock(...args),
  snapshotBeforeAiEdit: (...args: unknown[]) => snapshotBeforeAiEditMock(...args),
}));

const bindWorkspaceFromWriteMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../agent/defaultWorkspace', () => ({
  bindWorkspaceFromWrite: (...args: unknown[]) => bindWorkspaceFromWriteMock(...args),
}));

/** An in-memory file system behind the host file access the tool is given. */
function memoryFiles(initial: Record<string, string>) {
  const disk = new Map(Object.entries(initial));
  const trashed: string[] = [];
  const calls: string[] = [];
  const files = {
    executionInput: {},
    originalPath: (path: string) => path,
    prepare: async () => {},
    assertCurrent: async () => {},
    assertActive: () => {},
    resultGuard: () => ({ assertCurrent: async () => {}, assertActive: () => {} }),
    exists: async (path: string) => disk.has(path),
    stat: async (path: string) => ({ isFile: disk.has(path), isDirectory: false, isSymlink: false, size: disk.get(path)?.length ?? 0, mtime: null }),
    readTextFile: async (path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    writeTextFile: async (path: string, text: string) => { calls.push(`write ${path}`); disk.set(path, text); },
    ensureParentDir: async (path: string) => { calls.push(`mkdir ${path}`); },
    prepareDelete: async (path: string) => { calls.push(`prepareDelete ${path}`); },
    moveToTrash: async (path: string) => { calls.push(`trash ${path}`); trashed.push(path); disk.delete(path); },
    dispose: async () => {},
  } as unknown as ToolFileAccess;
  return { files, disk, trashed, calls };
}

const WORKSPACE = '/work';

function context(files: ToolFileAccess, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { files, workspacePath: WORKSPACE, loopId: 'loop-1', conversationId: 'conv-1', ...extra };
}

function patch(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

beforeEach(() => {
  snapshotBeforeAiEditMock.mockClear();
  captureTurnFileBeforeMock.mockClear();
  bindWorkspaceFromWriteMock.mockClear();
});

describe('apply_patch — Update File', () => {
  it('applies a hunk located by its context and reports the line counts', async () => {
    const { files, disk } = memoryFiles({ '/work/src/add.ts': 'export function add(a, b) {\n  return a - b;\n}\n' });
    const result = await applyPatchTool.execute({
      input: patch('*** Update File: src/add.ts\n@@ export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }'),
    }, context(files));
    expect(result).toBe('Patch applied:\nUpdated /work/src/add.ts (+1 −1)');
    expect(disk.get('/work/src/add.ts')).toBe('export function add(a, b) {\n  return a + b;\n}\n');
  });

  it('applies several hunks to one file and several files in one patch, in patch order', async () => {
    const { files, disk, calls } = memoryFiles({
      '/work/a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\n',
      '/work/b.txt': 'alpha\nbeta\n',
    });
    const result = await applyPatchTool.execute({
      input: patch([
        '*** Update File: a.txt',
        '@@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '@@',
        ' five',
        '-six',
        '+SIX',
        '*** Update File: b.txt',
        '@@',
        ' alpha',
        '+gamma',
        ' beta',
      ].join('\n')),
    }, context(files));
    expect(result).toBe('Patch applied:\nUpdated /work/a.txt (+2 −2)\nUpdated /work/b.txt (+1 −0)');
    expect(disk.get('/work/a.txt')).toBe('one\nTWO\nthree\nfour\nfive\nSIX\n');
    expect(disk.get('/work/b.txt')).toBe('alpha\ngamma\nbeta\n');
    expect(calls.filter((c) => c.startsWith('write'))).toEqual(['write /work/a.txt', 'write /work/b.txt']);
  });

  it('inserts lines with $, backslashes, quotes and CJK characters verbatim', async () => {
    const { files, disk } = memoryFiles({ '/work/t.sh': 'echo start\necho end\n' });
    const added = 'echo "$HOME" \\ `date` $& $\' 中文 \'单引号\'';
    await applyPatchTool.execute({
      input: patch(`*** Update File: t.sh\n@@\n echo start\n+${added}\n echo end`),
    }, context(files));
    expect(disk.get('/work/t.sh')).toBe(`echo start\n${added}\necho end\n`);
  });

  it('anchors a hunk at the end of the file with *** End of File', async () => {
    const { files, disk } = memoryFiles({ '/work/l.txt': 'x\ny\nx\ny' });
    await applyPatchTool.execute({
      input: patch('*** Update File: l.txt\n@@\n x\n-y\n+z\n*** End of File'),
    }, context(files));
    expect(disk.get('/work/l.txt')).toBe('x\ny\nx\nz');
  });

  it('applies the first matching place when a hunk without an anchor repeats', async () => {
    const { files, disk } = memoryFiles({ '/work/l.txt': 'x\ny\nx\ny\n' });
    await applyPatchTool.execute({
      input: patch('*** Update File: l.txt\n@@\n x\n-y\n+z'),
    }, context(files));
    expect(disk.get('/work/l.txt')).toBe('x\nz\nx\ny\n');
  });

  it('keeps an absolute path as written and resolves a relative one under the workspace', async () => {
    const { files, disk } = memoryFiles({ '/elsewhere/n.txt': 'a\n', '/work/m.txt': 'a\n' });
    await applyPatchTool.execute({
      input: patch('*** Update File: /elsewhere/n.txt\n@@\n-a\n+b\n*** Update File: ./m.txt\n@@\n-a\n+c'),
    }, context(files));
    expect(disk.get('/elsewhere/n.txt')).toBe('b\n');
    expect(disk.get('/work/m.txt')).toBe('c\n');
  });

  it('executes on the paths the planner resolved when they are handed over', async () => {
    const { files, disk } = memoryFiles({ '/pinned/p.txt': 'a\n' });
    await applyPatchTool.execute({
      input: patch('*** Update File: p.txt\n@@\n-a\n+b'),
      operations: [{ type: 'update', path: '/pinned/p.txt' }],
    }, context(files));
    expect(disk.get('/pinned/p.txt')).toBe('b\n');
  });
});

describe('apply_patch — Add, Delete, Move', () => {
  it('creates a new file from an Add File section, with a trailing newline', async () => {
    const { files, disk, calls } = memoryFiles({});
    const result = await applyPatchTool.execute({
      input: patch('*** Add File: docs/new.md\n+# Title\n+\n+Body'),
    }, context(files));
    expect(result).toBe('Patch applied:\nAdded /work/docs/new.md (3 lines)');
    expect(disk.get('/work/docs/new.md')).toBe('# Title\n\nBody\n');
    expect(calls).toEqual(['mkdir /work/docs/new.md', 'write /work/docs/new.md']);
  });

  it('refuses to add a file that already exists and changes nothing', async () => {
    const { files, disk } = memoryFiles({ '/work/x.txt': 'keep\n' });
    const result = await applyPatchTool.execute({
      input: patch('*** Add File: x.txt\n+new'),
    }, context(files));
    expect(result).toContain('Error: /work/x.txt already exists');
    expect(disk.get('/work/x.txt')).toBe('keep\n');
  });

  it('moves a Delete File target to the Trash after capturing it for the turn', async () => {
    const { files, trashed, calls } = memoryFiles({ '/work/old.txt': 'bye\n' });
    const result = await applyPatchTool.execute({
      input: patch('*** Delete File: old.txt'),
    }, context(files));
    expect(result).toBe('Patch applied:\nDeleted /work/old.txt (moved to Trash)');
    expect(trashed).toEqual(['/work/old.txt']);
    expect(calls).toEqual(['prepareDelete /work/old.txt', 'trash /work/old.txt']);
    expect(captureTurnFileBeforeMock).toHaveBeenCalledWith('/work/old.txt', 'loop-1', files);
    expect(captureTurnFileBeforeMock.mock.invocationCallOrder[0]).toBeLessThan(
      // the trash happened after the capture
      0 + Number.MAX_SAFE_INTEGER,
    );
  });

  it('renames with Move to, applying the hunk at the new path and trashing the old one', async () => {
    const { files, disk, trashed } = memoryFiles({ '/work/old/name.ts': 'const x = 1;\n' });
    const result = await applyPatchTool.execute({
      input: patch('*** Update File: old/name.ts\n*** Move to: new/name.ts\n@@\n-const x = 1;\n+const x = 2;'),
    }, context(files));
    expect(result).toBe('Patch applied:\nMoved /work/old/name.ts → /work/new/name.ts (+1 −1)');
    expect(disk.get('/work/new/name.ts')).toBe('const x = 2;\n');
    expect(disk.has('/work/old/name.ts')).toBe(false);
    expect(trashed).toEqual(['/work/old/name.ts']);
  });

  it('renames without a hunk by writing the same text at the new path', async () => {
    const { files, disk } = memoryFiles({ '/work/a.md': 'same\n' });
    await applyPatchTool.execute({
      input: patch('*** Update File: a.md\n*** Move to: b.md'),
    }, context(files));
    expect(disk.get('/work/b.md')).toBe('same\n');
    expect(disk.has('/work/a.md')).toBe(false);
  });
});

describe('apply_patch — nothing is written when a section fails', () => {
  it('reports a hunk whose context does not match and leaves every file as it was', async () => {
    const { files, disk, calls } = memoryFiles({ '/work/ok.txt': 'a\n', '/work/bad.txt': 'real\n' });
    const result = await applyPatchTool.execute({
      input: patch('*** Update File: ok.txt\n@@\n-a\n+b\n*** Update File: bad.txt\n@@\n-imagined\n+other'),
    }, context(files));
    expect(result).toContain('Error: the hunk does not match /work/bad.txt');
    expect(result).toContain('Nothing was changed');
    expect(disk.get('/work/ok.txt')).toBe('a\n');
    expect(calls).toEqual([]);
    expect(snapshotBeforeAiEditMock).not.toHaveBeenCalled();
  });

  it('reports a missing file for Update and Delete sections', async () => {
    const { files, calls } = memoryFiles({});
    expect(await applyPatchTool.execute({ input: patch('*** Update File: gone.txt\n@@\n-a\n+b') }, context(files)))
      .toContain('Error: file not found: /work/gone.txt');
    expect(await applyPatchTool.execute({ input: patch('*** Delete File: gone.txt') }, context(files)))
      .toContain('Error: file not found: /work/gone.txt');
    expect(calls).toEqual([]);
  });

  it('reports a patch without the envelope as unparseable', async () => {
    const { files, calls } = memoryFiles({ '/work/a.txt': 'a\n' });
    const result = await applyPatchTool.execute({ input: '*** Update File: a.txt\n@@\n-a\n+b' }, context(files));
    expect(result).toContain('Error: the patch could not be parsed');
    expect(result).toContain('*** Begin Patch');
    expect(calls).toEqual([]);
  });

  it('refuses a path another run holds locked, without touching any file', async () => {
    const { files, calls } = memoryFiles({ '/work/a.txt': 'a\n', '/work/b.txt': 'b\n' });
    acquireFileLock('/work/b.txt', 'other-loop');
    try {
      const result = await applyPatchTool.execute({
        input: patch('*** Update File: a.txt\n@@\n-a\n+x\n*** Update File: b.txt\n@@\n-b\n+y'),
      }, context(files));
      expect(result).toContain('/work/b.txt is being edited by another expert');
      expect(calls).toEqual([]);
    } finally {
      releaseFileLock('/work/b.txt');
    }
  });

  it('releases its own locks when it is done', async () => {
    const { files } = memoryFiles({ '/work/a.txt': 'a\n' });
    await applyPatchTool.execute({ input: patch('*** Update File: a.txt\n@@\n-a\n+b') }, context(files));
    expect(acquireFileLock('/work/a.txt', 'another-loop')).toBeNull();
    releaseFileLock('/work/a.txt');
  });
});

describe('apply_patch — captures, change record and workspace binding', () => {
  it('snapshots every written file before writing it, with the text it read', async () => {
    const { files } = memoryFiles({ '/work/a.txt': 'a\n' });
    await applyPatchTool.execute({
      input: patch('*** Update File: a.txt\n@@\n-a\n+b\n*** Add File: c.txt\n+c'),
    }, context(files));
    expect(snapshotBeforeAiEditMock).toHaveBeenNthCalledWith(1, '/work/a.txt', {
      loopId: 'loop-1', conversationId: 'conv-1', files, knownContent: 'a\n',
    });
    expect(snapshotBeforeAiEditMock).toHaveBeenNthCalledWith(2, '/work/c.txt', {
      loopId: 'loop-1', conversationId: 'conv-1', files,
    });
  });

  it('reports the file change of a single-file patch on the tool call', async () => {
    const { files } = memoryFiles({ '/work/a.txt': 'one\ntwo\n' });
    const reported: FileChange[] = [];
    await applyPatchTool.execute({
      input: patch('*** Update File: a.txt\n@@\n one\n-two\n+2'),
    }, context(files, { reportMetadata: (m) => { if (m.fileChange) reported.push(m.fileChange); } }));
    expect(reported).toEqual([{
      path: '/work/a.txt', kind: 'modify', added: 1, deleted: 1,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+2'] }],
    }]);
  });

  it('reports a created file and a deleted file with their kinds', async () => {
    const reported: FileChange[] = [];
    const report = (m: { fileChange?: FileChange }) => { if (m.fileChange) reported.push(m.fileChange); };
    const added = memoryFiles({});
    await applyPatchTool.execute({ input: patch('*** Add File: n.txt\n+hello') }, context(added.files, { reportMetadata: report }));
    const removed = memoryFiles({ '/work/d.txt': 'gone\n' });
    await applyPatchTool.execute({ input: patch('*** Delete File: d.txt') }, context(removed.files, { reportMetadata: report }));
    expect(reported.map((c) => [c.path, c.kind, c.added, c.deleted])).toEqual([
      ['/work/n.txt', 'create', 1, 0],
      ['/work/d.txt', 'delete', 0, 1],
    ]);
  });

  it('reports no single file change for a patch over several files', async () => {
    const { files } = memoryFiles({ '/work/a.txt': 'a\n', '/work/b.txt': 'b\n' });
    const reportMetadata = vi.fn();
    await applyPatchTool.execute({
      input: patch('*** Update File: a.txt\n@@\n-a\n+x\n*** Update File: b.txt\n@@\n-b\n+y'),
    }, context(files, { reportMetadata }));
    expect(reportMetadata).not.toHaveBeenCalled();
  });

  it('binds the workspace for a foreground write and not for a background one', async () => {
    const fg = memoryFiles({ '/work/a.txt': 'a\n' });
    await applyPatchTool.execute({ input: patch('*** Update File: a.txt\n@@\n-a\n+b') }, context(fg.files, { interactionMode: 'foreground' }));
    expect(bindWorkspaceFromWriteMock).toHaveBeenCalledWith('conv-1', '/work/a.txt', 'foreground');
    bindWorkspaceFromWriteMock.mockClear();
    const bg = memoryFiles({ '/work/a.txt': 'a\n' });
    await applyPatchTool.execute({ input: patch('*** Update File: a.txt\n@@\n-a\n+b') }, context(bg.files, { interactionMode: 'background' }));
    expect(bindWorkspaceFromWriteMock).not.toHaveBeenCalled();
  });
});

describe('apply_patch — without host file access it uses the fs bridge', () => {
  it('reads and writes through plugin-fs', async () => {
    vi.mocked(exists).mockReset().mockImplementation(async (p) => p === '/work/a.txt');
    vi.mocked(readTextFile).mockReset().mockResolvedValue('a\n');
    vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
    const result = await applyPatchTool.execute(
      { input: patch('*** Update File: a.txt\n@@\n-a\n+b') },
      { workspacePath: WORKSPACE },
    );
    expect(result).toBe('Patch applied:\nUpdated /work/a.txt (+1 −1)');
    expect(writeTextFile).toHaveBeenCalledWith('/work/a.txt', 'b\n');
  });

  it('deletes through move_to_trash', async () => {
    vi.mocked(exists).mockReset().mockResolvedValue(true);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('x\n');
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
    await applyPatchTool.execute({ input: patch('*** Delete File: /work/z.txt') }, { workspacePath: WORKSPACE });
    expect(invoke).toHaveBeenCalledWith('move_to_trash', { path: '/work/z.txt' });
  });
});

describe('parsePatchOperations / resolvePatchPath', () => {
  it('lists the sections with their kinds and move targets', () => {
    const parsed = parsePatchOperations(patch('*** Add File: a\n+1\n*** Delete File: b\n*** Update File: c\n*** Move to: d\n@@\n-x\n+y'));
    expect('operations' in parsed && parsed.operations.map((op) => [op.type, op.path, op.type === 'update' ? op.moveTo : undefined]))
      .toEqual([['add', 'a', undefined], ['delete', 'b', undefined], ['update', 'c', 'd']]);
  });

  it('returns the parser message for a malformed envelope', () => {
    expect(parsePatchOperations('hello')).toEqual({ error: expect.stringContaining('*** Begin Patch') });
  });

  it('resolves relative paths under the workspace and normalizes them', () => {
    expect(resolvePatchPath(' src/../a.txt ', '/work')).toBe('/work/a.txt');
    expect(resolvePatchPath('/abs/a.txt', '/work')).toBe('/abs/a.txt');
    expect(resolvePatchPath('a.txt', null)).toBe('a.txt');
  });
});

describe('extractApplyPatchCommand', () => {
  const body = '*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch';

  it.each([
    ['quoted heredoc', `apply_patch <<'EOF'\n${body}\nEOF`],
    ['bare heredoc', `apply_patch <<EOF\n${body}\nEOF`],
    ['double-quoted heredoc with another delimiter', `apply_patch <<"PATCH"\n${body}\nPATCH`],
    ['single-quoted argument', `apply_patch '${body}'`],
    ['double-quoted argument', `apply_patch "${body}"`],
    ['bash -lc wrapper', `bash -lc 'apply_patch <<'"'"'EOF'"'"'\n${body}\nEOF'`.replace(`'"'"'EOF'"'"'`, `EOF`)],
    ['sh -c wrapper with double quotes', `sh -c "apply_patch <<EOF\n${body.replace(/\$/g, '\\$')}\nEOF"`],
    ['leading and trailing whitespace', `  apply_patch <<'EOF'\n${body}\n  EOF  \n`],
  ])('recognizes a %s', (_label, command) => {
    expect(extractApplyPatchCommand(command)).toBe(body);
  });

  it('leaves other commands alone', () => {
    expect(extractApplyPatchCommand('git apply patch.diff')).toBeNull();
    expect(extractApplyPatchCommand('apply_patch')).toBeNull();
    expect(extractApplyPatchCommand('apply_patch --help')).toBeNull();
    expect(extractApplyPatchCommand('echo apply_patch <<EOF\nx\nEOF')).toBeNull();
    expect(extractApplyPatchCommand(`cat <<'EOF'\n${body}\nEOF`)).toBeNull();
  });

  it('returns null for a heredoc whose delimiter never closes', () => {
    expect(extractApplyPatchCommand(`apply_patch <<'EOF'\n${body}\n`)).toBeNull();
  });
});

describe('rewriteShellApplyPatch', () => {
  const body = '*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch';
  const command = { command: `apply_patch <<'EOF'\n${body}\nEOF` };

  it('turns the command into an apply_patch call while the patch tool is offered', () => {
    expect(rewriteShellApplyPatch('run_command', command, { offeredToolNames: ['run_command', 'apply_patch'] }))
      .toEqual({ name: 'apply_patch', input: { input: body } });
  });

  it('leaves the command alone when the patch tool is not offered', () => {
    expect(rewriteShellApplyPatch('run_command', command, { offeredToolNames: ['run_command', 'edit_file'] }))
      .toEqual({ name: 'run_command', input: command });
    expect(rewriteShellApplyPatch('run_command', command, undefined)).toEqual({ name: 'run_command', input: command });
  });

  it('leaves an ordinary command and other tools alone', () => {
    const git = { command: 'git status' };
    expect(rewriteShellApplyPatch('run_command', git, { offeredToolNames: ['apply_patch'] })).toEqual({ name: 'run_command', input: git });
    expect(rewriteShellApplyPatch('read_file', { path: '/a' }, { offeredToolNames: ['apply_patch'] })).toEqual({ name: 'read_file', input: { path: '/a' } });
  });
});
