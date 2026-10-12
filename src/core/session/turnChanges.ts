/**
 * What one turn changed on disk.
 *
 * `beginTurn` lists the workspace, `captureBefore` keeps a file as it was
 * before the turn's first write to it, and `endTurn` compares both with the
 * disk and saves the result under the conversation directory:
 *
 *   {appData}/conversations/{convId}/changes/
 *   ├── index.json                 turns that changed something, with totals
 *   ├── {loopId}.json              one turn: its files, line counts and hunks
 *   └── {loopId}/
 *       ├── before/manifest.json   while the turn runs: captured paths and what each held
 *       ├── before/{pathHash}      the bytes one captured file held before the turn
 *       ├── undo.json              once settled: the files that can be restored
 *       └── after/{pathHash}       the bytes a file held when the turn was undone
 *
 * A settled turn keeps its directory only when it has a file to restore.
 *
 * Runs in the renderer. The user's files are read through the fs bridge, the
 * conversation directory through plugin-fs, as the rest of the conversation
 * storage does.
 */
import { exists, mkdir, readDir, readFile, readTextFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { appDataDir, homeDir } from '@tauri-apps/api/path';
import { exists as fileExists, readFile as readFileBytes, stat as fileStat } from '@/core/tools/fsBridge';
import { atomicWrite } from '@/utils/atomicFs';
import { diffTexts, MAX_COMPARABLE_TEXT_BYTES } from '@/core/files/fileChange';
import { utf8Length } from '@/core/files/fileChangeBudget';
import { listConversationWorkspaceFiles, type WorkspaceFileEntry } from '@/core/files/workspaceFiles';
import type { FileChangeHunk } from '@/types/fileChange';
import {
  assertConversationId,
  ConversationIdError,
  conversationIdRejection,
  createConversationPaths,
  joinConversationPath,
  type ConversationPaths,
} from './conversationPaths';
import {
  createTurnUndoRecord,
  isAbsoluteFilePath,
  parseTurnUndoRecord,
  pathHashOf,
  sha256Hex,
  type TurnUndoEntry,
  type TurnUndoRecord,
} from './turnUndoRecord';

/** Files kept in one saved turn; the rest are counted in `moreFiles`. */
export const MAX_TURN_FILES = 500;
/** A file larger than this on either side is listed without line counts. */
export const MAX_TURN_FILE_BYTES = MAX_COMPARABLE_TEXT_BYTES;
/** Hunk lines one saved turn holds. */
export const MAX_TURN_HUNK_LINES = 20000;
/** Serialized hunk bytes one saved turn holds. */
export const MAX_TURN_HUNK_BYTES = 5 * 1024 * 1024;

const FORMAT_VERSION = 1 as const;
const INDEX_FILENAME = 'index.json';
const BEFORE_DIRNAME = 'before';
const MANIFEST_FILENAME = 'manifest.json';
const UNDO_FILENAME = 'undo.json';

export interface TurnChangedFile {
  /** Absolute, '/' separators. */
  path: string;
  /** Relative to the workspace; '~/…' under home; absolute otherwise. */
  display: string;
  status: 'created' | 'modified' | 'deleted';
  /** Absent for a file without a line comparison. */
  added?: number;
  deleted?: number;
  hunks?: FileChangeHunk[];
}

export interface TurnChanges {
  loopId: string;
  /** Sorted by display path, at most MAX_TURN_FILES. */
  files: TurnChangedFile[];
  /** Changed files beyond the ones kept. */
  moreFiles?: number;
  /** Counts over every changed file, kept or not. */
  total: number;
  added: number;
  deleted: number;
}

export interface TurnIndexEntry {
  total: number;
  added: number;
  deleted: number;
  /** File name of the first file by display path. */
  firstFile: string;
  /** Files of the turn that can be restored; absent when there is none. */
  restorable?: number;
  /** True while the turn is undone. */
  undone?: boolean;
}

/** loopId → totals of a turn that changed at least one file. */
export type TurnIndex = Record<string, TurnIndexEntry>;

type BeforeState = 'file' | 'absent' | 'oversized';

interface ManifestEntry {
  path: string;
  hash: string;
  state: BeforeState;
}

interface BeforeManifest {
  version: typeof FORMAT_VERSION;
  loopId: string;
  workspaceRoots: string[];
  entries: ManifestEntry[];
}

interface TurnScope {
  conversationId: string;
  loopId: string;
  /** The conversation's workspace as it spells it; the list is requested for this folder. */
  workspacePath: string | null;
  /**
   * Spellings of the workspace a changed path may start with: the
   * conversation's own and, last, the one with links resolved.
   */
  workspaceRoots: string[];
  scopeId: string | undefined;
  /** The workspace list at the start; null when this turn compares no list. */
  baseline: WorkspaceFileEntry[] | null;
  /** Whether the conversation is still there. Nothing is written for one that is gone. */
  isConversationPresent: () => boolean;
}

interface OpenTurn extends TurnScope {
  /** Normalized path → its entry; null for a path that is claimed or holds no regular file. */
  captured: Map<string, ManifestEntry | null>;
  manifestWrites: Promise<void>;
}

type Side =
  | { state: 'absent' }
  | { state: 'oversized' }
  | { state: 'file'; bytes: Uint8Array };

type TurnChangesListener = (conversationId: string, loopId: string) => void;

const openTurns = new Map<string, OpenTurn>();
/** Every loop this run of the app opened. Recovery leaves their directories to `endTurn`. */
const turnsOfThisRun = new Set<string>();
/** Tail of the settle work queued per conversation. It never rejects: it orders work, it does not report it. */
const conversationWork = new Map<string, Promise<void>>();
const recoveries = new Map<string, Promise<void>>();
const listeners = new Set<TurnChangesListener>();

let cachedPaths: Promise<ConversationPaths> | null = null;
let cachedHome: Promise<string> | null = null;

function conversationPaths(): Promise<ConversationPaths> {
  cachedPaths ??= appDataDir().then(createConversationPaths);
  return cachedPaths;
}

function homeDirectory(): Promise<string> {
  cachedHome ??= homeDir().then(normalizeFilePath);
  return cachedHome;
}

function normalizeFilePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/**
 * A loop id names a directory and a file beside `index.json`, so it passes the
 * conversation-id grammar and is not the index's own stem.
 */
function loopIdRejection(loopId: unknown): string | null {
  const rejection = conversationIdRejection(loopId);
  if (rejection !== null) return rejection;
  return (loopId as string).toLowerCase() === 'index' ? 'reserved_sibling_name' : null;
}

function assertLoopId(loopId: unknown): asserts loopId is string {
  assertConversationId(loopId);
  if (loopId.toLowerCase() === 'index') throw new ConversationIdError('reserved_sibling_name');
}

async function changesDir(conversationId: string): Promise<string> {
  return (await conversationPaths()).changesDir(conversationId);
}

function turnFilePath(dir: string, loopId: string): string {
  return joinConversationPath(dir, `${loopId}.json`);
}

function turnDirPath(dir: string, loopId: string): string {
  return joinConversationPath(dir, loopId);
}

function beforeDirPath(dir: string, loopId: string): string {
  return joinConversationPath(dir, loopId, BEFORE_DIRNAME);
}

function undoRecordPath(dir: string, loopId: string): string {
  return joinConversationPath(dir, loopId, UNDO_FILENAME);
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Queues `task` behind the conversation's earlier settle work. The returned promise carries the task's own outcome. */
function enqueue(conversationId: string, task: () => Promise<void>): Promise<void> {
  const previous = conversationWork.get(conversationId) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(() => undefined, () => undefined);
  conversationWork.set(conversationId, tail);
  void tail.then(() => {
    if (conversationWork.get(conversationId) === tail) conversationWork.delete(conversationId);
  });
  return run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseManifest(text: string): BeforeManifest {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value)
    || value.version !== FORMAT_VERSION
    || typeof value.loopId !== 'string'
    || !Array.isArray(value.workspaceRoots)
    || !value.workspaceRoots.every((root: unknown) => typeof root === 'string' && isAbsoluteFilePath(root))
    || !Array.isArray(value.entries)
  ) {
    throw new Error('Turn changes manifest is not in the saved format');
  }
  const entries = value.entries.map((entry: unknown): ManifestEntry => {
    if (
      !isRecord(entry)
      || typeof entry.path !== 'string'
      || !isAbsoluteFilePath(entry.path)
      || typeof entry.hash !== 'string'
      || !/^[0-9a-f]{16}$/.test(entry.hash)
      || !(entry.state === 'file' || entry.state === 'absent' || entry.state === 'oversized')
    ) {
      throw new Error('Turn changes manifest entry is not in the saved format');
    }
    return { path: entry.path, hash: entry.hash, state: entry.state };
  });
  return { version: FORMAT_VERSION, loopId: value.loopId, workspaceRoots: value.workspaceRoots as string[], entries };
}

function parseTurnIndex(text: string): TurnIndex {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== FORMAT_VERSION || !isRecord(value.turns)) {
    throw new Error('Turn changes index is not in the saved format');
  }
  const index: TurnIndex = {};
  for (const [loopId, entry] of Object.entries(value.turns)) {
    if (
      !isRecord(entry)
      || !isCount(entry.total)
      || !isCount(entry.added)
      || !isCount(entry.deleted)
      || typeof entry.firstFile !== 'string'
      || !(entry.restorable === undefined || isCount(entry.restorable))
      || !(entry.undone === undefined || typeof entry.undone === 'boolean')
    ) {
      throw new Error('Turn changes index entry is not in the saved format');
    }
    index[loopId] = {
      total: entry.total,
      added: entry.added,
      deleted: entry.deleted,
      firstFile: entry.firstFile,
      ...(entry.restorable ? { restorable: entry.restorable } : {}),
      ...(entry.undone ? { undone: true } : {}),
    };
  }
  return index;
}

