import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile, stat, writeTextFile } from '@tauri-apps/plugin-fs';
import type { ToolCall, ToolExecutionContext } from '@/types';
import type { EventRouter } from './eventRouter';
import { executeToolBatch } from './toolExecutor';
import { createInProcessToolInvoker } from './ports/toolInvoker';
import { registerBuiltinTools } from '../tools/builtins';
import { useChatStore } from '@/stores/chatStore';

const WORKSPACE = '/Users/testuser/Projects/app';

function seedAssistantMessage(): string {
  const convId = useChatStore.getState().createConversation(WORKSPACE);
  useChatStore.getState().addMessage(convId, {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
  });
  return convId;
}

async function runBatch(convId: string, toolCall: ToolCall) {
  return executeToolBatch({
    collectedToolCalls: [toolCall],
    toolCallToStepId: new Map<string, string>(),
    conversationId: convId,
    assistantMsgId: 'msg-1',
    loopId: 'loop-1',
    abortController: new AbortController(),
    eventRouter: { route: () => {} } as unknown as EventRouter,
    executionId: 'exec-1',
    unattendedApproval: undefined,
    inputValidators: new Map<string, (input: Record<string, unknown>) => boolean>(),
    confirmCb: async () => true,
    filePermCb: async () => true,
    toolContext: { conversationId: convId, loopId: 'loop-1' } as ToolExecutionContext,
    toolInvoker: createInProcessToolInvoker(),
    settingsReader: { getSnapshot: () => ({}) as never },
    continueLoop: true,
  });
}

function storedToolCall(convId: string): ToolCall | undefined {
  return useChatStore.getState().conversations[convId]?.messages
    .find((message) => message.id === 'msg-1')?.toolCalls?.[0];
}

describe('a file tool run by the renderer records its file change on the tool call', () => {
  beforeEach(() => {
    registerBuiltinTools();
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    vi.mocked(stat).mockReset().mockResolvedValue({ size: 0 } as never);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('');
    vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
  });

  it('write_file: the store holds the created file with its added lines', async () => {
    const convId = seedAssistantMessage();
    const path = `${WORKSPACE}/outline.md`;

    await runBatch(convId, { id: 'tc-write', name: 'write_file', input: { path, content: '# Title\nBody\n' }, isExecuting: true });

    const toolCall = storedToolCall(convId);
    expect(toolCall?.result).toBe(`Successfully wrote 13 characters to ${path}`);
    expect(toolCall?.isError).toBeUndefined();
    expect(toolCall?.fileChange).toEqual({
      path,
      kind: 'create',
      added: 2,
      deleted: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+# Title', '+Body'] }],
    });
  });

  it('edit_file: the store holds the modified file with its counts and hunk', async () => {
    const convId = seedAssistantMessage();
    const path = `${WORKSPACE}/plan.md`;
    vi.mocked(exists).mockImplementation(async (target) => target === path);
    vi.mocked(readTextFile).mockImplementation(async (target) => {
      if (target === path) return 'one\ntwo\nthree\n';
      throw new Error(`ENOENT: no such file or directory, open '${String(target)}'`);
    });

    await runBatch(convId, {
      id: 'tc-edit',
      name: 'edit_file',
      input: { path, old_content: 'two', new_content: '2' },
      isExecuting: true,
    });

    const toolCall = storedToolCall(convId);
    expect(toolCall?.result).toBe(`Successfully edited ${path}: replaced 1 line(s) with 1 line(s)`);
    expect(toolCall?.fileChange).toEqual({
      path,
      kind: 'modify',
      added: 1,
      deleted: 1,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-two', '+2', ' three'] }],
    });
  });
});
