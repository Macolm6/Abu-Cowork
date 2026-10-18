/**
 * Restoring the files a redo takes back: the ones the redone turn and the
 * later turns it deletes changed.
 *
 * The undo records of those turns are merged per file into the chain of turns
 * that changed it, in conversation order. A file is given what it held before
 * the first turn of its chain, in one write, and only while each turn of the
 * chain began with what the turn before it left and the file still holds what
 * the last one left: a file someone else changed between or after the turns is
 * left as it is.
 *
 * The work runs in the conversation's settle queue, like an undo.
 */
import { exists } from '@tauri-apps/plugin-fs';
import { exists as fileExists } from '@/core/tools/fsBridge';
import { getParentDir } from '@/utils/pathUtils';
import { assertConversationId } from './conversationPaths';
import {
  assertLoopId,
  changesDir,
  enqueue,
  ensureRecovered,
  loadUndoRecord,
  readCurrentSide,
  readTurnChanges,
  readTurnIndex,
  turnCopyPath,
  type FileSide,
} from './turnChanges';
import {
  compareDisplay,
  holds,
  type PlannedFile,
  type SkippedFile,
  type TurnUndoAction,
  type TurnUndoOptions,
  type TurnUndoPlan,
  type TurnUndoSkipReason,
} from './turnUndo';
import type { TurnUndoEntry, TurnUndoRecord } from './turnUndoRecord';

/** What a path held at one end of a turn: a file, with the SHA-256 of its content, or nothing. */
export interface RecordedSide {
  kind: 'file' | 'absent';
  sha256: string | undefined;
}

/** One turn of a file's chain: its record, the file's entry in it, and what the file held when the turn began and ended. */
export interface ChainLink {
  loopId: string;
  record: TurnUndoRecord;
  entry: TurnUndoEntry;
  start: RecordedSide;
  /** For a turn that already undid this file, what the undo wrote: its start. */
  end: RecordedSide;
}

interface FileBase {
  path: string;
  display: string;
}

/**
 * The verdict on one file. 'restore': it is written with `target`, which is
 * the start of the first link. 'in-place': it already holds `target`.
 * 'skip': it is left as it is, for `reason`.
 */
export type RedoFile =
  | (FileBase & { verdict: 'restore'; action: TurnUndoAction; chain: ChainLink[]; target: RecordedSide; current: FileSide })
  | (FileBase & { verdict: 'in-place'; chain: ChainLink[]; target: RecordedSide })
  | (FileBase & { verdict: 'skip'; reason: TurnUndoSkipReason });

export interface RedoAssessment {
  dir: string;
  /** The undo records that could be read, by turn. */
  records: ReadonlyMap<string, TurnUndoRecord>;
  /** Sorted by display path. A file of a turn without a readable undo record is not among them. */
  files: RedoFile[];
}

/** A turn that changed a file, with its record and the file's entry in it, when it has them. */
interface ChainTurn {
  loopId: string;
  record: TurnUndoRecord | null;
  entry: TurnUndoEntry | undefined;
}

type RecordedTurn = ChainTurn & { record: TurnUndoRecord };

const EMPTY_PLAN: TurnUndoPlan = { willRestore: [], wontRestore: [] };

function linkOf(loopId: string, record: TurnUndoRecord, entry: TurnUndoEntry): ChainLink {
  const start: RecordedSide = { kind: entry.before, sha256: entry.beforeSha256 };
  const end: RecordedSide = record.state === 'undone' && entry.last === 'done'
    ? start
    : { kind: entry.after, sha256: entry.afterSha256 };
  return { loopId, record, entry, start, end };
}

function sameSide(a: RecordedSide, b: RecordedSide): boolean {
  return a.kind === b.kind && a.sha256 === b.sha256;
}

/**
 * Judges one file by its chain; the first rule that applies decides. A file
 * one of whose turns has no readable undo record cannot go back to what it
 * held before the first turn, and gives null: it is neither listed nor written.
 */