function parseTurnChanges(text: string): TurnChanges {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value)
    || typeof value.loopId !== 'string'
    || !Array.isArray(value.files)
    || !isCount(value.total)
    || !isCount(value.added)
    || !isCount(value.deleted)
    || !(value.moreFiles === undefined || isCount(value.moreFiles))
  ) {
    throw new Error('Turn changes file is not in the saved format');
  }
  for (const file of value.files as unknown[]) {
    if (
      !isRecord(file)
      || typeof file.path !== 'string'
      || typeof file.display !== 'string'
      || !(file.status === 'created' || file.status === 'modified' || file.status === 'deleted')
      || !(file.added === undefined || isCount(file.added))
      || !(file.deleted === undefined || isCount(file.deleted))
      || !(file.hunks === undefined || (Array.isArray(file.hunks) && file.hunks.every(isSavedHunk)))
    ) {
      throw new Error('Turn changes file entry is not in the saved format');
    }
  }
  return value as unknown as TurnChanges;
}

function isSavedHunk(value: unknown): value is FileChangeHunk {
  return isRecord(value)
    && isCount(value.oldStart)
    && isCount(value.oldLines)
    && isCount(value.newStart)
    && isCount(value.newLines)
    && Array.isArray(value.lines)
    && value.lines.every((line: unknown) => typeof line === 'string' && /^[ +-]/.test(line));
}

