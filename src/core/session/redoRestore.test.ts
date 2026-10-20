import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHostFs, type MemoryHostFs } from './__fixtures__/memoryHostFs';
import type { ConversationWorkspaceFiles } from '@/core/files/workspaceFiles';

const host = vi.hoisted(() => ({
  fs: null as unknown as import('./__fixtures__/memoryHostFs').MemoryHostFs,
  listWorkspace: null as unknown as import('vitest').Mock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (path: string) => host.fs.pluginFs.exists(path),
  mkdir: (path: string, options?: { recursive?: boolean }) => host.fs.pluginFs.mkdir(path, options),
  readFile: (path: string) => host.fs.pluginFs.readFile(path),
  readTextFile: (path: string) => host.fs.pluginFs.readTextFile(path),
  writeFile: (path: string, bytes: Uint8Array, options?: { create?: boolean; createNew?: boolean }) => host.fs.pluginFs.writeFile(path, bytes, options),
  remove: (path: string, options?: { recursive?: boolean }) => host.fs.pluginFs.remove(path, options),
  readDir: (path: string) => host.fs.pluginFs.readDir(path),
  stat: (path: string) => host.fs.pluginFs.stat(path),
  // The write check inspects the components of a path; the memory disk holds no link.
  lstat: async () => ({ isSymlink: false }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: { path: string }) => {
    if (command !== 'move_to_trash') throw new Error(`unexpected command ${command}`);
    return host.fs.moveToTrash(args.path);
  },
}));
vi.mock('@/core/tools/fsBridge', () => ({
  exists: (path: string) => host.fs.bridge.exists(path),
  stat: (path: string) => host.fs.bridge.stat(path),
  readFile: (path: string) => host.fs.bridge.readFile(path),
}));
vi.mock('@/utils/atomicFs', () => ({
  atomicWrite: (path: string, content: string) => host.fs.atomicWrite(path, content),
  writeFileAtomic: (path: string, bytes: Uint8Array, mode: 'replace' | 'create') => host.fs.writeFileAtomic(path, bytes, mode),
}));
vi.mock('@/core/files/workspaceFiles', () => ({
  listConversationWorkspaceFiles: (...args: unknown[]) => host.listWorkspace(...args),
}));

type TurnChangesModule = typeof import('./turnChanges');
type TurnUndoModule = typeof import('./turnUndo');
type RedoRestoreModule = typeof import('./redoRestore');

const HOME = '/Users/testuser';
const WS = `${HOME}/project`;
const CONVERSATION = `${HOME}/.abu/conversations/conv-1`;
const CHANGES = `${CONVERSATION}/changes`;
const BIG = new Uint8Array(2 * 1024 * 1024 + 1).fill(97);

let fs: MemoryHostFs;
let changes: TurnChangesModule;
let undo: TurnUndoModule;
let redo: RedoRestoreModule;
let authorize: import('vitest').Mock<(path: string) => Promise<boolean>>;

/** Fresh module instances over the same disk: what an app restart leaves behind. */
async function restart(): Promise<void> {
  vi.resetModules();
  changes = await import('./turnChanges');
  undo = await import('./turnUndo');
  redo = await import('./redoRestore');
}

async function runTurn(loopId: string, edits: (capture: (path: string) => Promise<void>) => Promise<void> | void): Promise<void> {
  await changes.beginTurn('conv-1', loopId, WS);
  await edits((path) => changes.captureBefore(loopId, path));
  await changes.endTurn(loopId);
}

/** A turn that modifies plan.md, creates new.md and deletes old.md. */
async function runMixedTurn(loopId = 'loop-1'): Promise<void> {
  fs.write(`${WS}/plan.md`, 'one\n');
  fs.write(`${WS}/old.md`, 'gone\n');
  await runTurn(loopId, async (capture) => {
    for (const file of ['plan.md', 'new.md', 'old.md']) await capture(`${WS}/${file}`);
    fs.write(`${WS}/plan.md`, 'two\n');
    fs.write(`${WS}/new.md`, 'n\n');
    fs.delete(`${WS}/old.md`);
  });
}

