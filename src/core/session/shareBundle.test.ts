import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation, Message } from '@/types';
import type { SnapshotEntry } from './outputSnapshots';

// Hoist mocks so the module-under-test sees them at import time.
const mockListSnapshots = vi.fn<(convId: string) => Promise<SnapshotEntry[]>>();
const mockReadSnapshotBytes = vi.fn<(convId: string, rel: string) => Promise<Uint8Array | null>>();
const mockReadFile = vi.fn<(path: string) => Promise<Uint8Array>>();

vi.mock('./outputSnapshots', async () => {
  const actual = await vi.importActual<typeof import('./outputSnapshots')>('./outputSnapshots');
  return {
    ...actual,
    listSnapshots: (convId: string) => mockListSnapshots(convId),
    readSnapshotBytes: (convId: string, rel: string) => mockReadSnapshotBytes(convId, rel),
  };
});

vi.mock('@tauri-apps/plugin-fs', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/plugin-fs')>('@tauri-apps/plugin-fs');
  return {
    ...actual,
    readFile: (path: string) => mockReadFile(path),
  };
});

import { buildShareBundle, SHARE_SCHEMA_VERSION } from './shareBundle';
import { createCompactBoundaryMarker } from '@/core/context/compactBoundary';
import { createMaxTurnsNoticeMessage } from '@/core/agent/maxTurnsNotice';
import { createBrowserRunReportMessage } from '@/core/observability/browserRunReport';
import { snapshotExecutionSteps } from '@/core/agent/executionSnapshot';
import type { ExecutionStep } from '@/types/execution';

function makeConv(messages: Message[], overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-abc',
    title: 'Test Conversation',
    messages,
    createdAt: 1_000_000,
    updatedAt: 2_000_000,
    status: 'idle',
    // Fields that MUST NOT leak into the bundle:
    workspacePath: '/Users/alice/projects/secret',
    scheduledTaskId: 'task-123',
    triggerId: 'trig-456',
    projectId: 'proj-789',
    imChannelId: 'chan-xyz',
    imPlatform: 'dchat',
    activeSkills: ['skill-a'],
    enabledMCPServers: ['mcp-1'],
    ...overrides,
  };
}

function snapshot(over: Partial<SnapshotEntry>): SnapshotEntry {
  return {
    originalPath: '/Users/alice/file.png',
    basename: 'file.png',
    snapshotRelPath: 'files/abc/file.png',
    size: 10,
    originalMtime: 0,
    snapshottedAt: 0,
    source: 'tool-output',
    refId: 'r1',
    refKind: 'image',
    ...over,
  };
}

beforeEach(() => {
  mockListSnapshots.mockReset();
  mockReadSnapshotBytes.mockReset();
  mockReadFile.mockReset();
  // Safe defaults — individual tests override as needed.
  mockListSnapshots.mockResolvedValue([]);
  mockReadSnapshotBytes.mockResolvedValue(null);
  mockReadFile.mockRejectedValue(new Error('not mocked'));
});

