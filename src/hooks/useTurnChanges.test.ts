// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnChanges, TurnIndex, TurnIndexEntry } from '@/core/session/turnChanges';

import type { TurnUndoPlan, TurnUndoResult } from '@/core/session/turnUndo';
import type { TurnUndoRecord } from '@/core/session/turnUndoRecord';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';

const mocks = vi.hoisted(() => ({
  readTurnIndex: vi.fn(),
  readTurnChanges: vi.fn(),
  readTurnUndoRecord: vi.fn(),
  planTurnUndo: vi.fn(),
  undoTurn: vi.fn(),
  reapplyTurn: vi.fn(),
  checkWritePath: vi.fn(),
  canonicalize: vi.fn(),
  listeners: new Set<(conversationId: string, loopId: string) => void>(),
}));

vi.mock('@/core/session/turnChanges', () => ({
  readTurnIndex: (...args: unknown[]) => mocks.readTurnIndex(...args),
  readTurnChanges: (...args: unknown[]) => mocks.readTurnChanges(...args),
  readTurnUndoRecord: (...args: unknown[]) => mocks.readTurnUndoRecord(...args),
  onTurnChangesSaved: (listener: (conversationId: string, loopId: string) => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
}));

vi.mock('@/core/session/turnUndo', () => ({
  planTurnUndo: (...args: unknown[]) => mocks.planTurnUndo(...args),
  undoTurn: (...args: unknown[]) => mocks.undoTurn(...args),
  reapplyTurn: (...args: unknown[]) => mocks.reapplyTurn(...args),
}));

vi.mock('@/core/tools/pathSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/tools/pathSafety')>()),
  checkWritePath: (...args: unknown[]) => mocks.checkWritePath(...args),
}));

vi.mock('@/utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: (...args: unknown[]) => mocks.canonicalize(...args),
}));

import {
  __testing,
  useConversationChangedFiles,
  useTurnChangesDetail,
  useTurnChangesEntry,
  useTurnUndo,
  useTurnUndoRecord,
} from './useTurnChanges';

const ENTRY: TurnIndexEntry = {
  total: 2,
  added: 5,
  deleted: 1,
  firstFile: 'a.md',
  files: [{ path: '/ws/a.md', display: 'a.md', status: 'modified' }, { path: '/ws/b.xlsx', display: 'b.xlsx', status: 'created' }],
};
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

const RECORD: TurnUndoRecord = {
  version: 1,
  loopId: 'loop-1',
  state: 'applied',
  entries: [{ path: '/ws/a.md', hash: '0123456789abcdef', before: 'absent', after: 'file', afterSha256: 'a'.repeat(64) }],
};
const PLAN: TurnUndoPlan = { willRestore: [{ path: '/ws/a.md', display: 'a.md', action: 'trash' }], wontRestore: [] };
const RESULT: TurnUndoResult = { done: 1, notDone: [] };

function saved(conversationId: string, loopId: string): void {
  for (const listener of [...mocks.listeners]) listener(conversationId, loopId);
}

function setConversations(ids: string[], workspacePath?: string): void {
  const conversations = Object.fromEntries(ids.map((id): [string, Conversation] => [
    id,
    { id, title: id, messages: [], createdAt: 1_000, updatedAt: 1_000, status: 'idle', ...(workspacePath ? { workspacePath } : {}) },
  ]));
  useChatStore.setState({ conversations });
}