async function loadIndex(dir: string): Promise<TurnIndex> {
  const path = joinConversationPath(dir, INDEX_FILENAME);
  if (!(await exists(path))) return {};
  return parseTurnIndex(await readTextFile(path));
}

async function saveIndex(dir: string, index: TurnIndex): Promise<void> {
  await atomicWrite(joinConversationPath(dir, INDEX_FILENAME), JSON.stringify({ version: FORMAT_VERSION, turns: index }));
}

async function saveIndexEntry(dir: string, loopId: string, entry: TurnIndexEntry): Promise<void> {
  const index = await loadIndex(dir);
  index[loopId] = entry;
  await saveIndex(dir, index);
}

function fileNameOf(display: string): string {
  return display.slice(display.lastIndexOf('/') + 1);
}

/** What the index says about a turn's undo record. */
interface TurnUndoMarks {
  restorable: number;
  undone: boolean;
}

function undoMarksOf(record: TurnUndoRecord): TurnUndoMarks {
  return { restorable: record.entries.length, undone: record.state === 'undone' };
}

/** `entry` with the restorable count and undone mark of `marks`, or with neither. */
function withUndoMarks(entry: TurnIndexEntry, marks: TurnUndoMarks | null): TurnIndexEntry {
  return {
    total: entry.total,
    added: entry.added,
    deleted: entry.deleted,
    firstFile: entry.firstFile,
    ...(marks && marks.restorable > 0 ? { restorable: marks.restorable } : {}),
    ...(marks && marks.restorable > 0 && marks.undone ? { undone: true } : {}),
  };
}