/** A turn whose file tools give each named file its content. */
async function editTurn(loopId: string, contents: Record<string, string>): Promise<void> {
  await runTurn(loopId, async (capture) => {
    for (const [file, content] of Object.entries(contents)) {
      await capture(`${WS}/${file}`);
      fs.write(`${WS}/${file}`, content);
    }
  });
}

/** The example of story 2: loop-1 modifies a.md, loop-2 modifies a.md and b.md, loop-3 creates c.md. */
async function runThreeTurns(): Promise<void> {
  fs.write(`${WS}/a.md`, 'v0');
  fs.write(`${WS}/b.md`, 'b0');
  await editTurn('loop-1', { 'a.md': 'v1' });
  await editTurn('loop-2', { 'a.md': 'v2', 'b.md': 'b1' });
  await editTurn('loop-3', { 'c.md': 'c3' });
}

function plan(loopIds: string[]): ReturnType<RedoRestoreModule['planRedoRestore']> {
  return redo.planRedoRestore('conv-1', loopIds, { authorize });
}

function restore(loopIds: string[], confirmed: readonly string[]): ReturnType<RedoRestoreModule['restoreForRedo']> {
  return redo.restoreForRedo('conv-1', loopIds, confirmed, { authorize });
}

/** The paths the confirmation lists as restored, as the user confirms them. */
async function confirmedOf(loopIds: string[]): Promise<string[]> {
  return (await plan(loopIds)).willRestore.map((file) => file.path);
}

function recordOf(loopId: string): { state: string; entries: Array<{ path: string; last?: string }> } {
  return fs.readJson(`${CHANGES}/${loopId}/undo.json`);
}

function lastByFile(loopId: string): Record<string, string | undefined> {
  return Object.fromEntries(recordOf(loopId).entries.map((entry) => [entry.path.slice(WS.length + 1), entry.last]));
}

/** Calls of the atomic write for one path. */
function atomicWritesOf(spy: { mock: { calls: unknown[][] } }, path: string): number {
  return spy.mock.calls.filter(([written]) => written === path).length;
}

const THREE_TURNS = ['loop-1', 'loop-2', 'loop-3'];

/** Lets every pending microtask run, so a call made before has reached its first wait. */
function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  host.fs = createMemoryHostFs();
  await import('./turnChanges');
  await import('./turnUndo');
  await import('./redoRestore');
});

beforeEach(async () => {
  fs = createMemoryHostFs();
  host.fs = fs;
  host.listWorkspace = vi.fn(async (_conversationId: string, root: string): Promise<ConversationWorkspaceFiles> => fs.listWorkspace(root));
  authorize = vi.fn(async () => true);
  await restart();
});

afterEach(() => {
  changes.__testing.setConversationCopyLimit();
});

