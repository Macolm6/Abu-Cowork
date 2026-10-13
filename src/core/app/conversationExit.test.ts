import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { prepareConversationExit } from '@/core/app/conversationExit';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { useChatStore } from '@/stores/chatStore';
import { updateIndexEntry } from '@/core/session/conversationStorage';

describe('conversation exit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    useChatStore.setState({ conversations: {} });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('holds task admission after saving until cancellation releases it', async () => {
    let cancel!: () => void;
    const release = await prepareConversationExit(callback => { cancel = callback; });
    await expect(runAgentLoopDispatched('exit-conversation', 'request')).rejects.toThrow('application exit');
    cancel();
    release();
  });

  it('rejects an exit cancelled before saving', async () => {
    await expect(prepareConversationExit(cancel => { cancel(); })).rejects.toThrow();
    const release = await prepareConversationExit(() => {});
    release();
  });

  it('releases task admission after a real storage-boundary failure and permits a save retry', async () => {
    await updateIndexEntry({ id: 'exit-conversation', title: 'Saved conversation', createdAt: 1, updatedAt: 1, messageCount: 0 });
    const base = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args, options) => {
      if (command === 'atomic_write_text') throw new Error('disk full');
      return base?.(command, args, options);
    });
    await expect(prepareConversationExit(() => {})).rejects.toThrow('disk full');
    vi.mocked(invoke).mockImplementation(base!);
    const release = await prepareConversationExit(() => {});
    release();
  });
});