function indexEntryOf(turn: TurnChanges, marks: TurnUndoMarks | null): TurnIndexEntry {
  return withUndoMarks(
    { total: turn.total, added: turn.added, deleted: turn.deleted, firstFile: fileNameOf(turn.files[0].display) },
    marks,
  );
}

function isInside(root: string, path: string): boolean {
  return path.startsWith(`${root}/`);
}

/** `absolute` relative to the workspace, or null when it is outside every spelling of it. */
function workspaceRelativePath(absolute: string, workspaceRoots: readonly string[]): string | null {
  for (const root of workspaceRoots) {
    if (isInside(root, absolute)) return absolute.slice(root.length + 1);
  }
  return null;
}

function displayPathOf(absolute: string, workspaceRoots: readonly string[], home: string): string {
  const relative = workspaceRelativePath(absolute, workspaceRoots);
  if (relative !== null) return relative;
  if (home && isInside(home, absolute)) return `~/${absolute.slice(home.length + 1)}`;
  return absolute;
}

function compareDisplay(a: { display: string }, b: { display: string }): number {
  return a.display < b.display ? -1 : a.display > b.display ? 1 : 0;
}

async function readCurrentSide(path: string): Promise<Side> {
  if (!(await fileExists(path))) return { state: 'absent' };
  const info = await fileStat(path);
  if (!info.isFile) return { state: 'absent' };
  if (info.size > MAX_TURN_FILE_BYTES) return { state: 'oversized' };
  const bytes = await readFileBytes(path);
  return bytes.length > MAX_TURN_FILE_BYTES ? { state: 'oversized' } : { state: 'file', bytes };
}