describe('redoRestore', () => {
  describe('planRedoRestore', () => {
    it('plans one turn the way planTurnUndo plans its undo', async () => {
      await runMixedTurn('loop-1');

      const merged = await plan(['loop-1']);

      expect(merged).toEqual(await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize }));
      expect(merged.willRestore).toHaveLength(3);
    });

    it('plans the three-turn example of story 2', async () => {
      await runThreeTurns();

      await expect(plan(THREE_TURNS)).resolves.toEqual({
        willRestore: [
          { path: `${WS}/a.md`, display: 'a.md', action: 'write-before' },
          { path: `${WS}/b.md`, display: 'b.md', action: 'write-before' },
          { path: `${WS}/c.md`, display: 'c.md', action: 'trash' },
        ],
        wontRestore: [],
      });
      expect(fs.read(`${WS}/a.md`)).toBe('v2');
    });

    it('lists a file changed between two turns as changed since', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      fs.write(`${WS}/a.md`, 'mine');
      await editTurn('loop-2', { 'a.md': 'v2' });

      await expect(plan(['loop-1', 'loop-2'])).resolves.toEqual({
        willRestore: [],
        wontRestore: [{ path: `${WS}/a.md`, display: 'a.md', reason: 'changed-since' }],
      });
    });

    it('lists a file changed after the last turn as changed since', async () => {
      await runThreeTurns();
      fs.write(`${WS}/b.md`, 'mine');

      const merged = await plan(THREE_TURNS);

      expect(merged.wontRestore).toEqual([{ path: `${WS}/b.md`, display: 'b.md', reason: 'changed-since' }]);
      expect(merged.willRestore.map((file) => file.display)).toEqual(['a.md', 'c.md']);
    });

    it('leaves out a file an undone turn already restored', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      fs.write(`${WS}/b.md`, 'b0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      await editTurn('loop-2', { 'b.md': 'b1' });
      await undo.undoTurn('conv-1', 'loop-2', { authorize });

      await expect(plan(['loop-1', 'loop-2'])).resolves.toEqual({
        willRestore: [{ path: `${WS}/a.md`, display: 'a.md', action: 'write-before' }],
        wontRestore: [],
      });
    });

    it('restores what a partly undone turn did not restore', async () => {
      fs.write(`${WS}/b.md`, 'b0');
      fs.write(`${WS}/c.md`, 'c0');
      await editTurn('loop-2', { 'b.md': 'b1', 'c.md': 'c1' });
      fs.failNextWrite(`${WS}/b.md`);
      await undo.undoTurn('conv-1', 'loop-2', { authorize });
      expect(fs.read(`${WS}/b.md`)).toBe('b1');
      expect(fs.read(`${WS}/c.md`)).toBe('c0');

      await expect(plan(['loop-2'])).resolves.toEqual({
        willRestore: [{ path: `${WS}/b.md`, display: 'b.md', action: 'write-before' }],
        wontRestore: [],
      });
    });

    it('restores across a later turn that already undid the file', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      await editTurn('loop-2', { 'a.md': 'v2' });
      await undo.undoTurn('conv-1', 'loop-2', { authorize });
      expect(fs.read(`${WS}/a.md`)).toBe('v1');

      await expect(plan(['loop-1', 'loop-2'])).resolves.toEqual({
        willRestore: [{ path: `${WS}/a.md`, display: 'a.md', action: 'write-before' }],
        wontRestore: [],
      });
    });

    it('restores across a later turn whose undo of the file failed', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      fs.write(`${WS}/b.md`, 'b0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      await editTurn('loop-2', { 'a.md': 'v2', 'b.md': 'b1' });
      fs.failNextWrite(`${WS}/a.md`);
      await undo.undoTurn('conv-1', 'loop-2', { authorize });
      expect(recordOf('loop-2').state).toBe('undone');
      expect(lastByFile('loop-2')).toEqual({ 'a.md': 'failed', 'b.md': 'done' });

      await expect(plan(['loop-1', 'loop-2'])).resolves.toEqual({
        willRestore: [{ path: `${WS}/a.md`, display: 'a.md', action: 'write-before' }],
        wontRestore: [],
      });
    });

    it('throws on a turn named twice', async () => {
      await runThreeTurns();

      await expect(plan(['loop-1', 'loop-2', 'loop-1'])).rejects.toThrow('Redo loop ids repeat');
    });

    it('treats a turn put back after an undo like one never undone', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      await undo.reapplyTurn('conv-1', 'loop-1', { authorize });

      await expect(plan(['loop-1'])).resolves.toEqual({
        willRestore: [{ path: `${WS}/a.md`, display: 'a.md', action: 'write-before' }],
        wontRestore: [],
      });
    });

    it('lists a later command change of a recorded file with the command reason', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      fs.write(`${WS}/other.md`, 'o0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      await runTurn('loop-2', async (capture) => {
        // other.md gives the turn an undo record; a.md is changed by a command.
        await capture(`${WS}/other.md`);
        fs.write(`${WS}/other.md`, 'o2');
        fs.write(`${WS}/a.md`, 'v2');
      });

      await expect(plan(['loop-1', 'loop-2'])).resolves.toEqual({
        willRestore: [{ path: `${WS}/other.md`, display: 'other.md', action: 'write-before' }],
        wontRestore: [{ path: `${WS}/a.md`, display: 'a.md', reason: 'by-command' }],
      });
    });

    it('lists a later change over 2 MB as too large', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      fs.write(`${WS}/other.md`, 'o0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      await runTurn('loop-2', async (capture) => {
        // other.md gives the turn an undo record; a.md grows past the copy size.
        await capture(`${WS}/other.md`);
        fs.write(`${WS}/other.md`, 'o2');
        await capture(`${WS}/a.md`);
        fs.writeBytes(`${WS}/a.md`, BIG);
      });

      await expect(plan(['loop-1', 'loop-2'])).resolves.toEqual({
        willRestore: [{ path: `${WS}/other.md`, display: 'other.md', action: 'write-before' }],
        wontRestore: [{ path: `${WS}/a.md`, display: 'a.md', reason: 'too-large' }],
      });
    });

    it('leaves out a file whose first turn lost its copies', async () => {
      // loop-1 keeps 2 bytes ('v0'), loop-2 keeps 4 ('v1', 'b0'): with room for 4, loop-1 loses its copies.
      changes.__testing.setConversationCopyLimit(4);
      fs.write(`${WS}/a.md`, 'v0');
      fs.write(`${WS}/b.md`, 'b0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      await editTurn('loop-2', { 'a.md': 'v2', 'b.md': 'b1' });
      expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
      expect(fs.has(`${CHANGES}/loop-2/undo.json`)).toBe(true);

      await expect(plan(['loop-1', 'loop-2'])).resolves.toEqual({
        willRestore: [{ path: `${WS}/b.md`, display: 'b.md', action: 'write-before' }],
        wontRestore: [],
      });
    });

    it('leaves out the files of a turn whose undo record cannot be read', async () => {
      await runThreeTurns();
      fs.write(`${CHANGES}/loop-2/undo.json`, '{');

      await expect(plan(THREE_TURNS)).resolves.toEqual({
        willRestore: [{ path: `${WS}/c.md`, display: 'c.md', action: 'trash' }],
        wontRestore: [],
      });
    });

    it('lists a file whose folder is gone', async () => {
      fs.write(`${WS}/sub/d.md`, 'd0');
      await editTurn('loop-1', { 'sub/d.md': 'd1' });
      fs.delete(`${WS}/sub`);

      await expect(plan(['loop-1'])).resolves.toEqual({
        willRestore: [],
        wontRestore: [{ path: `${WS}/sub/d.md`, display: 'sub/d.md', reason: 'folder-gone' }],
      });
    });

    it('lists a file Abu may not write as not authorized', async () => {
      await runThreeTurns();
      authorize.mockImplementation(async (path) => path !== `${WS}/a.md`);

      const merged = await plan(THREE_TURNS);

      expect(merged.wontRestore).toEqual([{ path: `${WS}/a.md`, display: 'a.md', reason: 'not-authorized' }]);
      expect(merged.willRestore.map((file) => file.display)).toEqual(['b.md', 'c.md']);
    });

    it('gives each combination across turns its action', async () => {
      fs.write(`${WS}/d.md`, 'd0');
      await runTurn('loop-1', async (capture) => {
        for (const file of ['d.md', 'e.md', 'f.md']) await capture(`${WS}/${file}`);
        fs.delete(`${WS}/d.md`);
        fs.write(`${WS}/e.md`, 'e1');
        fs.write(`${WS}/f.md`, 'f1');
      });
      await runTurn('loop-2', async (capture) => {
        for (const file of ['d.md', 'e.md', 'f.md']) await capture(`${WS}/${file}`);
        fs.write(`${WS}/d.md`, 'd2');
        fs.write(`${WS}/e.md`, 'e2');
        fs.delete(`${WS}/f.md`);
      });

      await expect(plan(['loop-1', 'loop-2'])).resolves.toEqual({
        willRestore: [
          { path: `${WS}/d.md`, display: 'd.md', action: 'write-before' },
          { path: `${WS}/e.md`, display: 'e.md', action: 'trash' },
        ],
        wontRestore: [],
      });
    });

    it('follows a chain through twenty turns', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      const loopIds: string[] = [];
      for (let turn = 1; turn <= 20; turn++) {
        loopIds.push(`loop-${turn}`);
        await editTurn(`loop-${turn}`, { 'a.md': `v${turn}` });
      }

      await expect(plan(loopIds)).resolves.toEqual({
        willRestore: [{ path: `${WS}/a.md`, display: 'a.md', action: 'write-before' }],
        wontRestore: [],
      });
    });

    it('plans a turn that is still settling once its settle has run', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      await changes.readTurnIndex('conv-1');
      await changes.beginTurn('conv-1', 'loop-1', WS);
      await changes.captureBefore('loop-1', `${WS}/a.md`);
      fs.write(`${WS}/a.md`, 'v1');

      const planning = plan(['loop-1']);
      await yieldToMainThread();
      await changes.endTurn('loop-1');

      await expect(planning).resolves.toEqual({
        willRestore: [{ path: `${WS}/a.md`, display: 'a.md', action: 'write-before' }],
        wontRestore: [],
      });
    });

    it('gives an empty plan for turns without records and for a conversation that is gone', async () => {
      await runTurn('loop-1', () => {
        fs.write(`${WS}/by-command.md`, 'x\n');
      });
      await expect(plan(['loop-1'])).resolves.toEqual({ willRestore: [], wontRestore: [] });

      await runMixedTurn('loop-2');
      await expect(
        redo.planRedoRestore('conv-1', ['loop-1', 'loop-2'], { authorize, isConversationPresent: () => false }),
      ).resolves.toEqual({ willRestore: [], wontRestore: [] });
      expect(authorize).not.toHaveBeenCalled();
    });
  });

  describe('restoreForRedo', () => {
    /** The three-turn example, restored with b.md's write failing. */
    async function restoreThreeTurnsWithFailedB(): Promise<Awaited<ReturnType<RedoRestoreModule['restoreForRedo']>>> {
      await runThreeTurns();
      const confirmed = await confirmedOf(THREE_TURNS);
      fs.failNextWrite(`${WS}/b.md`);
      return restore(THREE_TURNS, confirmed);
    }

    it('restores the three-turn example and writes each file once', async () => {
      await runThreeTurns();
      const confirmed = await confirmedOf(THREE_TURNS);
      const writes = vi.spyOn(host.fs, 'writeFileAtomic');

      await expect(restore(THREE_TURNS, confirmed)).resolves.toEqual({ done: 3, notDone: [] });

      expect(fs.read(`${WS}/a.md`)).toBe('v0');
      expect(fs.read(`${WS}/b.md`)).toBe('b0');
      expect(fs.has(`${WS}/c.md`)).toBe(false);
      expect(atomicWritesOf(writes, `${WS}/a.md`)).toBe(1);
    });

    it('marks every turn on the way undone', async () => {
      await runThreeTurns();
      await restore(THREE_TURNS, await confirmedOf(THREE_TURNS));

      for (const loopId of THREE_TURNS) expect(recordOf(loopId).state).toBe('undone');
      expect(lastByFile('loop-1')).toEqual({ 'a.md': 'done' });
      expect(lastByFile('loop-2')).toEqual({ 'a.md': 'done', 'b.md': 'done' });
      expect(lastByFile('loop-3')).toEqual({ 'c.md': 'done' });
    });

    it('keeps restoring the others when one write fails and records it', async () => {
      await expect(restoreThreeTurnsWithFailedB()).resolves.toEqual({
        done: 2,
        notDone: [{ path: `${WS}/b.md`, display: 'b.md', reason: 'write-failed' }],
      });

      expect(fs.read(`${WS}/a.md`)).toBe('v0');
      expect(fs.read(`${WS}/b.md`)).toBe('b1');
      expect(fs.has(`${WS}/c.md`)).toBe(false);
      expect(recordOf('loop-2').state).toBe('undone');
      expect(lastByFile('loop-2')).toEqual({ 'a.md': 'done', 'b.md': 'failed' });
    });

    it('leaves each turn able to be put back after a stop', async () => {
      await restoreThreeTurnsWithFailedB();

      for (const loopId of THREE_TURNS) await undo.reapplyTurn('conv-1', loopId, { authorize });

      expect(fs.read(`${WS}/a.md`)).toBe('v2');
      expect(fs.read(`${WS}/b.md`)).toBe('b1');
      expect(fs.read(`${WS}/c.md`)).toBe('c3');
    });

    it('leaves a turn whose files all failed as it was', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      await editTurn('loop-1', { 'a.md': 'v1' });
      const confirmed = await confirmedOf(['loop-1']);
      fs.failNextWrite(`${WS}/a.md`);

      await expect(restore(['loop-1'], confirmed)).resolves.toEqual({
        done: 0,
        notDone: [{ path: `${WS}/a.md`, display: 'a.md', reason: 'write-failed' }],
      });

      expect(recordOf('loop-1').state).toBe('applied');
      expect(recordOf('loop-1').entries.every((entry) => entry.last === undefined)).toBe(true);
      expect(fs.read(`${WS}/a.md`)).toBe('v1');
    });

    it('counts a confirmed file changed after the plan as not restored', async () => {
      await runThreeTurns();
      const confirmed = await confirmedOf(THREE_TURNS);
      fs.write(`${WS}/a.md`, 'mine');

      const result = await restore(THREE_TURNS, confirmed);

      expect(result.notDone).toEqual([{ path: `${WS}/a.md`, display: 'a.md', reason: 'write-failed' }]);
      expect(result.done).toBe(2);
      expect(fs.read(`${WS}/a.md`)).toBe('mine');
    });

    it('counts a confirmed file already at its target as restored without writing it', async () => {
      await runThreeTurns();
      const confirmed = await confirmedOf(THREE_TURNS);
      await undo.undoTurn('conv-1', 'loop-3', { authorize });
      const writes = vi.spyOn(host.fs, 'writeFileAtomic');
      const trash = vi.spyOn(host.fs, 'moveToTrash');

      const result = await restore(THREE_TURNS, confirmed);

      expect(result).toEqual({ done: 3, notDone: [] });
      expect(atomicWritesOf(writes, `${WS}/c.md`)).toBe(0);
      expect(trash).not.toHaveBeenCalledWith(`${WS}/c.md`);
    });

    it('writes only the confirmed files', async () => {
      await runThreeTurns();

      await expect(restore(THREE_TURNS, [`${WS}/a.md`])).resolves.toEqual({ done: 1, notDone: [] });

      expect(fs.read(`${WS}/a.md`)).toBe('v0');
      expect(fs.read(`${WS}/b.md`)).toBe('b1');
      expect(fs.read(`${WS}/c.md`)).toBe('c3');
    });

    it('follows a chain through twenty turns', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      const loopIds: string[] = [];
      for (let turn = 1; turn <= 20; turn++) {
        loopIds.push(`loop-${turn}`);
        await editTurn(`loop-${turn}`, { 'a.md': `v${turn}` });
      }
      const confirmed = await confirmedOf(loopIds);
      const writes = vi.spyOn(host.fs, 'writeFileAtomic');

      await expect(restore(loopIds, confirmed)).resolves.toEqual({ done: 1, notDone: [] });

      expect(fs.read(`${WS}/a.md`)).toBe('v0');
      expect(atomicWritesOf(writes, `${WS}/a.md`)).toBe(1);
    });

    it('restores a turn that is still settling once its settle has run', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      await changes.readTurnIndex('conv-1');
      await changes.beginTurn('conv-1', 'loop-1', WS);
      await changes.captureBefore('loop-1', `${WS}/a.md`);
      fs.write(`${WS}/a.md`, 'v1');

      const restoring = restore(['loop-1'], [`${WS}/a.md`]);
      await yieldToMainThread();
      await changes.endTurn('loop-1');

      await expect(restoring).resolves.toEqual({ done: 1, notDone: [] });
      expect(fs.read(`${WS}/a.md`)).toBe('v0');
      expect(recordOf('loop-1').state).toBe('undone');
    });

    it('refuses when a run opens a turn while it waits for the turn to settle', async () => {
      fs.write(`${WS}/a.md`, 'v0');
      await changes.readTurnIndex('conv-1');
      await changes.beginTurn('conv-1', 'loop-1', WS);
      await changes.captureBefore('loop-1', `${WS}/a.md`);
      fs.write(`${WS}/a.md`, 'v1');

      const restoring = restore(['loop-1'], [`${WS}/a.md`]);
      await yieldToMainThread();
      await changes.beginTurn('conv-1', 'loop-2', WS);
      await changes.endTurn('loop-1');

      await expect(restoring).rejects.toMatchObject({ reason: 'turn-running' });
      expect(fs.read(`${WS}/a.md`)).toBe('v1');
      expect(recordOf('loop-1').state).toBe('applied');
      await changes.endTurn('loop-2');
    });

    it('refuses when a turn opens before its queued work runs', async () => {
      await runThreeTurns();
      const confirmed = await confirmedOf(THREE_TURNS);

      // The restore finds no open turn and queues its work; the turn opens before that work runs.
      const restoring = restore(THREE_TURNS, confirmed);
      const opening = changes.beginTurn('conv-1', 'loop-9', WS);

      await expect(restoring).rejects.toMatchObject({ reason: 'turn-running' });
      await opening;
      expect(fs.read(`${WS}/a.md`)).toBe('v2');
    });

    it('writes nothing for a conversation that is gone', async () => {
      await runThreeTurns();
      const confirmed = await confirmedOf(THREE_TURNS);

      await expect(
        redo.restoreForRedo('conv-1', THREE_TURNS, confirmed, { authorize, isConversationPresent: () => false }),
      ).resolves.toEqual({ done: 0, notDone: [] });

      expect(fs.read(`${WS}/a.md`)).toBe('v2');
      expect(fs.read(`${WS}/b.md`)).toBe('b1');
      expect(fs.read(`${WS}/c.md`)).toBe('c3');
    });

    it('throws on a turn named twice', async () => {
      await runThreeTurns();

      await expect(restore(['loop-1', 'loop-1'], [`${WS}/a.md`])).rejects.toThrow('Redo loop ids repeat');
      expect(fs.read(`${WS}/a.md`)).toBe('v2');
    });

    it('throws on a confirmed path named twice', async () => {
      await runThreeTurns();

      await expect(restore(THREE_TURNS, [`${WS}/a.md`, `${WS}/b.md`, `${WS}/a.md`])).rejects.toThrow('Redo confirmed paths repeat');
      expect(fs.read(`${WS}/a.md`)).toBe('v2');
      expect(fs.read(`${WS}/b.md`)).toBe('b1');
    });

    it('leaves a file alone when its write is refused at restore time', async () => {
      await runThreeTurns();
      const confirmed = await confirmedOf(THREE_TURNS);
      authorize.mockImplementation(async (path) => path !== `${WS}/a.md`);

      const result = await restore(THREE_TURNS, confirmed);

      expect(result).toEqual({
        done: 2,
        notDone: [{ path: `${WS}/a.md`, display: 'a.md', reason: 'not-authorized' }],
      });
      expect(fs.read(`${WS}/a.md`)).toBe('v2');
      expect(recordOf('loop-2').state).toBe('undone');
      expect(lastByFile('loop-2')).toEqual({ 'a.md': 'failed', 'b.md': 'done' });
    });

    it('writes nothing when a before copy no longer holds its recorded content', async () => {
      await runThreeTurns();
      const confirmed = await confirmedOf(THREE_TURNS);
      const record = fs.readJson<{ entries: Array<{ path: string; hash: string }> }>(`${CHANGES}/loop-1/undo.json`);
      const entry = record.entries.find((item) => item.path === `${WS}/a.md`);
      if (!entry) throw new Error('loop-1 records no a.md');
      fs.write(`${CHANGES}/loop-1/before/${entry.hash}`, 'other');

      const result = await restore(THREE_TURNS, confirmed);

      expect(fs.read(`${WS}/a.md`)).toBe('v2');
      expect(result.notDone).toEqual([{ path: `${WS}/a.md`, display: 'a.md', reason: 'write-failed' }]);
    });
  });
});
