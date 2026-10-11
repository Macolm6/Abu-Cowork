/**
 * A file tool the sidecar runs locally reports its file change through the
 * run's frame ChatDelta. The frames are applied to the renderer's chat store
 * the way `agent.delta` delivers them, and the run's own mirror — the copy the
 * loop checkpoints to the ledger — is updated by the same write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile, stat, writeTextFile } from '@tauri-apps/plugin-fs';
import type { ToolCall, ToolExecutionContext } from '@/types';
import type { EventRouter } from '@/core/agent/eventRouter';
import type { ToolInvoker } from '@/core/agent/ports/toolInvoker';
import { executeToolBatch } from '@/core/agent/toolExecutor';
import { createInProcessChatDelta, getChatDelta, setChatDelta } from '@/core/agent/ports/chatDelta';
import { applyDeltaFrames, type PortFrame } from '@/core/agent/frameApplier';
import { useChatStore } from '@/stores/chatStore';
import { createConversationRunMirror } from './conversationRunMirror';
import { createFrameChatDelta } from './portFrameSenders';
import { executeLocalTool } from './localTools';

const snapshotBeforeAiEditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/utils/aiEditSnapshots', () => ({
  snapshotBeforeAiEdit: (...args: unknown[]) => snapshotBeforeAiEditMock(...args),
}));

const PATH = '/Users/testuser/Projects/app/plan.md';

const localToolInvoker: ToolInvoker = {
  getAllTools: () => [],
  executeAnyTool: (name, input, _confirm, _filePermission, context, contextUsagePercent) =>
    executeLocalTool(name, input, context, contextUsagePercent),
  toolResultToString: (result) => String(result),
};

describe('a file tool run locally by the sidecar records its file change on the tool call', () => {
  beforeEach(() => {
    vi.mocked(exists).mockReset().mockResolvedValue(true);
    vi.mocked(stat).mockReset().mockResolvedValue({ size: 14 } as never);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('one\ntwo\nthree\n');
    vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
  });

  it('edit_file: the renderer store and the run mirror both hold the file change', async () => {
    const convId = useChatStore.getState().createConversation('/Users/testuser/Projects/app');
    useChatStore.getState().addMessage(convId, { id: 'msg-1', role: 'assistant', content: '', timestamp: 1 });
    const seed = structuredClone(useChatStore.getState().conversations[convId]);
    const mirror = createConversationRunMirror(convId, { conversation: seed });
    const frames: PortFrame[] = [];
    const frameChatDelta = createFrameChatDelta((frame) => frames.push(frame), mirror.applyChatDeltaWrite);
    const toolCall: ToolCall = {
      id: 'tc-edit',
      name: 'edit_file',
      input: { path: PATH, old_content: 'two', new_content: '2' },
      isExecuting: true,
    };

    const rendererChatDelta = getChatDelta();
    setChatDelta(frameChatDelta);
    try {
      await executeToolBatch({
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
        toolInvoker: localToolInvoker,
        settingsReader: { getSnapshot: () => ({}) as never },
        continueLoop: true,
      });
      await frameChatDelta.drain();
    } finally {
      setChatDelta(rendererChatDelta);
    }

    const expected = {
      path: PATH,
      kind: 'modify',
      added: 1,
      deleted: 1,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-two', '+2', ' three'] }],
    };
    const mirrored = mirror.reader.getConversation(convId)?.messages
      .find((message) => message.id === 'msg-1')?.toolCalls?.[0];
    expect(mirrored?.result).toBe(`Successfully edited ${PATH}: replaced 1 line(s) with 1 line(s)`);
    expect(mirrored?.fileChange).toEqual(expected);

    const before = useChatStore.getState().conversations[convId]?.messages
      .find((message) => message.id === 'msg-1')?.toolCalls;
    expect(before).toBeUndefined();

    setChatDelta(createInProcessChatDelta());
    await applyDeltaFrames(frames);

    const stored = useChatStore.getState().conversations[convId]?.messages
      .find((message) => message.id === 'msg-1')?.toolCalls?.[0];
    expect(stored?.result).toBe(`Successfully edited ${PATH}: replaced 1 line(s) with 1 line(s)`);
    expect(stored?.isExecuting).toBe(false);
    expect(stored?.fileChange).toEqual(expected);
  });
});
