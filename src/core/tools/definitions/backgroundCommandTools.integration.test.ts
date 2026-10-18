import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { invoke } from '@tauri-apps/api/core';
import type { ToolExecutionContext, ToolExecutionMetadata } from '../../../types';
import { resetCalibration } from '../../context/tokenEstimator';
import { useSettingsStore } from '../../../stores/settingsStore';
import { registerBuiltinTools } from '../builtins';
import { executeAnyTool } from '../registry';
import { createAuthorizationScope, disposeAuthorizationScope } from '../pathSafety';
import { runSubagentLoop } from '../../agent/subagentLoop';
import { getLanguageSetting, setLanguage } from '../../../i18n';

// 本地服务商运行开始会询问窗口；测试里不发真实请求
const { mockProbeContextWindow, mockFetch } = vi.hoisted(() => ({
  mockProbeContextWindow: vi.fn(),
  mockFetch: vi.fn(),
}));
vi.mock('../../llm/contextWindowProbe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../llm/contextWindowProbe')>()),
  probeContextWindow: mockProbeContextWindow,
}));
// Ollama 适配器真实运行，只替换网络请求
vi.mock('../../llm/tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

type Row = { id: string; command: string; status: string; exitCode: number | null };
type Table = { register: (row: { conversationId: string; command: string; cwd?: string | null }) => {
  id: string;
  attach: (process: { child: FakeProcess; stop: () => void }) => void;
} };

const requireCjs = createRequire(import.meta.url);
// 真实的主进程模块：后台命令记录表与命令分发
const commandHost = requireCjs('../../../../electron/commandHost.cjs') as {
  commandDispatch: (app: object, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  COMMAND_MISS: symbol;
  installBackgroundCommands: (table: Table) => void;
  __resetCommandHostForTests: () => void;
};
const { createBackgroundCommands } = requireCjs('../../../../electron/backgroundCommands.cjs') as {
  createBackgroundCommands: (deps: object) => Table;
};

const app = { isPackaged: false, once() {} };

/** 子进程的替身：只有 stdout、stderr 两个流和 close 事件。 */
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let table: Table;
let processes: Map<string, FakeProcess>;
let clock: number;
let shellCalls: Array<Record<string, unknown>>;

/**
 * invoke 的边界：run_shell_command 的后台方式在真实记录表里登记一条，进程用替身；
 * 其余命令交给真实的 commandDispatch。
 */
async function mainProcess(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const a = args ?? {};
  if (cmd === 'run_shell_command') {
    shellCalls.push(a);
    if (a.background !== true) throw new Error('only background commands are started in this test');
    const registration = table.register({
      conversationId: a.conversationId as string,
      command: a.command as string,
      cwd: (a.cwd as string | null) ?? null,
    });
    const child = new FakeProcess();
    registration.attach({ child, stop: () => queueMicrotask(() => child.emit('close', null)) });
    processes.set(registration.id, child);
    return { stdout: '服务已在后台启动', stderr: '', code: 0, backgroundCommandId: registration.id, running: true };
  }
  const result = await commandHost.commandDispatch(app, cmd, a);
  if (result === commandHost.COMMAND_MISS) throw new Error(`unexpected command: ${cmd}`);
  return result;
}

function list(conversationId: string): Promise<Row[]> {
  return commandHost.commandDispatch(app, 'background_command_list', { conversationId }) as Promise<Row[]>;
}

function idFrom(result: unknown): string {
  const match = /Background command id: (bg-[0-9a-f]{8})/.exec(String(result));
  if (!match) throw new Error(`no background command id in: ${String(result)}`);
  return match[1];
}

async function startInConversation(conversationId: string, command: string): Promise<string> {
  const result = await executeAnyTool(
    'run_command',
    { command, background: true },
    async () => true,
    undefined,
    { conversationId },
  );
  return idFrom(result);
}

function write(id: string, text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  processes.get(id)![stream].emit('data', Buffer.from(text, 'utf8'));
}

function context(conversationId: string, metadata?: ToolExecutionMetadata[]): ToolExecutionContext {
  return { conversationId, reportMetadata: (next) => metadata?.push(next) };
}

beforeAll(() => {
  registerBuiltinTools();
});

beforeEach(() => {
  clock = 1_000_000;
  processes = new Map();
  shellCalls = [];
  table = createBackgroundCommands({
    emit: () => {},
    now: () => clock,
    randomId: randomBytes,
    legacyEncoding: () => null,
  });
  commandHost.installBackgroundCommands(table);
  vi.mocked(invoke).mockImplementation(mainProcess as typeof invoke);
});

afterEach(() => {
  commandHost.__resetCommandHostForTests();
  vi.mocked(invoke).mockReset();
  vi.useRealTimers();
});

describe('background_command_output', () => {
  it("lists the conversation's background commands when no id is given", async () => {
    const first = await startInConversation('conv-a', 'npm run dev');
    clock += 30_000;
    const second = await startInConversation('conv-a', 'node worker.js');
    await startInConversation('conv-b', 'python serve.py');
    processes.get(second)!.emit('close', 1);
    clock += 192_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);

    const result = String(await executeAnyTool('background_command_output', {}, undefined, undefined, context('conv-a')));

    expect(result).toContain(`${first} · running · 3m42s · npm run dev`);
    expect(result).toContain(`${second} · failed (exit code 1) · 0s · node worker.js`);
    expect(result).not.toContain('python serve.py');
    expect(String(await executeAnyTool('background_command_output', {}, undefined, undefined, context('conv-empty'))))
      .toBe('No background commands in this conversation.');
  });

  it('returns the last tail_lines lines without ANSI codes', async () => {
    const id = await startInConversation('conv-a', 'npm run dev');
    write(id, '\u001b[31mred\u001b[0m\n');
    const metadata: ToolExecutionMetadata[] = [];

    const colored = String(await executeAnyTool('background_command_output', { id }, undefined, undefined, context('conv-a', metadata)));

    expect(colored).toContain('red');
    expect(colored).not.toContain('\u001b');
    expect(colored).toContain('status: running');
    expect(metadata).toEqual([{ backgroundCommand: { command: 'npm run dev' } }]);

    write(id, 'line 1\nline 2\n');
    write(id, 'line 3\n', 'stderr');
    processes.get(id)!.emit('close', 0);
    const tail = String(await executeAnyTool('background_command_output', { id, tail_lines: 2 }, undefined, undefined, context('conv-a')));

    expect(tail).toContain('status: completed');
    expect(tail).toContain('exit code: 0');
    expect(tail).toContain('output (last 2 of 4 lines):\nline 2\nline 3');
    expect(tail).not.toContain('line 1');
  });

  it('keeps only what a carriage return left on each line', async () => {
    const id = await startInConversation('conv-a', 'npm install');
    write(id, 'downloading 10%\rdownloading 50%\rdownloading 100%\r\ndone\r\n');

    const result = String(await executeAnyTool('background_command_output', { id, tail_lines: 2 }, undefined, undefined, context('conv-a')));

    expect(result).toContain('output:\ndownloading 100%\ndone');
    expect(result).not.toContain('50%');
  });

  it('writes its sentences in the interface language', async () => {
    const previous = getLanguageSetting();
    setLanguage('zh-CN');
    try {
      expect(String(await executeAnyTool('background_command_output', {}, undefined, undefined, context('conv-a'))))
        .toBe('这段对话没有后台命令。');
      const id = await startInConversation('conv-a', 'npm run dev');
      const output = String(await executeAnyTool('background_command_output', { id }, undefined, undefined, context('conv-a')));
      expect(output).toContain('status: running');
      expect(output).toContain('output: （无输出）');
      expect(String(await executeAnyTool('stop_background_command', { id }, undefined, undefined, context('conv-a'))))
        .toBe(`已请求停止后台命令 ${id}（npm run dev）。`);
    } finally {
      setLanguage(previous);
    }
  });

  it('says so when the command printed nothing', async () => {
    const id = await startInConversation('conv-a', 'npm run dev');

    const result = String(await executeAnyTool('background_command_output', { id }, undefined, undefined, context('conv-a')));

    expect(result).toContain('(no output)');
  });

  it('cannot read a command of another conversation', async () => {
    const id = await startInConversation('conv-a', 'npm run dev');

    const metadata: ToolExecutionMetadata[] = [];

    // 主进程抛出的错误由工具注册表变成工具错误结果
    expect(await executeAnyTool('background_command_output', { id }, undefined, undefined, context('conv-b', metadata)))
      .toBe(`Error executing tool "background_command_output": background command ${id} does not belong to conversation conv-b`);
    expect(await executeAnyTool('stop_background_command', { id }, undefined, undefined, context('conv-b', metadata)))
      .toBe(`Error executing tool "stop_background_command": background command ${id} does not belong to conversation conv-b`);
    expect(metadata).toEqual([]);
    expect((await list('conv-a'))[0].status).toBe('running');
  });
});

describe('stop_background_command', () => {
  it('stops a command and reports it', async () => {
    const id = await startInConversation('conv-a', 'npm run dev');
    const metadata: ToolExecutionMetadata[] = [];

    const stopped = String(await executeAnyTool('stop_background_command', { id }, undefined, undefined, context('conv-a', metadata)));

    expect(stopped).toBe(`Stop requested for background command ${id} (npm run dev).`);
    expect(metadata).toEqual([{ backgroundCommand: { command: 'npm run dev' } }]);
    await Promise.resolve();
    expect((await list('conv-a'))[0].status).toBe('stopped');

    const again = String(await executeAnyTool('stop_background_command', { id }, undefined, undefined, context('conv-a')));
    expect(again).toBe(`Background command ${id} (npm run dev) had already finished: stopped.`);
  });

  it('reports the exit code of a command that already finished', async () => {
    const id = await startInConversation('conv-a', 'npm test');
    processes.get(id)!.emit('close', 2);

    const result = String(await executeAnyTool('stop_background_command', { id }, undefined, undefined, context('conv-a')));

    expect(result).toBe(`Background command ${id} (npm test) had already finished: failed (exit code 2).`);
  });
});

describe('who owns a background command', () => {
  const originalSettings = useSettingsStore.getState();

  beforeEach(() => {
    mockProbeContextWindow.mockReset();
    mockProbeContextWindow.mockResolvedValue(undefined);
    mockFetch.mockReset();
    resetCalibration();
    useSettingsStore.setState({
      activeModel: { providerId: 'ollama', modelId: 'llama3.2' },
      providers: originalSettings.providers.map((p) =>
        p.id === 'ollama'
          ? { ...p, enabled: true, models: [...p.models.filter((m) => m.id !== 'llama3.2'), { id: 'llama3.2', label: 'llama3.2', contextWindow: 65536 }] }
          : p),
    });
  });

  afterEach(() => {
    useSettingsStore.setState({ activeModel: originalSettings.activeModel, providers: originalSettings.providers });
  });

  it("attributes an expert's background command to the parent conversation", async () => {
    const call = { name: 'run_command', arguments: { command: 'npm run dev', background: true } };
    mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
      if (!url.endsWith('/api/chat')) throw new Error(`unexpected request: ${url}`);
      const body = JSON.parse(init.body) as { messages: Array<{ role: string }> };
      const content = body.messages.some((message) => message.role === 'tool')
        ? 'started'
        : `<tool_call>${JSON.stringify(call)}</tool_call>`;
      return new Response([
        JSON.stringify({ model: 'llama3.2', message: { role: 'assistant', content } }),
        JSON.stringify({ model: 'llama3.2', done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }),
      ].join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const agent = { name: 'builder', description: 'builds', systemPrompt: 'build', tools: ['run_command'], filePath: '__preset__' };

    const result = await runSubagentLoop({
      agent,
      task: 'start the dev server',
      parentConversationId: 'parent',
      commandConfirmCallback: async () => true,
    });

    expect(result.stopReason).toBe('completed');
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0].conversationId).toBe('parent');
    const rows = await list('parent');
    expect(rows.map((row) => [row.command, row.status])).toEqual([['npm run dev', 'running']]);

    // 上级对话里的阿布能读取和停止它
    const output = String(await executeAnyTool('background_command_output', {}, undefined, undefined, context('parent')));
    expect(output).toContain(`${rows[0].id} · running`);
    const stopped = String(await executeAnyTool('stop_background_command', { id: rows[0].id }, undefined, undefined, context('parent')));
    expect(stopped).toBe(`Stop requested for background command ${rows[0].id} (npm run dev).`);
  });

  it('still denies background mode in unattended runs', async () => {
    const scopeId = createAuthorizationScope();
    try {
      const unattended: ToolExecutionContext = { conversationId: 'conv-a', authorizationScopeId: scopeId, interactionMode: 'background' };

      const result = String(await executeAnyTool('run_command', { command: 'npm run dev', background: true }, async () => true, undefined, unattended));

      expect(result).toContain('background commands are not allowed');
      expect(shellCalls).toHaveLength(0);
      expect(await list('conv-a')).toEqual([]);
      expect(String(await executeAnyTool('background_command_output', {}, undefined, undefined, unattended)))
        .toBe('No background commands in this conversation.');
    } finally {
      disposeAuthorizationScope(scopeId);
    }
  });
});