describe('buildShareBundle', () => {
  it('emits the current schema version and Standard tier by default', async () => {
    const conv = makeConv([{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.schema.abuShareVersion).toBe(SHARE_SCHEMA_VERSION);
    expect(bundle.schema.tier).toBe('standard');
    expect(bundle.schema.exportedAt).toBeGreaterThan(0);
  });

  it('only keeps id/title/createdAt/updatedAt on bundle.conversation (strips external refs)', async () => {
    const conv = makeConv([]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.conversation).toEqual({
      id: 'conv-abc',
      title: 'Test Conversation',
      createdAt: 1_000_000,
      updatedAt: 2_000_000,
    });
    // Serialized form must not contain any of the stripped refs anywhere.
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('task-123');
    expect(serialized).not.toContain('trig-456');
    expect(serialized).not.toContain('proj-789');
    expect(serialized).not.toContain('chan-xyz');
    expect(serialized).not.toContain('skill-a');
    expect(serialized).not.toContain('mcp-1');
  });

  it('redacts credentials inside message text and reports count', async () => {
    const conv = makeConv([
      {
        id: 'm1',
        role: 'user',
        content: 'my key sk-ant-abcdefghijklmnopqrstuvwxyz123456 pls',
        timestamp: 1,
      },
    ]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.stats.redactionCount).toBeGreaterThan(0);
    expect(JSON.stringify(bundle)).not.toContain('sk-ant-abc');
    expect(JSON.stringify(bundle)).toContain('[REDACTED:anthropic-key]');
  });

  it('redacts the command a background-command tool call recorded', async () => {
    const conv = makeConv([
      {
        id: 'm1',
        role: 'assistant',
        content: 'stopped',
        timestamp: 1,
        toolCalls: [{
          id: 't1',
          name: 'stop_background_command',
          input: { id: 'bg-0a1b2c3d' },
          result: 'Stop requested',
          backgroundCommand: { command: 'API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456 npm run dev' },
        }],
      },
    ]);

    const bundle = await buildShareBundle(conv);

    expect(bundle.messages[0].toolCalls?.[0].backgroundCommand?.command).toContain('[REDACTED:anthropic-key]');
    expect(JSON.stringify(bundle)).not.toContain('sk-ant-abc');
    expect(conv.messages[0].toolCalls?.[0].backgroundCommand?.command).toContain('sk-ant-abc');
  });

  it('drops the outcome records of a call whose result text was redacted', async () => {
    const secretResult = 'Exit code: 1\nstdout:\nKEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456\n';
    const conv = makeConv([
      {
        id: 'm1',
        role: 'assistant',
        content: 'ran',
        timestamp: 1,
        toolCalls: [
          {
            id: 't1',
            name: 'run_command',
            input: { command: 'cat .env' },
            result: secretResult,
            commandOutcome: { exitCode: 1, stdout: [21, 63] },
          },
          {
            id: 't2',
            name: 'read_file',
            input: { path: '/w/.env' },
            result: secretResult,
            fileReadOutcome: { kind: 'text', startLine: 1, lineCount: 3, totalLines: 3, bodyStart: 0 },
          },
          {
            id: 't3',
            name: 'http_fetch',
            input: { url: 'http://127.0.0.1/env' },
            result: secretResult,
            httpFetchOutcome: { status: 200, statusText: 'OK', body: [21, 63], truncated: false },
          },
        ],
      },
    ]);

    const bundle = await buildShareBundle(conv);
    const calls = bundle.messages[0].toolCalls ?? [];

    expect(calls[0].result).toContain('[REDACTED:anthropic-key]');
    expect(calls[0]).not.toHaveProperty('commandOutcome');
    expect(calls[1]).not.toHaveProperty('fileReadOutcome');
    expect(calls[2]).not.toHaveProperty('httpFetchOutcome');
    expect(conv.messages[0].toolCalls?.[0].commandOutcome).toEqual({ exitCode: 1, stdout: [21, 63] });
  });

  it('keeps the outcome records when nothing was redacted', async () => {
    const commandOutcome = { exitCode: 0, stdout: [21, 27] as [number, number] };
    const fileReadOutcome = { kind: 'text' as const, startLine: 1, lineCount: 1, totalLines: 1, bodyStart: 0 };
    const httpFetchOutcome = { status: 404, statusText: 'Not Found', body: [20, 25] as [number, number], truncated: false };
    const conv = makeConv([
      {
        id: 'm1',
        role: 'assistant',
        content: 'ran',
        timestamp: 1,
        toolCalls: [
          { id: 't1', name: 'run_command', input: { command: 'echo hello' }, result: 'Exit code: 0\nstdout:\nhello\n', commandOutcome },
          { id: 't2', name: 'read_file', input: { path: '/w/a.txt' }, result: 'hello', fileReadOutcome },
          { id: 't3', name: 'http_fetch', input: { url: 'http://127.0.0.1/x' }, result: 'HTTP 404 Not Found\n\nhello', httpFetchOutcome },
        ],
      },
    ]);

    const bundle = await buildShareBundle(conv);
    const calls = bundle.messages[0].toolCalls ?? [];

    expect(calls[0].commandOutcome).toEqual(commandOutcome);
    expect(calls[1].fileReadOutcome).toEqual(fileReadOutcome);
    expect(calls[2].httpFetchOutcome).toEqual(httpFetchOutcome);
  });

  describe('a result over the offload threshold', () => {
    // The stored result keeps only a preview; the whole text the views read is in toolCallsForContext.
    const preview = 'Exit code: 0\nstdout:\n' + 'a'.repeat(200);
    const commandOutcome = { exitCode: 0, stdout: [21, 9021] as [number, number] };

    function offloadedConv(wholeText: string): Conversation {
      return makeConv([
        {
          id: 'm1',
          role: 'assistant',
          content: 'ran',
          timestamp: 1,
          toolCalls: [
            { id: 't1', name: 'run_command', input: { command: 'cat .env' }, result: preview, commandOutcome },
          ],
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'done',
          timestamp: 2,
          toolCallsForContext: [
            { id: 't1', name: 'run_command', input: { command: 'cat .env' }, result: wholeText },
          ],
        },
      ]);
    }

    it('drops the outcome records when the secret sits after the preview', async () => {
      const wholeText = 'Exit code: 0\nstdout:\n' + 'a'.repeat(4000)
        + 'KEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456\n' + 'b'.repeat(5000);
      expect(wholeText.length).toBeGreaterThan(8192);

      const bundle = await buildShareBundle(offloadedConv(wholeText));

      expect(bundle.messages[0].toolCalls?.[0].result).toBe(preview);
      expect(bundle.messages[1].toolCallsForContext?.[0].result).toContain('[REDACTED:anthropic-key]');
      expect(bundle.messages[0].toolCalls?.[0]).not.toHaveProperty('commandOutcome');
    });

    it('keeps the outcome records when neither text was redacted', async () => {
      const wholeText = 'Exit code: 0\nstdout:\n' + 'a'.repeat(9000);

      const bundle = await buildShareBundle(offloadedConv(wholeText));

      expect(bundle.messages[0].toolCalls?.[0].commandOutcome).toEqual(commandOutcome);
    });
  });

  describe('fields without a rule of their own', () => {
    const KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';

    it('redacts the step snapshot a restored conversation shows, nested steps included', async () => {
      const conv = makeConv([{
        id: 'm1',
        role: 'assistant',
        content: 'done',
        timestamp: 1,
        executionSteps: [{
          id: 's1', type: 'command', label: 'Run cat /Users/alice/.env', status: 'completed', toolName: 'run_command',
          completionMessage: `read ${KEY}`,
          detailBlocks: [{ id: 's1-result', title: 'Result', type: 'result', content: `API_KEY=${KEY}` }],
          childSteps: [{
            id: 'c1', type: 'command', label: 'Run env', status: 'completed', toolName: 'run_command',
            detailBlocks: [{ id: 'c1-result', title: 'Result', type: 'result', content: `TOKEN=${KEY}` }],
          }],
        }],
        plannedSteps: [{ index: 0, description: `Use ${KEY} to call the API`, status: 'completed' }],
      }]);

      const bundle = await buildShareBundle(conv);
      const json = JSON.stringify(bundle.messages);

      expect(json).not.toContain('sk-ant-abc');
      expect(json).not.toContain('/Users/alice');
      expect(bundle.messages[0].executionSteps?.[0].detailBlocks?.[0].content).toBe('API_KEY=[REDACTED:anthropic-key]');
      expect(bundle.messages[0].executionSteps?.[0].childSteps?.[0].detailBlocks?.[0].content).toBe('TOKEN=[REDACTED:anthropic-key]');
      expect(bundle.stats.redactionCount).toBe(5);
      expect(conv.messages[0].executionSteps?.[0].detailBlocks?.[0].content).toContain('sk-ant-abc');
    });

    it('redacts the text blocks of a tool result and what an interface or the user added to a tool call', async () => {
      const conv = makeConv([{
        id: 'm1',
        role: 'assistant',
        content: 'done',
        timestamp: 1,
        toolCalls: [{
          id: 't1',
          name: 'read_file',
          input: { path: 'config.txt' },
          result: 'read',
          resultContent: [{ type: 'text', text: `key=${KEY}` }],
          modelContext: `context ${KEY}`,
        }],
      }]);

      const bundle = await buildShareBundle(conv);

      expect(JSON.stringify(bundle.messages)).not.toContain('sk-ant-abc');
      expect(bundle.messages[0].toolCalls?.[0].resultContent?.[0]).toEqual({ type: 'text', text: 'key=[REDACTED:anthropic-key]' });
      expect(bundle.stats.redactionCount).toBe(2);
    });

    it('redacts a key inside the content of a very long file the agent wrote', async () => {
      const content = `${'row,value\n'.repeat(20_000)}API_KEY=${KEY}\n`;
      const conv = makeConv([{
        id: 'm1',
        role: 'assistant',
        content: 'written',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'data.csv', content }, result: 'ok' }],
      }]);

      const bundle = await buildShareBundle(conv);
      const written = bundle.messages[0].toolCalls?.[0].input.content as string;

      expect(written).not.toContain('sk-ant-abc');
      expect(written.endsWith('API_KEY=[REDACTED:anthropic-key]\n')).toBe(true);
      expect(bundle.stats.redactionCount).toBe(1);
    });

    describe('a step snapshot cut through a key or a path', () => {
      function stepWithResult(result: string): ExecutionStep {
        return {
          id: 's1', executionId: 'e1', toolCallId: 't1', type: 'command', label: 'Run', status: 'completed',
          toolName: 'run_command', toolInput: {}, source: 'agent',
          detailBlocks: [{
            id: 's1-result', stepId: 's1', type: 'result', label: 'Result', labelKey: 'result',
            content: result, isTruncated: false, isExpanded: false,
          }],
        };
      }

      async function exportedSnapshotText(result: string): Promise<string | undefined> {
        const conv = makeConv([{
          id: 'm1', role: 'assistant', content: 'done', timestamp: 1,
          executionSteps: snapshotExecutionSteps([stepWithResult(result)]),
        }]);
        const bundle = await buildShareBundle(conv);
        return bundle.messages[0].executionSteps?.[0].detailBlocks?.[0].content;
      }

      it('drops the half of a key the cut left, which no rule can recognize', async () => {
        const content = await exportedSnapshotText(`${'x '.repeat(231)}AIza${'Q'.repeat(35)} tail`);

        expect(content).not.toContain('AIza');
        expect(content?.endsWith('...')).toBe(true);
        expect(content).toContain('x x x');
      });

      it('drops a home path the cut stopped inside, user name and all', async () => {
        const content = await exportedSnapshotText(`${'y '.repeat(244)}open /Users/alice`);

        expect(content).not.toContain('/Users');
        expect(content).toContain('open');
      });

      it('keeps the end of a block the snapshot did not cut', async () => {
        expect(await exportedSnapshotText('exit code: 0')).toBe('exit code: 0');
      });
    });

    it('leaves image data as it is, even where its base64 happens to look like a key', async () => {
      const data = `iVBOR${'AIza'}${'B'.repeat(35)}xyz`;
      const conv = makeConv([{
        id: 'm1',
        role: 'assistant',
        content: 'shot',
        timestamp: 1,
        toolCalls: [{
          id: 't1',
          name: 'computer',
          input: { action: 'screenshot' },
          result: 'Screenshot taken',
          resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
        }],
        toolCallsForContext: [{
          id: 't1',
          name: 'computer',
          input: { action: 'screenshot' },
          result: 'Screenshot taken',
          resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
        }],
      }]);

      const bundle = await buildShareBundle(conv);
      const block = bundle.messages[0].toolCalls?.[0].resultContent?.[0];
      const contextBlock = bundle.messages[0].toolCallsForContext?.[0].resultContent?.[0];

      expect(block?.type === 'image' && block.source.data).toBe(data);
      expect(contextBlock?.type === 'image' && contextBlock.source.data).toBe(data);
      expect(bundle.stats.redactionCount).toBe(0);
    });
  });

  describe('tool call file change', () => {
    function fileChangeConv(fileChange: NonNullable<NonNullable<Message['toolCalls']>[number]['fileChange']>): Conversation {
      return makeConv([
        {
          id: 'm1',
          role: 'assistant',
          content: 'edited',
          timestamp: 1,
          toolCalls: [{ id: 't1', name: 'edit_file', input: { path: fileChange.path }, result: 'Successfully edited', fileChange }],
        },
      ]);
    }

    it('redacts the path and drops the hunks that hold a credential', async () => {
      const conv = fileChangeConv({
        path: '/Users/alice/projects/secret/config.ts',
        kind: 'modify',
        added: 1,
        deleted: 1,
        hunks: [{
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            ' import x from "./x";',
            '-const key = "old";',
            '+const key = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";',
          ],
        }],
      });

      const bundle = await buildShareBundle(conv);
      const fileChange = bundle.messages[0].toolCalls?.[0].fileChange;

      expect(fileChange?.path).toBe(bundle.messages[0].toolCalls?.[0].input.path);
      expect(fileChange?.path).not.toContain('alice');
      expect(fileChange).toEqual({ path: fileChange?.path, kind: 'modify', added: 1, deleted: 1, cut: true });
      expect(JSON.stringify(bundle)).not.toContain('sk-ant-abc');
      expect(bundle.stats.redactionCount).toBeGreaterThan(0);
      expect(conv.messages[0].toolCalls?.[0].fileChange?.hunks).toHaveLength(1);
    });

    it('drops the hunks that hold a private key spread over several lines', async () => {
      const keyBody = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
      const conv = fileChangeConv({
        path: '/work/deploy/id_rsa',
        kind: 'create',
        added: 4,
        deleted: 0,
        hunks: [{
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 4,
          lines: [
            '+-----BEGIN RSA PRIVATE KEY-----',
            `+${keyBody}`,
            `+${keyBody.split('').reverse().join('')}`,
            '+-----END RSA PRIVATE KEY-----',
          ],
        }],
      });

      const bundle = await buildShareBundle(conv);
      const fileChange = bundle.messages[0].toolCalls?.[0].fileChange;

      expect(fileChange).toEqual({ path: '/work/deploy/id_rsa', kind: 'create', added: 4, deleted: 0, cut: true });
      expect(JSON.stringify(bundle)).not.toContain(keyBody);
      expect(bundle.stats.redactionCount).toBeGreaterThan(0);
    });

    it('drops the hunks of a change whose lines were shortened', async () => {
      // A credential cut short by the line limit no longer has the shape a rule matches.
      const shortened = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw';
      const conv = fileChangeConv({
        path: '/work/session.txt',
        kind: 'modify',
        added: 1,
        deleted: 0,
        cut: true,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' token:', `+${shortened}`] }],
      });

      const bundle = await buildShareBundle(conv);
      const fileChange = bundle.messages[0].toolCalls?.[0].fileChange;

      expect(fileChange).toEqual({ path: '/work/session.txt', kind: 'modify', added: 1, deleted: 0, cut: true });
      expect(JSON.stringify(bundle)).not.toContain(shortened);
    });

    it('keeps the hunks of a change without sensitive text', async () => {
      const hunks = [{
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [' # Notes', '-first draft', '+second draft'],
      }];
      const conv = fileChangeConv({ path: '/work/notes.md', kind: 'modify', added: 1, deleted: 1, hunks });

      const bundle = await buildShareBundle(conv);

      expect(bundle.messages[0].toolCalls?.[0].fileChange).toEqual({
        path: '/work/notes.md',
        kind: 'modify',
        added: 1,
        deleted: 1,
        hunks,
      });
    });
  });

  it('allowlists and redacts provider error details before sharing', async () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';
    const conv = makeConv([
      {
        id: 'failed-valid',
        role: 'user',
        content: 'fixed fixture input',
        timestamp: 1,
        runState: 'failed',
        runError: `provider echoed ${secret}`,
        runErrorDetails: {
          status: 403,
          error_type: `governance.${secret}`,
          traceId: secret,
          summary: `provider echoed ${secret}`,
        },
      },
      {
        id: 'failed-malformed',
        role: 'user',
        content: 'fixed fixture input',
        timestamp: 2,
        runState: 'failed',
        runErrorDetails: {
          status: 403,
          rawBody: `private prompt and ${secret}`,
        } as never,
      },
      {
        id: 'failed-legacy-raw-error',
        role: 'user',
        content: 'fixed fixture input',
        timestamp: 3,
        runState: 'failed',
        runError: '{"private":"legacy provider body without a credential pattern"}',
      },
      {
        id: 'completed-with-stale-error',
        role: 'user',
        content: 'fixed fixture input',
        timestamp: 4,
        runState: 'completed',
        runError: 'must not survive a completed row',
        runErrorDetails: { status: 403 },
      },
    ]);

    const bundle = await buildShareBundle(conv);
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('rawBody');
    expect(serialized).not.toContain('legacy provider body without a credential pattern');
    expect(bundle.messages[0].runError).toContain('[REDACTED:anthropic-key]');
    expect(bundle.messages[0].runErrorDetails?.error_type).toContain('[REDACTED:anthropic-key]');
    expect(bundle.messages[0].runErrorDetails?.traceId).toContain('[REDACTED:anthropic-key]');
    expect(bundle.messages[0].runErrorDetails?.summary).toContain('[REDACTED:anthropic-key]');
    expect(bundle.messages[1].runErrorDetails).toBeUndefined();
    expect(bundle.messages[2].runError).toBe('Provider request failed');
    expect(bundle.messages[3].runError).toBeUndefined();
    expect(bundle.messages[3].runErrorDetails).toBeUndefined();
    expect(bundle.stats.redactionCount).toBeGreaterThanOrEqual(4);
  });

  it('clears isStreaming flags and tool-call execution state', async () => {
    const conv = makeConv([
      {
        id: 'm1',
        role: 'assistant',
        content: 'working',
        timestamp: 1,
        isStreaming: true,
        toolCalls: [
          { id: 't1', name: 'run_command', input: { cmd: 'ls' }, result: '', isExecuting: true },
        ],
      },
    ]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.messages[0].isStreaming).toBe(false);
    expect(bundle.messages[0].toolCalls?.[0].isExecuting).toBe(false);
  });

  it('drops system-injected messages (isSystem=true) to match in-app visibility', async () => {
    const conv = makeConv([
      { id: 'real-1', role: 'user', content: 'real question', timestamp: 1 },
      // Mimics App.tsx's orphan-checkpoint recovery notice that piles up
      // across crash/restart cycles and must not leak to recipients.
      {
        id: 'sys-1',
        role: 'assistant',
        content: '⚠️ 上次对话在第 2 轮等待模型响应时中断。你可以继续发送消息恢复工作。',
        timestamp: 2,
        isSystem: true,
      },
      {
        id: 'sys-2',
        role: 'assistant',
        content: '⚠️ 上次对话在第 2 轮等待模型响应时中断。你可以继续发送消息恢复工作。',
        timestamp: 3,
        isSystem: true,
      },
      { id: 'real-2', role: 'assistant', content: 'real answer', timestamp: 4 },
    ]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.messages).toHaveLength(2);
    expect(bundle.messages.map((m) => m.id)).toEqual(['real-1', 'real-2']);
    expect(JSON.stringify(bundle)).not.toContain('上次对话在第');
  });

  it('drops compact-boundary markers and never leaks their un-redacted summaryText', async () => {
    const marker = createCompactBoundaryMarker({
      summaryText: 'SENTINEL_SUMMARY_do_not_leak_this_verbatim',
      summarizedFromId: 'real-1',
      summarizedToId: 'real-1',
      source: 'manual',
      timestamp: 3,
    });
    const conv = makeConv([
      { id: 'real-1', role: 'user', content: 'real question', timestamp: 1 },
      marker,
      { id: 'real-2', role: 'assistant', content: 'real answer', timestamp: 4 },
    ]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.messages).toHaveLength(2);
    expect(bundle.messages.map((m) => m.id)).toEqual(['real-1', 'real-2']);
    expect(JSON.stringify(bundle)).not.toContain('SENTINEL_SUMMARY_do_not_leak_this_verbatim');
  });

  it('drops turn-cap notices so an export has no blank bubble where a card was', async () => {
    const notice = createMaxTurnsNoticeMessage({
      id: 'n1',
      timestamp: 3,
      limit: 200,
      streak: 1,
    });
    const conv = makeConv([
      { id: 'real-1', role: 'user', content: 'real question', timestamp: 1 },
      notice,
      { id: 'real-2', role: 'assistant', content: 'real answer', timestamp: 4 },
    ]);

    const bundle = await buildShareBundle(conv);

    expect(bundle.messages.map((m) => m.id)).toEqual(['real-1', 'real-2']);
  });

  it('drops unattended run report cards and never leaks the origins they visited', async () => {
    // Same hazard as the compact-boundary marker above: the payload lives
    // outside `content`, so `redactText` never sees it — and what it holds is
    // the list of (often internal) hosts the overnight run visited.
    const card = createBrowserRunReportMessage({
      id: 'card-1',
      timestamp: 3,
      report: {
        v: 1,
        outcome: 'completed',
        actions: { total: 1, failed: 0 },
        sites: [{ origin: 'https://SENTINEL-intranet.internal', actions: 1, failures: 0 }],
        denials: [],
        problems: [],
        approvals: { approved: 0, declined: 0, timedOut: 0, unreachable: 0 },
        blockedPages: 0,
        skippedByMasterSwitch: false,
        nextSteps: [],
        omitted: { sites: 0, problems: 0 },
      },
    });
    const conv = makeConv([
      { id: 'real-1', role: 'user', content: 'real question', timestamp: 1 },
      card,
      { id: 'real-2', role: 'assistant', content: 'real answer', timestamp: 4 },
    ]);

    const bundle = await buildShareBundle(conv);

    expect(bundle.messages.map((m) => m.id)).toEqual(['real-1', 'real-2']);
    expect(JSON.stringify(bundle)).not.toContain('SENTINEL-intranet.internal');
  });

  it('does not mutate the source conversation object', async () => {
    const conv = makeConv([
      {
        id: 'm1',
        role: 'assistant',
        content: 'x',
        timestamp: 1,
        isStreaming: true,
        toolCalls: [{ id: 't1', name: 'foo', input: {}, result: 'r', isExecuting: true }],
      },
    ]);
    await buildShareBundle(conv);
    expect(conv.messages[0].isStreaming).toBe(true);
    expect(conv.messages[0].toolCalls?.[0].isExecuting).toBe(true);
  });

  describe('Standard tier — attachment classification', () => {
    // Every fixture entry carries refId 'r1': the tool call below for a tool
    // output, the user message below for an upload.
    const toolOutputOwner: Message = {
      id: 'm1',
      role: 'assistant',
      content: 'done',
      timestamp: 1,
      toolCalls: [{ id: 'r1', name: 'write_file', input: { path: '/Users/alice/out' }, result: 'ok' }],
    };
    const uploadOwner: Message = { id: 'r1', role: 'user', content: 'here', timestamp: 1 };

    it('embeds tool-output attachments as base64', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ source: 'tool-output', basename: 'report.xlsx', originalPath: '/Users/alice/report.xlsx' }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]));

      const bundle = await buildShareBundle(makeConv([toolOutputOwner]));
      const att = Object.values(bundle.attachments)[0];
      expect(att.source).toBe('tool-output');
      expect(att.data).toBeTruthy();
      expect(att.skipReason).toBeUndefined();
      expect(bundle.stats.embeddedCount).toBe(1);
    });

    it('excludes user-upload attachments from embedding', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ source: 'user-upload', basename: 'secret.pdf', originalPath: '/Users/alice/secret.pdf' }),
      ]);

      const bundle = await buildShareBundle(makeConv([uploadOwner]));
      const att = Object.values(bundle.attachments)[0];
      expect(att.data).toBeUndefined();
      expect(att.skipReason).toBe('user-upload-excluded');
      expect(bundle.stats.embeddedCount).toBe(0);
    });

    it('marks missing snapshots with skipReason=missing', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ source: 'tool-output', snapshotRelPath: 'files/x/y.pdf' }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(null);

      const bundle = await buildShareBundle(makeConv([toolOutputOwner]));
      const att = Object.values(bundle.attachments)[0];
      expect(att.skipReason).toBe('missing');
    });

    it('redacts home paths in attachment keys', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ originalPath: '/Users/alice/file.png', basename: 'file.png' }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(new Uint8Array([1]));

      const bundle = await buildShareBundle(makeConv([toolOutputOwner]));
      const keys = Object.keys(bundle.attachments);
      expect(keys[0]).toBe('~/file.png');
    });

    it('leaves out an attachment no exported message accounts for', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ source: 'tool-output', basename: 'report.xlsx', originalPath: '/Users/alice/report.xlsx' }),
        snapshot({ source: 'user-upload', basename: 'secret.pdf', originalPath: '/Users/alice/secret.pdf' }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]));

      const bundle = await buildShareBundle(makeConv([{ id: 'm2', role: 'user', content: 'hi', timestamp: 1 }]));
      expect(bundle.attachments).toEqual({});
      expect(bundle.stats.attachmentCount).toBe(0);
      expect(bundle.stats.embeddedCount).toBe(0);
    });
  });

  describe('Standard tier — ImageContent in message body', () => {
    it('strips user-uploaded images (no manifest entry defaults to user-upload)', async () => {
      const conv = makeConv([
        {
          id: 'm1',
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'OLD_DATA' },
              filePath: '/Users/alice/paste.png',
            },
          ],
          timestamp: 1,
        },
      ]);
      const bundle = await buildShareBundle(conv);
      const block = (bundle.messages[0].content as Array<{ type: string; source?: { data: string }; filePath?: string }>)[0];
      expect(block.source?.data).toBe('');
      // Path redacted.
      expect(block.filePath).toBe('~/paste.png');
    });

    it('embeds AI-generated images (manifest source=tool-output)', async () => {
      const screenshotPath = '/Users/alice/screenshot.png';
      mockListSnapshots.mockResolvedValue([
        snapshot({
          source: 'tool-output',
          originalPath: screenshotPath,
          basename: 'screenshot.png',
          snapshotRelPath: 'files/a/screenshot.png',
        }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(new Uint8Array([42, 42]));

      const conv = makeConv([
        {
          id: 'm1',
          role: 'assistant',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: '' },
              filePath: screenshotPath,
            },
          ],
          timestamp: 1,
        },
      ]);
      const bundle = await buildShareBundle(conv);
      const block = (bundle.messages[0].content as Array<{ type: string; source?: { data: string } }>)[0];
      expect(block.source?.data.length).toBeGreaterThan(0);
    });
  });

  describe('progress + cancel (#7)', () => {
    it('calls onProgress once per visible (non-system) message', async () => {
      const conv = makeConv([
        { id: 'm1', role: 'user', content: 'a', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'b', timestamp: 2 },
        { id: 'm3', role: 'user', content: 'sys', timestamp: 3, isSystem: true },
      ]);
      const seen: Array<[number, number]> = [];
      await buildShareBundle(conv, { onProgress: (d, t) => seen.push([d, t]) });
      expect(seen).toEqual([[1, 2], [2, 2]]); // m3 (system) excluded from total
    });

    it('rejects when the signal is already aborted', async () => {
      const conv = makeConv([{ id: 'm1', role: 'user', content: 'a', timestamp: 1 }]);
      const controller = new AbortController();
      controller.abort();
      await expect(buildShareBundle(conv, { signal: controller.signal })).rejects.toThrow();
    });
  });
});
