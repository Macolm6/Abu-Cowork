// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnChanges, TurnIndex } from '@/core/session/turnChanges';

const mocks = vi.hoisted(() => ({
  readTurnIndex: vi.fn(),
  readTurnChanges: vi.fn(),
  listeners: new Set<(conversationId: string, loopId: string) => void>(),
}));

vi.mock('@/core/session/turnChanges', () => ({
  readTurnIndex: (...args: unknown[]) => mocks.readTurnIndex(...args),
  readTurnChanges: (...args: unknown[]) => mocks.readTurnChanges(...args),
  onTurnChangesSaved: (listener: (conversationId: string, loopId: string) => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
}));

import { __testing, useTurnChangesDetail, useTurnChangesEntry } from './useTurnChanges';

const ENTRY = { total: 2, added: 5, deleted: 1, firstFile: 'a.md' };
const TURN: TurnChanges = {
  loopId: 'loop-1',
  files: [
    { path: '/ws/a.md', display: 'a.md', status: 'modified', added: 5, deleted: 1, hunks: [] },
    { path: '/ws/b.xlsx', display: 'b.xlsx', status: 'created' },
  ],
  total: 2,
  added: 5,
  deleted: 1,
};

function saved(conversationId: string, loopId: string): void {
  for (const listener of [...mocks.listeners]) listener(conversationId, loopId);
}

describe('useTurnChanges', () => {
  beforeEach(() => {
    __testing.reset();
    mocks.readTurnIndex.mockReset();
    mocks.readTurnChanges.mockReset();
    mocks.readTurnIndex.mockResolvedValue({ 'loop-1': ENTRY } satisfies TurnIndex);
    mocks.readTurnChanges.mockResolvedValue(TURN);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('useTurnChangesEntry', () => {
    it('is null while the index is read, then the totals of the turn', async () => {
      const { result } = renderHook(() => useTurnChangesEntry('conv-1', 'loop-1', true));
      expect(result.current).toBeNull();
      await waitFor(() => expect(result.current).toEqual(ENTRY));
    });

    it('is null for a turn the index does not list', async () => {
      const { result } = renderHook(() => useTurnChangesEntry('conv-1', 'loop-2', true));
      await waitFor(() => expect(mocks.readTurnIndex).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(result.current).toBeNull();
    });

    it('reads nothing while disabled or without a loop id', async () => {
      const disabled = renderHook(() => useTurnChangesEntry('conv-1', 'loop-1', false));
      const noLoop = renderHook(() => useTurnChangesEntry('conv-1', undefined, true));
      await act(async () => {});
      expect(mocks.readTurnIndex).not.toHaveBeenCalled();
      expect(disabled.result.current).toBeNull();
      expect(noLoop.result.current).toBeNull();
    });

    it('reads the index of a conversation once for all its turns', async () => {
      const first = renderHook(() => useTurnChangesEntry('conv-1', 'loop-1', true));
      const second = renderHook(() => useTurnChangesEntry('conv-1', 'loop-2', true));
      await waitFor(() => expect(first.result.current).toEqual(ENTRY));
      expect(second.result.current).toBeNull();
      expect(mocks.readTurnIndex).toHaveBeenCalledTimes(1);
    });

    it('reads the index again when a turn of the conversation has been saved, keeping the old totals meanwhile', async () => {
      mocks.readTurnIndex.mockResolvedValueOnce({});
      const { result } = renderHook(() => useTurnChangesEntry('conv-1', 'loop-1', true));
      await waitFor(() => expect(mocks.readTurnIndex).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(result.current).toBeNull();

      act(() => saved('conv-1', 'loop-1'));
      await waitFor(() => expect(result.current).toEqual(ENTRY));

      let release: (index: TurnIndex) => void = () => {};
      mocks.readTurnIndex.mockReturnValueOnce(new Promise<TurnIndex>((resolve) => { release = resolve; }));
      act(() => saved('conv-1', 'loop-9'));
      expect(result.current).toEqual(ENTRY);
      await act(async () => { release({ 'loop-1': { ...ENTRY, total: 3 } }); });
      expect(result.current).toEqual({ ...ENTRY, total: 3 });
    });

    it('ignores a save in another conversation', async () => {
      const { result } = renderHook(() => useTurnChangesEntry('conv-1', 'loop-1', true));
      await waitFor(() => expect(result.current).toEqual(ENTRY));
      act(() => saved('conv-2', 'loop-1'));
      await act(async () => {});
      expect(mocks.readTurnIndex).toHaveBeenCalledTimes(1);
    });

    it('is null when the index cannot be read', async () => {
      mocks.readTurnIndex.mockRejectedValue(new Error('not in the saved format'));
      const { result } = renderHook(() => useTurnChangesEntry('conv-1', 'loop-1', true));
      await waitFor(() => expect(mocks.readTurnIndex).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(result.current).toBeNull();
    });
  });

  describe('useTurnChangesDetail', () => {
    it('is loading, then ready with the saved turn', async () => {
      const { result } = renderHook(() => useTurnChangesDetail('conv-1', 'loop-1'));
      expect(result.current).toMatchObject({ status: 'loading', turn: null });
      await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', turn: TURN }));
      expect(mocks.readTurnChanges).toHaveBeenCalledExactlyOnceWith('conv-1', 'loop-1');
    });

    it('is ready with null for a turn that saved nothing', async () => {
      mocks.readTurnChanges.mockResolvedValue(null);
      const { result } = renderHook(() => useTurnChangesDetail('conv-1', 'loop-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.turn).toBeNull();
    });

    it('reads one turn once for every reader', async () => {
      const first = renderHook(() => useTurnChangesDetail('conv-1', 'loop-1'));
      const second = renderHook(() => useTurnChangesDetail('conv-1', 'loop-1'));
      await waitFor(() => expect(first.result.current.status).toBe('ready'));
      expect(second.result.current.status).toBe('ready');
      expect(mocks.readTurnChanges).toHaveBeenCalledTimes(1);
    });

    it('reads nothing while disabled', async () => {
      const { result } = renderHook(() => useTurnChangesDetail('conv-1', 'loop-1', false));
      await act(async () => {});
      expect(mocks.readTurnChanges).not.toHaveBeenCalled();
      expect(result.current.status).toBe('loading');
    });

    it('reports an error when the turn cannot be read, and reads again on reload', async () => {
      mocks.readTurnChanges.mockRejectedValueOnce(new Error('EIO'));
      const { result } = renderHook(() => useTurnChangesDetail('conv-1', 'loop-1'));
      await waitFor(() => expect(result.current.status).toBe('error'));

      act(() => result.current.reload());
      expect(result.current.status).toBe('loading');
      await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', turn: TURN }));
    });

    it('reads the turn again when it has been saved again', async () => {
      const { result } = renderHook(() => useTurnChangesDetail('conv-1', 'loop-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      mocks.readTurnChanges.mockResolvedValue({ ...TURN, total: 9 });

      act(() => saved('conv-1', 'loop-1'));

      await waitFor(() => expect(result.current.turn?.total).toBe(9));
      expect(mocks.readTurnChanges).toHaveBeenCalledTimes(2);
    });
  });
});