describe('useTurnChanges', () => {
  beforeEach(() => {
    __testing.reset();
    mocks.readTurnIndex.mockReset();
    mocks.readTurnChanges.mockReset();
    mocks.readTurnIndex.mockResolvedValue({ 'loop-1': ENTRY } satisfies TurnIndex);
    mocks.readTurnChanges.mockResolvedValue(TURN);
    mocks.readTurnUndoRecord.mockReset();
    mocks.readTurnUndoRecord.mockResolvedValue(RECORD);
    mocks.planTurnUndo.mockReset();
    mocks.planTurnUndo.mockResolvedValue(PLAN);
    mocks.undoTurn.mockReset();
    mocks.undoTurn.mockResolvedValue(RESULT);
    mocks.reapplyTurn.mockReset();
    mocks.reapplyTurn.mockResolvedValue(RESULT);
    mocks.checkWritePath.mockReset();
    mocks.checkWritePath.mockResolvedValue({ allowed: true });
    mocks.canonicalize.mockReset();
    mocks.canonicalize.mockResolvedValue(null);
    setConversations(['conv-1']);
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

  describe('useTurnUndoRecord', () => {
    it('is null while the record is read, then the record', async () => {
      const { result } = renderHook(() => useTurnUndoRecord('conv-1', 'loop-1', true));
      expect(result.current).toBeNull();
      await waitFor(() => expect(result.current).toEqual(RECORD));
      expect(mocks.readTurnUndoRecord).toHaveBeenCalledExactlyOnceWith('conv-1', 'loop-1');
    });

    it('reads nothing while disabled', async () => {
      const { result } = renderHook(() => useTurnUndoRecord('conv-1', 'loop-1', false));
      await act(async () => {});
      expect(mocks.readTurnUndoRecord).not.toHaveBeenCalled();
      expect(result.current).toBeNull();
    });

    it('reads one record once for every reader', async () => {
      const first = renderHook(() => useTurnUndoRecord('conv-1', 'loop-1', true));
      const second = renderHook(() => useTurnUndoRecord('conv-1', 'loop-1', true));
      await waitFor(() => expect(first.result.current).toEqual(RECORD));
      expect(second.result.current).toEqual(RECORD);
      expect(mocks.readTurnUndoRecord).toHaveBeenCalledTimes(1);
    });

    it('reads the record again when the turn has been saved again, keeping the old one meanwhile', async () => {
      const { result } = renderHook(() => useTurnUndoRecord('conv-1', 'loop-1', true));
      await waitFor(() => expect(result.current).toEqual(RECORD));
      const undone: TurnUndoRecord = { ...RECORD, state: 'undone' };
      let release: (record: TurnUndoRecord) => void = () => {};
      mocks.readTurnUndoRecord.mockReturnValueOnce(new Promise<TurnUndoRecord>((resolve) => { release = resolve; }));

      act(() => saved('conv-1', 'loop-1'));
      expect(result.current).toEqual(RECORD);
      await act(async () => { release(undone); });

      expect(result.current).toEqual(undone);
    });

    it('is null for a turn that has no record', async () => {
      mocks.readTurnUndoRecord.mockResolvedValue(null);
      const { result } = renderHook(() => useTurnUndoRecord('conv-1', 'loop-1', true));
      await waitFor(() => expect(mocks.readTurnUndoRecord).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(result.current).toBeNull();
    });
  });

  describe('useTurnUndo', () => {
    it('plans for the turn and the direction asked', async () => {
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));

      await expect(result.current.plan('reapply')).resolves.toEqual(PLAN);

      expect(mocks.planTurnUndo).toHaveBeenCalledExactlyOnceWith('conv-1', 'loop-1', 'reapply', {
        authorize: expect.any(Function),
        isConversationPresent: expect.any(Function),
      });
    });

    it('plans with the write check the run uses, and asks for nothing', async () => {
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
      await result.current.plan('undo');
      const { authorize } = mocks.planTurnUndo.mock.calls[0][3] as { authorize: (path: string) => Promise<boolean> };

      mocks.checkWritePath.mockResolvedValueOnce({ allowed: true, resolvedPath: '/ws/a.md' });
      await expect(authorize('/ws/a.md')).resolves.toBe(true);
      mocks.checkWritePath.mockResolvedValueOnce({ allowed: false, needsPermission: true, permissionPath: '/elsewhere' });
      await expect(authorize('/elsewhere/a.md')).resolves.toBe(false);
      expect(mocks.checkWritePath.mock.calls).toEqual([['/ws/a.md'], ['/elsewhere/a.md']]);
    });

    it('undoes the turn and is busy until that has ended', async () => {
      let release: (result: TurnUndoResult) => void = () => {};
      mocks.undoTurn.mockReturnValue(new Promise<TurnUndoResult>((resolve) => { release = resolve; }));
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
      expect(result.current.busy).toBe(false);

      let running: Promise<TurnUndoResult | null> = Promise.resolve(null);
      act(() => { running = result.current.run('undo'); });
      expect(result.current.busy).toBe(true);
      expect(mocks.undoTurn).toHaveBeenCalledExactlyOnceWith('conv-1', 'loop-1', {
        authorize: expect.any(Function),
        isConversationPresent: expect.any(Function),
      });
      expect(mocks.reapplyTurn).not.toHaveBeenCalled();

      await act(async () => { release(RESULT); });
      await expect(running).resolves.toEqual(RESULT);
      expect(result.current.busy).toBe(false);
    });

    it('puts the changes back through reapplyTurn', async () => {
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
      let outcome: TurnUndoResult | null = null;
      await act(async () => { outcome = await result.current.run('reapply'); });
      expect(outcome).toEqual(RESULT);
      expect(mocks.reapplyTurn).toHaveBeenCalledTimes(1);
      expect(mocks.undoTurn).not.toHaveBeenCalled();
    });

    it('starts no second run while one is going', async () => {
      let release: (result: TurnUndoResult) => void = () => {};
      mocks.undoTurn.mockReturnValue(new Promise<TurnUndoResult>((resolve) => { release = resolve; }));
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
      let first: Promise<TurnUndoResult | null> = Promise.resolve(null);
      act(() => { first = result.current.run('undo'); });

      await expect(result.current.run('undo')).resolves.toBeNull();
      await expect(result.current.run('reapply')).resolves.toBeNull();
      expect(mocks.undoTurn).toHaveBeenCalledTimes(1);
      expect(mocks.reapplyTurn).not.toHaveBeenCalled();

      await act(async () => { release(RESULT); });
      await first;
    });

    it('is no longer busy after a run that was refused, and runs again', async () => {
      mocks.undoTurn.mockRejectedValueOnce(new Error('Turn undo refused: turn-running'));
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));

      let refused: Promise<unknown> = Promise.resolve();
      act(() => { refused = result.current.run('undo'); });
      await act(async () => { await expect(refused).rejects.toThrow('turn-running'); });
      expect(result.current.busy).toBe(false);

      await act(async () => { await result.current.run('undo'); });
      expect(mocks.undoTurn).toHaveBeenCalledTimes(2);
    });

    it('authorizes a file exactly when the write check allows its path', async () => {
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
      await act(async () => { await result.current.run('undo'); });
      const { authorize } = mocks.undoTurn.mock.calls[0][2] as { authorize: (path: string) => Promise<boolean> };

      mocks.checkWritePath.mockResolvedValueOnce({ allowed: true, resolvedPath: '/ws/a.md' });
      await expect(authorize('/ws/a.md')).resolves.toBe(true);
      mocks.checkWritePath.mockResolvedValueOnce({ allowed: false, needsPermission: true, permissionPath: '/elsewhere' });
      await expect(authorize('/elsewhere/a.md')).resolves.toBe(false);
      mocks.checkWritePath.mockResolvedValueOnce({ allowed: false, reason: 'blocked' });
      await expect(authorize('/blocked/a.md')).resolves.toBe(false);
      expect(mocks.checkWritePath.mock.calls).toEqual([['/ws/a.md'], ['/elsewhere/a.md'], ['/blocked/a.md']]);
      expect(mocks.canonicalize).not.toHaveBeenCalled();
    });

    it('checks a file under the resolved workspace folder in the spelling of the workspace', async () => {
      setConversations(['conv-1'], '/var/work/project/');
      mocks.canonicalize.mockResolvedValue('/private/var/work/project');
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
      await act(async () => { await result.current.run('undo'); });
      const { authorize } = mocks.undoTurn.mock.calls[0][2] as { authorize: (path: string) => Promise<boolean> };

      await authorize('/private/var/work/project/docs/a.md');
      await authorize('/var/work/project/b.md');
      await authorize('/private/var/work/project-old/c.md');
      await authorize('/elsewhere/d.md');

      expect(mocks.checkWritePath.mock.calls).toEqual([
        ['/var/work/project/docs/a.md'],
        ['/var/work/project/b.md'],
        ['/private/var/work/project-old/c.md'],
        ['/elsewhere/d.md'],
      ]);
      expect(mocks.canonicalize).toHaveBeenCalledWith('/var/work/project');
    });

    it('checks the recorded path where the host resolves no paths', async () => {
      setConversations(['conv-1'], '/var/work/project');
      mocks.canonicalize.mockResolvedValue(null);
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
      await act(async () => { await result.current.run('undo'); });
      const { authorize } = mocks.undoTurn.mock.calls[0][2] as { authorize: (path: string) => Promise<boolean> };

      await authorize('/private/var/work/project/a.md');

      expect(mocks.checkWritePath.mock.calls).toEqual([['/private/var/work/project/a.md']]);
    });

    it('says the conversation is present exactly while the chat store holds it', async () => {
      const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
      await result.current.plan('undo');
      const { isConversationPresent } = mocks.planTurnUndo.mock.calls[0][3] as { isConversationPresent: () => boolean };

      expect(isConversationPresent()).toBe(true);
      setConversations(['conv-2']);
      expect(isConversationPresent()).toBe(false);
    });
  });

  describe('useConversationChangedFiles', () => {
    function indexEntry(files: TurnIndexEntry['files'], extra: Partial<TurnIndexEntry> = {}): TurnIndexEntry {
      return { total: files.length, added: 0, deleted: 0, firstFile: 'x', files, ...extra };
    }

    function user(id: string, content: string, timestamp: number, extra: Partial<Message> = {}): Message {
      return { id, role: 'user', content, timestamp, ...extra };
    }

    function assistant(id: string, loopId: string, extra: Partial<Message> = {}): Message {
      return { id, role: 'assistant', content: '', timestamp: 0, loopId, ...extra };
    }

    function setMessages(messages: Message[], status: Conversation['status'] = 'idle'): void {
      useChatStore.setState({
        conversations: { 'conv-1': { id: 'conv-1', title: 'conv-1', messages, createdAt: 1_000, updatedAt: 1_000, status } },
      });
    }

    it('is loading until the index is read, then lists the files of the turns the messages hold', async () => {
      mocks.readTurnIndex.mockResolvedValue({
        'loop-1': indexEntry([{ path: '/ws/a.md', display: 'a.md', status: 'created' }]),
        'loop-gone': indexEntry([{ path: '/ws/gone.md', display: 'gone.md', status: 'created' }]),
      } satisfies TurnIndex);
      setMessages([user('u1', 'write a', 5_000), assistant('a1', 'loop-1')]);

      const { result } = renderHook(() => useConversationChangedFiles('conv-1'));
      expect(result.current).toEqual({ status: 'loading', files: [] });
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.files.map((file) => file.display)).toEqual(['a.md']);
    });

    it('describes a turn by the first line of the last user message before it that is no system message', async () => {
      mocks.readTurnIndex.mockResolvedValue({
        'loop-1': indexEntry([{ path: '/ws/a.md', display: 'a.md', status: 'modified' }]),
      } satisfies TurnIndex);
      setMessages([
        user('u0', 'earlier', 1_000),
        user('u1', 'tidy the notes\nand more detail', 5_000),
        user('s1', 'internal', 6_000, { isSystem: true }),
        assistant('a1', 'loop-1'),
        assistant('a2', 'loop-1'),
      ]);

      const { result } = renderHook(() => useConversationChangedFiles('conv-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.files[0].turns).toEqual([{ loopId: 'loop-1', prompt: 'tidy the notes', at: 5_000, fileIndex: 0 }]);
    });

    it('lists the file changes of the running turn, and the saved turn once it is saved', async () => {
      mocks.readTurnIndex.mockResolvedValue({} satisfies TurnIndex);
      const running = assistant('a1', 'loop-1', {
        toolCalls: [{ id: 't1', name: 'write_file', input: {}, fileChange: { path: '/ws/new.md', kind: 'create' } }],
      });
      setMessages([user('u1', 'write', 5_000), running], 'running');

      const { result } = renderHook(() => useConversationChangedFiles('conv-1'));
      await waitFor(() => expect(result.current.files.map((file) => [file.path, file.status])).toEqual([['/ws/new.md', 'created']]));

      mocks.readTurnIndex.mockResolvedValue({
        'loop-1': indexEntry([{ path: '/ws/new.md', display: 'new.md', status: 'created' }]),
      } satisfies TurnIndex);
      act(() => saved('conv-1', 'loop-1'));
      await waitFor(() => expect(result.current.files.map((file) => file.display)).toEqual(['new.md']));
    });

    it('returns the same list while text streams into a reply', async () => {
      mocks.readTurnIndex.mockResolvedValue({
        'loop-1': indexEntry([{ path: '/ws/a.md', display: 'a.md', status: 'modified' }]),
      } satisfies TurnIndex);
      const reply = assistant('a1', 'loop-1', { content: 'one' });
      setMessages([user('u1', 'go', 5_000), reply], 'running');
      const { result } = renderHook(() => useConversationChangedFiles('conv-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      const files = result.current.files;

      act(() => setMessages([user('u1', 'go', 5_000), { ...reply, content: 'one two' }], 'running'));

      expect(result.current.files).toBe(files);
    });
  });
});