async function judge(
  dir: string,
  file: FileBase,
  turns: ChainTurn[],
  authorize: TurnUndoOptions['authorize'],
): Promise<RedoFile | null> {
  const recorded = turns.filter((turn): turn is RecordedTurn => turn.record !== null);
  if (recorded.length < turns.length) return null;
  const skip = (reason: TurnUndoSkipReason): RedoFile => ({ ...file, verdict: 'skip', reason });

  const chain: ChainLink[] = [];
  for (const turn of recorded) {
    if (!turn.entry) return skip(turn.record.tooLarge?.includes(file.path) ? 'too-large' : 'by-command');
    chain.push(linkOf(turn.loopId, turn.record, turn.entry));
  }
  for (let i = 1; i < chain.length; i++) {
    if (!sameSide(chain[i - 1].end, chain[i].start)) return skip('changed-since');
  }
  if (!(await fileExists(getParentDir(file.path)))) return skip('folder-gone');

  const first = chain[0];
  const last = chain[chain.length - 1];
  const target = first.start;
  const current = await readCurrentSide(file.path);
  if (await holds(current, target.kind, target.sha256)) return { ...file, verdict: 'in-place', chain, target };
  if (!(await holds(current, last.end.kind, last.end.sha256))) return skip('changed-since');
  if (target.kind === 'file' && !(await exists(turnCopyPath(dir, first.loopId, 'before', first.entry.hash)))) {
    return skip('changed-since');
  }
  if (!(await authorize(file.path))) return skip('not-authorized');
  const action: TurnUndoAction = target.kind === 'absent' ? 'trash' : current.state === 'absent' ? 'put-back' : 'write-before';
  return { ...file, verdict: 'restore', action, chain, target, current };
}

/**
 * Merges the undo records of `loopIds`, in conversation order, into one
 * verdict per file. Reads only; asks `authorize` about each file that would be
 * written. Turns that have nothing to restore give no file, without a read of
 * any turn. Runs in the conversation's settle queue, after `ensureRecovered`.
 */
export async function assessRedo(
  conversationId: string,
  loopIds: readonly string[],
  authorize: TurnUndoOptions['authorize'],
): Promise<RedoAssessment> {
  const dir = await changesDir(conversationId);
  const records = new Map<string, TurnUndoRecord>();
  const index = await readTurnIndex(conversationId);
  if (!loopIds.some((loopId) => index[loopId]?.restorable)) return { dir, records, files: [] };

  const chains = new Map<string, { display: string | undefined; turns: ChainTurn[] }>();
  for (const loopId of loopIds) {
    if (!index[loopId]) continue;
    const turnFiles = (await readTurnChanges(conversationId, loopId))?.files ?? [];
    const record = await loadUndoRecord(dir, loopId);
    if (record) records.set(loopId, record);
    const entries = new Map((record?.entries ?? []).map((entry) => [entry.path, entry]));
    const displays = new Map(turnFiles.map((turnFile) => [turnFile.path, turnFile.display]));
    const paths = new Set([...displays.keys(), ...entries.keys(), ...(record?.tooLarge ?? [])]);
    for (const path of paths) {
      const chain = chains.get(path) ?? { display: undefined, turns: [] };
      chain.display ??= displays.get(path);
      chain.turns.push({ loopId, record, entry: entries.get(path) });
      chains.set(path, chain);
    }
  }

  const files: RedoFile[] = [];
  for (const [path, chain] of chains) {
    const file = await judge(dir, { path, display: chain.display ?? path }, chain.turns, authorize);
    if (file) files.push(file);
  }
  return { dir, records, files: files.sort(compareDisplay) };
}

/**
 * What restoring the files of a redo would do right now: the turn being
 * redone and the later turns it deletes, `loopIds` in conversation order. Each
 * file is listed once, with what it held before the first of these turns
 * changed it as its target. Reads only. A file already at its target is not
 * listed, nor is one whose chain has a turn without a readable undo record.
 */
export async function planRedoRestore(
  conversationId: string,
  loopIds: readonly string[],
  options: TurnUndoOptions,
): Promise<TurnUndoPlan> {
  assertConversationId(conversationId);
  for (const loopId of loopIds) assertLoopId(loopId);
  const isPresent = options.isConversationPresent ?? (() => true);
  if (!isPresent()) return EMPTY_PLAN;
  await ensureRecovered(conversationId);
  return enqueue(conversationId, async () => {
    if (!isPresent()) return EMPTY_PLAN;
    const { files } = await assessRedo(conversationId, loopIds, options.authorize);
    const willRestore: PlannedFile[] = [];
    const wontRestore: SkippedFile[] = [];
    for (const file of files) {
      if (file.verdict === 'restore') willRestore.push({ path: file.path, display: file.display, action: file.action });
      if (file.verdict === 'skip') wontRestore.push({ path: file.path, display: file.display, reason: file.reason });
    }
    return { willRestore, wontRestore };
  });
}
