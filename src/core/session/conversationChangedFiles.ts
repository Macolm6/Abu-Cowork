/**
 * The files a whole conversation changed, from the file lists of its turns.
 *
 * A file is listed once. Its status compares the state before its first
 * change with the state after its last: absent then present is created,
 * present both times is modified, present then absent is deleted, and a file
 * absent both times (created, then deleted) is left out. An undone turn takes
 * no part.
 */
import type { FileChange } from '@/types/fileChange';
import { normalizeSeparators } from '@/utils/pathUtils';
import type { TurnIndexFile } from './turnChanges';

export type ConversationFileStatus = 'created' | 'modified' | 'deleted';

export interface ConversationTurn {
  loopId: string;
  /** The user message that started the turn: one line, and its time. */
  prompt: string;
  at: number;
  files: TurnIndexFile[];
  undone: boolean;
}

export interface ConversationChangedFile {
  path: string;
  display: string;
  status: ConversationFileStatus;
  /** Turns that changed the file, latest first, with the file's index in each turn's list. */
  turns: { loopId: string; prompt: string; at: number; fileIndex: number }[];
}

export interface RunningTurnChanges {
  loopId: string;
  prompt: string;
  at: number;
  changes: FileChange[];
}

const EXISTS_BEFORE: Record<ConversationFileStatus, boolean> = { created: false, modified: true, deleted: true };
const EXISTS_AFTER: Record<ConversationFileStatus, boolean> = { created: true, modified: true, deleted: false };
const STATUS_OF_KIND: Record<FileChange['kind'], ConversationFileStatus> = { create: 'created', modify: 'modified', delete: 'deleted' };

function pathKey(path: string): string {
  const slashed = normalizeSeparators(path);
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

interface Collected {
  path: string;
  display: string;
  existedBefore: boolean;
  existsAfter: boolean;
  /** Position of the latest turn that changed the file. */
  lastTurn: number;
  turns: ConversationChangedFile['turns'];
}

/** `turns` in conversation order; `running` is the turn in progress, from its tool calls. */
export function collectConversationChangedFiles(
  turns: ConversationTurn[],
  running: RunningTurnChanges | null,
): ConversationChangedFile[] {
  const sources: ConversationTurn[] = turns.filter((item) => !item.undone);
  if (running && !turns.some((item) => item.loopId === running.loopId)) {
    sources.push({ loopId: running.loopId, prompt: running.prompt, at: running.at, files: runningFiles(running.changes), undone: false });
  }

  const byKey = new Map<string, Collected>();
  sources.forEach((source, position) => {
    source.files.forEach((item, fileIndex) => {
      const key = pathKey(item.path);
      const seen = byKey.get(key);
      const step = { loopId: source.loopId, prompt: source.prompt, at: source.at, fileIndex };
      if (!seen) {
        byKey.set(key, {
          path: item.path,
          display: item.display,
          existedBefore: EXISTS_BEFORE[item.status],
          existsAfter: EXISTS_AFTER[item.status],
          lastTurn: position,
          turns: [step],
        });
        return;
      }
      seen.path = item.path;
      seen.display = item.display;
      seen.existsAfter = EXISTS_AFTER[item.status];
      seen.lastTurn = position;
      seen.turns.unshift(step);
    });
  });

  const listed: Array<ConversationChangedFile & { lastTurn: number }> = [];
  for (const item of byKey.values()) {
    if (!item.existedBefore && !item.existsAfter) continue;
    const status: ConversationFileStatus = !item.existedBefore ? 'created' : item.existsAfter ? 'modified' : 'deleted';
    listed.push({ path: item.path, display: item.display, status, turns: item.turns, lastTurn: item.lastTurn });
  }
  listed.sort((a, b) => b.lastTurn - a.lastTurn || (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
  return listed.map(({ lastTurn: _lastTurn, ...entry }) => entry);
}

/**
 * The file list of the running turn: one entry per path, marked by the state
 * before its first change and after its last, sorted by path. A path shows as
 * itself until the turn is saved.
 */
function runningFiles(changes: FileChange[]): TurnIndexFile[] {
  const byKey = new Map<string, { path: string; existedBefore: boolean; existsAfter: boolean }>();
  for (const item of changes) {
    const status = STATUS_OF_KIND[item.kind];
    const key = pathKey(item.path);
    const seen = byKey.get(key);
    if (seen) seen.existsAfter = EXISTS_AFTER[status];
    else byKey.set(key, { path: item.path, existedBefore: EXISTS_BEFORE[status], existsAfter: EXISTS_AFTER[status] });
  }
  const files: TurnIndexFile[] = [];
  for (const item of byKey.values()) {
    if (!item.existedBefore && !item.existsAfter) continue;
    const status: ConversationFileStatus = !item.existedBefore ? 'created' : item.existsAfter ? 'modified' : 'deleted';
    files.push({ path: item.path, display: item.path, status });
  }
  return files.sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
}
