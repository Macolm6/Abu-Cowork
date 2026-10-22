import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event, type EventCallback } from '@tauri-apps/api/event';
import {
  BACKGROUND_COMMANDS_CHANGED_EVENT,
  startBackgroundCommandSync,
  useBackgroundCommandStore,
  type BackgroundCommandRow,
} from './backgroundCommandStore';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

function row(id: string, overrides: Partial<BackgroundCommandRow> = {}): BackgroundCommandRow {
  return {
    id,
    command: 'npm run dev',
    cwd: '/work',
    status: 'running',
    exitCode: null,
    startedAt: 1_000,
    finishedAt: null,
    ...overrides,
  };
}

function changedEvent(conversationId: string): Event<{ conversationId: string }> {
  return { event: BACKGROUND_COMMANDS_CHANGED_EVENT, id: 1, payload: { conversationId } };
}

/** Starts the sync and hands back the handler it registered with `listen`. */
async function startSync(): Promise<{
  stop: () => void;
  emitChanged: (conversationId: string) => void;
  unlisten: ReturnType<typeof vi.fn>;
}> {
  const unlisten = vi.fn();
  let handler: EventCallback<{ conversationId: string }> | null = null;
  listenMock.mockImplementationOnce(async (eventName, callback) => {
    expect(eventName).toBe(BACKGROUND_COMMANDS_CHANGED_EVENT);
    handler = callback as EventCallback<{ conversationId: string }>;
    return unlisten;
  });
  const stop = startBackgroundCommandSync();
  await vi.waitFor(() => expect(handler).not.toBeNull());
  return {
    stop,
    emitChanged: (conversationId) => handler!(changedEvent(conversationId)),
    unlisten,
  };
}

describe('backgroundCommandStore', () => {
  beforeEach(() => {
    useBackgroundCommandStore.setState({ rows: {} });
    invokeMock.mockReset();
    listenMock.mockClear();
  });

  describe('refresh', () => {
    it('reads the list of one conversation from the main process', async () => {
      invokeMock.mockResolvedValueOnce([row('bg-00000001')]);

      await useBackgroundCommandStore.getState().refresh('c1');

      expect(invokeMock).toHaveBeenCalledWith('background_command_list', { conversationId: 'c1' });
      expect(useBackgroundCommandStore.getState().rows).toEqual({ c1: [row('bg-00000001')] });
    });

    it('replaces the rows it held for that conversation', async () => {
      useBackgroundCommandStore.setState({
        rows: { c1: [row('bg-00000001'), row('bg-00000002')], c2: [row('bg-00000003')] },
      });
      invokeMock.mockResolvedValueOnce([row('bg-00000002', { status: 'completed', exitCode: 0, finishedAt: 2_000 })]);

      await useBackgroundCommandStore.getState().refresh('c1');

      expect(useBackgroundCommandStore.getState().rows).toEqual({
        c1: [row('bg-00000002', { status: 'completed', exitCode: 0, finishedAt: 2_000 })],
        c2: [row('bg-00000003')],
      });
    });

    it('keeps the answer of the latest request when two overlap', async () => {
      let resolveFirst: (value: BackgroundCommandRow[]) => void = () => {};
      invokeMock
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce([row('bg-00000001', { status: 'stopped', finishedAt: 3_000 })]);

      const first = useBackgroundCommandStore.getState().refresh('c1');
      await useBackgroundCommandStore.getState().refresh('c1');
      resolveFirst([row('bg-00000001')]);
      await first;

      expect(useBackgroundCommandStore.getState().rows.c1).toEqual([
        row('bg-00000001', { status: 'stopped', finishedAt: 3_000 }),
      ]);
    });

    it('rejects when the main process call fails', async () => {
      invokeMock.mockRejectedValueOnce(new Error('host unavailable'));

      await expect(useBackgroundCommandStore.getState().refresh('c1')).rejects.toThrow('host unavailable');
      expect(useBackgroundCommandStore.getState().rows).toEqual({});
    });

    it('rejects an answer that is not a list', async () => {
      invokeMock.mockResolvedValueOnce({ rows: [] });

      await expect(useBackgroundCommandStore.getState().refresh('c1')).rejects.toThrow(/background_command_list/);
    });
  });

  describe('startBackgroundCommandSync', () => {
    it('reads the list of the conversation named by a change event', async () => {
      const { stop, emitChanged } = await startSync();
      invokeMock.mockResolvedValueOnce([row('bg-0000000a')]);

      emitChanged('c7');

      await vi.waitFor(() =>
        expect(useBackgroundCommandStore.getState().rows).toEqual({ c7: [row('bg-0000000a')] }),
      );
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith('background_command_list', { conversationId: 'c7' });
      stop();
    });

    it('stops reading once unsubscribed', async () => {
      const { stop, emitChanged, unlisten } = await startSync();

      stop();
      emitChanged('c7');

      expect(unlisten).toHaveBeenCalledTimes(1);
      expect(invokeMock).not.toHaveBeenCalled();
      expect(useBackgroundCommandStore.getState().rows).toEqual({});
    });

    it('releases the listener when unsubscribed before listen resolves', async () => {
      const unlisten = vi.fn();
      let resolveListen: (fn: () => void) => void = () => {};
      listenMock.mockImplementationOnce(() => new Promise((resolve) => { resolveListen = resolve; }));

      const stop = startBackgroundCommandSync();
      stop();
      resolveListen(unlisten);

      await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    });
  });
});