async function readBeforeSide(dir: string, loopId: string, entry: ManifestEntry): Promise<Side> {
  if (entry.state !== 'file') return { state: entry.state };
  return { state: 'file', bytes: await readFile(joinConversationPath(beforeDirPath(dir, loopId), entry.hash)) };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function decodeText(side: Side): string | null {
  if (side.state === 'absent') return '';
  if (side.state === 'oversized') return null;
  // ignoreBOM keeps a byte order mark as a character, as the file tools see it.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(side.bytes);
}

interface HunkBudget {
  lines: number;
  bytes: number;
}

function hunkLineCount(hunks: FileChangeHunk[]): number {
  return hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

/**
 * The entry of one captured path, or null when its content ends the turn as it
 * began. A file whose hunks do not fit in what is left of the turn's hunk
 * budget keeps its line counts and is saved without hunks.
 */
function compareSides(
  path: string,
  display: string,
  before: Side,
  after: Side,
  budget: HunkBudget,
): TurnChangedFile | null {
  if (before.state === 'absent' && after.state === 'absent') return null;
  if (before.state === 'file' && after.state === 'file' && sameBytes(before.bytes, after.bytes)) return null;
  const status: TurnChangedFile['status'] = before.state === 'absent' ? 'created' : after.state === 'absent' ? 'deleted' : 'modified';
  const uncounted: TurnChangedFile = { path, display, status };

  const beforeText = decodeText(before);
  const afterText = decodeText(after);
  if (beforeText === null || afterText === null) return uncounted;
  const diff = diffTexts(beforeText, afterText);
  if (!diff || diff.hunks.length === 0) return uncounted;

  const lines = hunkLineCount(diff.hunks);
  const bytes = utf8Length(JSON.stringify(diff.hunks));
  if (budget.lines + lines > MAX_TURN_HUNK_LINES || budget.bytes + bytes > MAX_TURN_HUNK_BYTES) {
    return { path, display, status, added: diff.added, deleted: diff.deleted };
  }
  budget.lines += lines;
  budget.bytes += bytes;
  return { path, display, status, added: diff.added, deleted: diff.deleted, hunks: diff.hunks };
}

/**
 * Files whose presence, size or modification time differs between two lists
 * of the workspace under `root`. `alreadyCompared` holds the workspace-relative
 * paths that were compared by content and are left out here.
 */
function compareWorkspaceLists(
  root: string,
  before: WorkspaceFileEntry[],
  after: WorkspaceFileEntry[],
  alreadyCompared: ReadonlySet<string>,
): TurnChangedFile[] {
  const changed: TurnChangedFile[] = [];
  const add = (relative: string, status: TurnChangedFile['status']): void => {
    if (alreadyCompared.has(relative)) return;
    changed.push({ path: `${root}/${relative}`, display: relative, status });
  };
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  for (const entry of after) {
    const earlier = beforeByPath.get(entry.path);
    if (!earlier) add(entry.path, 'created');
    else if (earlier.size !== entry.size || earlier.mtimeMs !== entry.mtimeMs) add(entry.path, 'modified');
    beforeByPath.delete(entry.path);
  }
  for (const relative of beforeByPath.keys()) add(relative, 'deleted');
  return changed;
}

function emitSaved(conversationId: string, loopId: string): void {
  for (const listener of [...listeners]) listener(conversationId, loopId);
}

/** The undo entry of a changed path, or null when either side is larger than a copy may be. */
async function undoEntryOf(entry: ManifestEntry, before: Side, after: Side): Promise<TurnUndoEntry | null> {
  if (before.state === 'oversized' || after.state === 'oversized') return null;
  return {
    path: entry.path,
    hash: entry.hash,
    before: before.state,
    after: after.state,
    ...(before.state === 'file' ? { beforeSha256: await sha256Hex(before.bytes) } : {}),
    ...(after.state === 'file' ? { afterSha256: await sha256Hex(after.bytes) } : {}),
  };
}

interface CapturedComparison {
  /** The captured paths that end the turn with other content than they began with, sorted by display path. */
  files: TurnChangedFile[];
  /** Those of them whose content before the turn is kept, in the same order. */
  restorable: TurnUndoEntry[];
}

async function compareCapturedFiles(dir: string, turn: TurnScope, entries: ManifestEntry[]): Promise<CapturedComparison> {
  const home = await homeDirectory();
  const budget: HunkBudget = { lines: 0, bytes: 0 };
  const files: TurnChangedFile[] = [];
  const restorable: TurnUndoEntry[] = [];
  const captured = entries
    .map((entry) => ({ entry, display: displayPathOf(entry.path, turn.workspaceRoots, home) }))
    .sort(compareDisplay);
  for (let i = 0; i < captured.length; i++) {
    if (i > 0) await yieldToMainThread();
    const { entry, display } = captured[i];
    const before = await readBeforeSide(dir, turn.loopId, entry);
    const after = await readCurrentSide(entry.path);
    const file = compareSides(entry.path, display, before, after, budget);
    if (!file) continue;
    files.push(file);
    const undoEntry = await undoEntryOf(entry, before, after);
    if (undoEntry) restorable.push(undoEntry);
  }
  return { files, restorable };
}

/**
 * The files the workspace list shows as changed since the turn began, without
 * the captured paths. Empty for a turn without a baseline and for a list over
 * the limit. Rejects when the list request fails.
 */
async function compareWorkspaceWithBaseline(turn: TurnScope, entries: ManifestEntry[]): Promise<TurnChangedFile[]> {
  if (!turn.workspacePath || !turn.baseline) return [];
  const current = await listConversationWorkspaceFiles(turn.conversationId, turn.workspacePath, turn.scopeId);
  if (current.exceeded) return [];
  const compared = new Set<string>();
  for (const entry of entries) {
    const relative = workspaceRelativePath(entry.path, turn.workspaceRoots);
    if (relative !== null) compared.add(relative);
  }
  return compareWorkspaceLists(current.root, turn.baseline, current.files, compared);
}

async function saveTurn(dir: string, loopId: string, changed: TurnChangedFile[], marks: TurnUndoMarks | null): Promise<void> {
  const files = [...changed].sort(compareDisplay);
  const kept = files.slice(0, MAX_TURN_FILES);
  const saved: TurnChanges = {
    loopId,
    files: kept,
    ...(files.length > kept.length ? { moreFiles: files.length - kept.length } : {}),
    total: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
  };
  await atomicWrite(turnFilePath(dir, loopId), JSON.stringify(saved));
  await saveIndexEntry(dir, loopId, indexEntryOf(saved, marks));
}

/**
 * Leaves in a turn's before directory only the copies its record names: the
 * manifest and the copies of the other captured files are removed, and the
 * directory itself when no copy is left.
 */
async function pruneBeforeCopies(dir: string, loopId: string, record: TurnUndoRecord): Promise<void> {
  const beforeDir = beforeDirPath(dir, loopId);
  if (!(await exists(beforeDir))) return;
  const kept = new Set(record.entries.filter((entry) => entry.before === 'file').map((entry) => entry.hash));
  for (const item of await readDir(beforeDir)) {
    if (!kept.has(item.name)) await remove(joinConversationPath(beforeDir, item.name), { recursive: true });
  }
  if (kept.size === 0) await remove(beforeDir, { recursive: true });
}

/**
 * Settles a turn in two steps. First the captured paths are compared with the
 * disk and the result is saved; a turn with files to restore keeps their
 * before copies beside its undo record, any other turn loses its directory.
 * Then, with a baseline, the workspace is listed and the files only the list
 * shows are saved together with the first ones. When the list request fails
 * this rejects, and the result of the first step stays saved. A turn whose
 * conversation is gone writes nothing.
 */
async function settleTurn(turn: TurnScope, entries: ManifestEntry[]): Promise<void> {
  if (!turn.isConversationPresent()) return;
  const dir = await changesDir(turn.conversationId);
  const { files: captured, restorable } = await compareCapturedFiles(dir, turn, entries);
  if (!turn.isConversationPresent()) return;
  const record = restorable.length > 0 ? createTurnUndoRecord(turn.loopId, restorable) : null;
  const marks = record ? undoMarksOf(record) : null;
  if (captured.length > 0) await saveTurn(dir, turn.loopId, captured, marks);
  if (record) {
    await atomicWrite(undoRecordPath(dir, turn.loopId), JSON.stringify(record));
    await pruneBeforeCopies(dir, turn.loopId, record);
  } else {
    await removeTurnDir(dir, turn.loopId);
  }
  if (captured.length > 0) emitSaved(turn.conversationId, turn.loopId);

  const listed = await compareWorkspaceWithBaseline(turn, entries);
  if (!turn.isConversationPresent()) return;
  if (listed.length > 0) await saveTurn(dir, turn.loopId, [...captured, ...listed], marks);
  if (listed.length > 0 || captured.length === 0) emitSaved(turn.conversationId, turn.loopId);
}

async function removeTurnDir(dir: string, loopId: string): Promise<void> {
  const turnDir = turnDirPath(dir, loopId);
  if (await exists(turnDir)) await remove(turnDir, { recursive: true });
}

async function loadUndoRecord(dir: string, loopId: string): Promise<TurnUndoRecord | null> {
  const path = undoRecordPath(dir, loopId);
  if (!(await exists(path))) return null;
  const record = await parseTurnUndoRecord(await readTextFile(path));
  if (record.loopId !== loopId) throw new Error('Turn undo record belongs to another turn');
  return record;
}

function writeManifest(turn: OpenTurn): Promise<void> {
  const write = turn.manifestWrites.then(async () => {
    const dir = await changesDir(turn.conversationId);
    const manifest: BeforeManifest = {
      version: FORMAT_VERSION,
      loopId: turn.loopId,
      workspaceRoots: turn.workspaceRoots,
      entries: [...turn.captured.values()].filter((entry): entry is ManifestEntry => entry !== null),
    };
    await atomicWrite(joinConversationPath(beforeDirPath(dir, turn.loopId), MANIFEST_FILENAME), JSON.stringify(manifest));
  });
  turn.manifestWrites = write.then(() => undefined, () => undefined);
  return write;
}

/**
 * Opens a turn. Waits for the conversation's previous turn to settle, then
 * lists the workspace. A conversation without a workspace, and a workspace over
 * the list limit, get no list comparison. When the list request fails this
 * rejects; the turn stays open without a baseline, so captures still work.
 * `options.isConversationPresent` answers whether the conversation still
 * exists; once it says no, the turn writes nothing more.
 */
export async function beginTurn(
  conversationId: string,
  loopId: string,
  workspacePath: string | null | undefined,
  options?: { scopeId?: string; isConversationPresent?: () => boolean },
): Promise<void> {
  assertConversationId(conversationId);
  assertLoopId(loopId);
  await (conversationWork.get(conversationId) ?? Promise.resolve());
  if (openTurns.has(loopId)) return;
  const folder = workspacePath ? normalizeFilePath(workspacePath) : null;
  const turn: OpenTurn = {
    conversationId,
    loopId,
    workspacePath: folder,
    workspaceRoots: folder ? [folder] : [],
    scopeId: options?.scopeId,
    baseline: null,
    isConversationPresent: options?.isConversationPresent ?? (() => true),
    captured: new Map(),
    manifestWrites: Promise.resolve(),
  };
  openTurns.set(loopId, turn);
  turnsOfThisRun.add(loopId);
  if (!folder) return;
  const list = await listConversationWorkspaceFiles(conversationId, folder, turn.scopeId);
  if (list.root !== folder) turn.workspaceRoots = [folder, list.root];
  if (!list.exceeded) turn.baseline = list.files;
}

/**
 * Keeps `absolutePath` as it is now, on the turn's first call for that path:
 * the bytes of a file up to MAX_TURN_FILE_BYTES, or the fact that it is absent
 * or larger. Call it before the write. A loop that is not open is ignored.
 */
export async function captureBefore(loopId: string, absolutePath: string): Promise<void> {
  const turn = openTurns.get(loopId);
  if (!turn || !turn.isConversationPresent()) return;
  const path = normalizeFilePath(absolutePath);
  if (!isAbsoluteFilePath(path) || turn.captured.has(path)) return;
  turn.captured.set(path, null);
  try {
    const side = await readCurrentBeforeWrite(path);
    if (side === null) return;
    const hash = await pathHashOf(path);
    if (side.state === 'file') {
      const beforeDir = beforeDirPath(await changesDir(turn.conversationId), loopId);
      await mkdir(beforeDir, { recursive: true });
      await writeFile(joinConversationPath(beforeDir, hash), side.bytes);
    }
    turn.captured.set(path, { path, hash, state: side.state });
    await writeManifest(turn);
  } catch (error) {
    // Released so the next write to this path captures it.
    turn.captured.delete(path);
    throw error;
  }
}

/** What `path` holds, or null when it is neither absent nor a regular file. */
async function readCurrentBeforeWrite(path: string): Promise<Side | null> {
  if (!(await fileExists(path))) return { state: 'absent' };
  const info = await fileStat(path);
  if (!info.isFile) return null;
  if (info.size > MAX_TURN_FILE_BYTES) return { state: 'oversized' };
  const bytes = await readFileBytes(path);
  return bytes.length > MAX_TURN_FILE_BYTES ? { state: 'oversized' } : { state: 'file', bytes };
}

/**
 * Closes a turn and settles it behind the conversation's earlier settle work.
 * Resolves once the result is saved. A loop that is not open is ignored.
 * `options.workspacePath` is the conversation's workspace now; a turn that
 * began without one shows its paths relative to it.
 */
export function endTurn(loopId: string, options?: { workspacePath?: string | null }): Promise<void> {
  const turn = openTurns.get(loopId);
  if (!turn) return Promise.resolve();
  openTurns.delete(loopId);
  if (turn.workspaceRoots.length === 0 && options?.workspacePath) {
    turn.workspaceRoots = [normalizeFilePath(options.workspacePath)];
  }
  return enqueue(turn.conversationId, async () => {
    await turn.manifestWrites;
    const entries = [...turn.captured.values()].filter((entry): entry is ManifestEntry => entry !== null);
    await settleTurn(turn, entries);
  });
}

/**
 * Settles what an earlier run of the app left behind in a conversation. A
 * turn directory beside a saved result stays as it is when it holds an undo
 * record and is removed otherwise; one with a manifest and no saved result is
 * compared with the disk as it is now and saved; any other is removed. The
 * index ends up naming a restorable count exactly for the turns whose record
 * is on disk.
 */
async function recoverInterruptedTurns(conversationId: string): Promise<void> {
  const dir = await changesDir(conversationId);
  if (!(await exists(dir))) return;
  const settledMarks = new Map<string, TurnUndoMarks>();
  for (const entry of await readDir(dir)) {
    if (!entry.isDirectory || loopIdRejection(entry.name) !== null || turnsOfThisRun.has(entry.name)) continue;
    const loopId = entry.name;
    const savedPath = turnFilePath(dir, loopId);
    if (await exists(savedPath)) {
      const saved = parseTurnChanges(await readTextFile(savedPath));
      const record = saved.files.length > 0 ? await loadUndoRecord(dir, loopId) : null;
      const marks = record && record.entries.length > 0 ? undoMarksOf(record) : null;
      const index = await loadIndex(dir);
      if (!index[loopId] && saved.files.length > 0) await saveIndexEntry(dir, loopId, indexEntryOf(saved, marks));
      if (record && marks) {
        await pruneBeforeCopies(dir, loopId, record);
        settledMarks.set(loopId, marks);
      } else {
        await removeTurnDir(dir, loopId);
      }
      continue;
    }
    const manifestPath = joinConversationPath(beforeDirPath(dir, loopId), MANIFEST_FILENAME);
    if (!(await exists(manifestPath))) {
      await removeTurnDir(dir, loopId);
      continue;
    }
    const manifest = parseManifest(await readTextFile(manifestPath));
    await settleTurn(
      {
        conversationId,
        loopId,
        workspacePath: null,
        workspaceRoots: manifest.workspaceRoots,
        scopeId: undefined,
        baseline: null,
        isConversationPresent: () => true,
      },
      manifest.entries,
    );
    const record = await loadUndoRecord(dir, loopId);
    if (record && record.entries.length > 0) settledMarks.set(loopId, undoMarksOf(record));
  }

  const index = await loadIndex(dir);
  let changed = false;
  for (const [loopId, entry] of Object.entries(index)) {
    if (turnsOfThisRun.has(loopId)) continue;
    const marks = settledMarks.get(loopId);
    if (entry.restorable === marks?.restorable && Boolean(entry.undone) === Boolean(marks?.undone)) continue;
    index[loopId] = withUndoMarks(entry, marks ?? null);
    changed = true;
  }
  if (changed) await saveIndex(dir, index);
}

function ensureRecovered(conversationId: string): Promise<void> {
  const running = recoveries.get(conversationId);
  if (running) return running;
  const recovery = enqueue(conversationId, () => recoverInterruptedTurns(conversationId));
  recoveries.set(conversationId, recovery);
  // A failed recovery runs again on the next read.
  void recovery.then(undefined, () => {
    if (recoveries.get(conversationId) === recovery) recoveries.delete(conversationId);
  });
  return recovery;
}

/**
 * The turns of a conversation that changed files. The first read of a
 * conversation in a run of the app settles the turns an earlier run left open.
 */
export async function readTurnIndex(conversationId: string): Promise<TurnIndex> {
  assertConversationId(conversationId);
  await ensureRecovered(conversationId);
  return loadIndex(await changesDir(conversationId));
}

/** One saved turn, or null when that turn changed nothing. */
export async function readTurnChanges(conversationId: string, loopId: string): Promise<TurnChanges | null> {
  assertConversationId(conversationId);
  assertLoopId(loopId);
  const path = turnFilePath(await changesDir(conversationId), loopId);
  if (!(await exists(path))) return null;
  const saved = parseTurnChanges(await readTextFile(path));
  if (saved.loopId !== loopId) throw new Error('Turn changes file belongs to another turn');
  return saved;
}

/** The undo record of a settled turn, or null for a turn that has no file to restore. */
export async function readTurnUndoRecord(conversationId: string, loopId: string): Promise<TurnUndoRecord | null> {
  assertConversationId(conversationId);
  assertLoopId(loopId);
  return loadUndoRecord(await changesDir(conversationId), loopId);
}

/**
 * Called each time a turn's result is saved, which a turn with files from both
 * of its settle steps does twice, and once for a turn that changed no file.
 */
export function onTurnChangesSaved(listener: TurnChangesListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
