import type { FileChange, FileChangeHunk } from '@/types/fileChange';

// The saved size of a file change, and the checks that hold a change to it.
// This module imports types only, so the conversation writer can bundle it.

/** Hunk lines saved with one file change. */
export const MAX_SAVED_DIFF_LINES = 400;
/** Characters saved per hunk line, not counting its marker. */
export const MAX_SAVED_LINE_CHARS = 500;
/** UTF-8 bytes of one serialized file change. */
export const MAX_FILE_CHANGE_BYTES = 64 * 1024;
/** Characters of the path a received file change may carry. */
export const MAX_FILE_CHANGE_PATH_CHARS = 4096;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

export function serializedFileChangeBytes(change: FileChange): number {
  return utf8Length(JSON.stringify(change));
}

/** The change with its hunks dropped; `cut` records that there were some. */
export function fileChangeWithoutHunks(change: FileChange): FileChange {
  const { hunks, ...rest } = change;
  return hunks === undefined ? rest : { ...rest, cut: true };
}

function isLineCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseHunks(value: unknown): FileChangeHunk[] | null {
  if (!Array.isArray(value)) return null;
  const hunks: FileChangeHunk[] = [];
  let lineCount = 0;
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const { oldStart, oldLines, newStart, newLines, lines } = item as Record<string, unknown>;
    if (!isLineCount(oldStart) || !isLineCount(oldLines) || !isLineCount(newStart) || !isLineCount(newLines)) {
      return null;
    }
    if (!Array.isArray(lines)) return null;
    lineCount += lines.length;
    if (lineCount > MAX_SAVED_DIFF_LINES) return null;
    for (const line of lines) {
      if (typeof line !== 'string' || line.length > MAX_SAVED_LINE_CHARS + 1) return null;
      if (!line.startsWith(' ') && !line.startsWith('+') && !line.startsWith('-')) return null;
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: [...(lines as string[])] });
  }
  return hunks;
}

/**
 * A file change received as untyped data: a copy holding only the known
 * fields, or null when a field has the wrong type or the change is over the
 * saved budget (lines, characters per line, serialized bytes).
 */
export function parseFileChange(value: unknown): FileChange | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { path, kind, added, deleted, hunks, cut } = value as Record<string, unknown>;
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_FILE_CHANGE_PATH_CHARS) return null;
  if (kind !== 'create' && kind !== 'modify' && kind !== 'delete') return null;
  const change: FileChange = { path, kind };
  if (added !== undefined) {
    if (!isLineCount(added)) return null;
    change.added = added;
  }
  if (deleted !== undefined) {
    if (!isLineCount(deleted)) return null;
    change.deleted = deleted;
  }
  if (hunks !== undefined) {
    const parsed = parseHunks(hunks);
    if (!parsed) return null;
    change.hunks = parsed;
  }
  if (cut !== undefined) {
    if (cut !== true) return null;
    change.cut = true;
  }
  return serializedFileChangeBytes(change) <= MAX_FILE_CHANGE_BYTES ? change : null;
}
