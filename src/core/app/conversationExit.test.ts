import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { prepareConversationExit } from '@/core/app/conversationExit';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { acknowledgeConversationPersistence, getConversationPersistenceRevision, useChatStore, waitForConversationPersistence } from '@/stores/chatStore';
import { loadMessages, updateIndexEntry } from '@/core/session/conversationStorage';

describe('conversation exit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    useChatStore.setState({ conversations: {} });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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

  it('leaves a history that was only loaded outside the checkpoint', async () => {
    const id = 'viewed-history';
    useChatStore.setState({ conversations: { [id]: {
      id, title: 'History', createdAt: 1, updatedAt: 1, status: 'idle',
      messages: [{ id: 'viewed-message', role: 'user', content: 'History', timestamp: 1, isStreaming: false }],
    } } });
    vi.mocked(invoke).mockClear();
    const release = await prepareConversationExit(() => {});
    release();
    expect(getConversationPersistenceRevision(id)).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls.some(([command, args]) =>
      (command === 'append_file_text' || command === 'atomic_write_text')
      && String((args as { path?: string } | undefined)?.path).includes(id),
    )).toBe(false);
  });

  it('retains modifications after the queue settles and acknowledges only the saved revision', async () => {
    const id = useChatStore.getState().createConversation();
    const first = getConversationPersistenceRevision(id)!;
    expect(first).toBeDefined();
    await waitForConversationPersistence(id);
    expect(getConversationPersistenceRevision(id)).toBe(first);
    useChatStore.getState().renameConversation(id, 'Updated title');
    const next = getConversationPersistenceRevision(id);
    expect(next).toBeDefined();
    expect(next).not.toBe(first);
    acknowledgeConversationPersistence(id, first);
    expect(getConversationPersistenceRevision(id)).toBe(next);
    const release = await prepareConversationExit(() => {});
    release();
    expect(getConversationPersistenceRevision(id)).toBeUndefined();
  });

  it.each(['raw', 'share', 'recovery'] as const)('repairs a failed %s write before acknowledging exit', async (kind) => {
    vi.useRealTimers();
    const files = new Map<string, string>();
    let failWrites = true;
    vi.mocked(exists).mockImplementation(async path => files.has(String(path)));
    vi.mocked(readTextFile).mockImplementation(async path => files.get(String(path)) ?? '');
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const { path, content, data } = args as { path?: string; content?: string; data?: string };
      if (command === 'append_file_text' || command === 'atomic_write_text') {
        if (failWrites) throw new Error('transient disk failure');
        files.set(path!, command === 'append_file_text' ? (files.get(path!) ?? '') + data : content!);
      }
    });
    const message = { id: 'repair-message', role: 'user', content: 'Preserve imported text', timestamp: 1, runState: 'running' };
    const conversation = { id: 'repair-recovery', title: 'Repair', createdAt: 1, updatedAt: 1, status: 'idle', messages: [message] };
    let id: string;
    if (kind === 'recovery') {
      id = conversation.id;
      files.set(`/Users/testuser/.abu/conversations/${id}/messages.jsonl`, JSON.stringify(message) + '\n');
      useChatStore.setState({ conversationIndex: { [id]: { ...conversation, messageCount: 1 } } });
      await useChatStore.getState().loadConversation(id);
    } else {
      id = useChatStore.getState().importConversation(JSON.stringify(kind === 'share'
        ? { schema: { abuShareVersion: 1, tier: 'standard', exportedAt: 1 }, conversation, messages: [message] }
        : conversation))!;
      expect(id).toBeTruthy();
    }
    await waitForConversationPersistence(id).catch(() => undefined);
    expect(getConversationPersistenceRevision(id)).toBeDefined();
    failWrites = false;
    const release = await prepareConversationExit(() => {});
    release();
    expect(getConversationPersistenceRevision(id)).toBeUndefined();
    const reopened = await loadMessages(id, { strictRead: true });
    expect(reopened).toHaveLength(1);
    expect(reopened[0].content).toBe(message.content);
    expect(reopened[0].runState).toBe('failed');
  });
});
