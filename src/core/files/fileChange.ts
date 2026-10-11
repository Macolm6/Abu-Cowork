import { structuredPatch } from 'diff';
import type { FileChange, FileChangeHunk } from '@/types/fileChange';
import { normalizeSeparators } from '@/utils/pathUtils';

export type { FileChange, FileChangeHunk } from '@/types/fileChange';

/** Unchanged lines kept on each side of a change. */
export const DIFF_CONTEXT_LINES = 3;
/** A text larger than this (UTF-8 bytes) is not compared. */
export const MAX_COMPARABLE_TEXT_BYTES = 2 * 1024 * 1024;
/** Upper bound on the edit distance the line comparison searches. */
export const MAX_DIFF_EDIT_LENGTH = 1000;
/** Hunk lines saved with one file change. */
export const MAX_SAVED_DIFF_LINES = 400;
/** Characters saved per hunk line, not counting its marker. */
export const MAX_SAVED_LINE_CHARS = 500;
/** UTF-8 bytes of one serialized file change. */
export const MAX_FILE_CHANGE_BYTES = 64 * 1024;

export interface TextDiff {
  added: number;
  deleted: number;
  hunks: FileChangeHunk[];
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function isComparableText(text: string): boolean {
  if (text.includes('\u0000')) return false;
  if (text.length > MAX_COMPARABLE_TEXT_BYTES) return false;
  if (text.length * 3 <= MAX_COMPARABLE_TEXT_BYTES) return true;
  return utf8Length(text) <= MAX_COMPARABLE_TEXT_BYTES;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** A final newline ends the last line; it does not start an empty one. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function oneSidedDiff(marker: '+' | '-', text: string): TextDiff {
  const lines = splitLines(text);
  const isAddition = marker === '+';
  return {
    added: isAddition ? lines.length : 0,
    deleted: isAddition ? 0 : lines.length,
    hunks: [{
      oldStart: 1,
      oldLines: isAddition ? 0 : lines.length,
      newStart: 1,
      newLines: isAddition ? lines.length : 0,
      lines: lines.map((line) => marker + line),
    }],
  };
}

/**
 * Line comparison of two texts, CRLF read as LF. Returns null when a text is
 * over MAX_COMPARABLE_TEXT_BYTES, holds a NUL byte, or the two differ by more
 * than MAX_DIFF_EDIT_LENGTH edits. The hunks are complete; a caller that
 * stores or renders them applies its own limit.
 */
export function diffTexts(before: string, after: string): TextDiff | null {
  if (!isComparableText(before) || !isComparableText(after)) return null;
  const oldText = normalizeLineEndings(before);
  const newText = normalizeLineEndings(after);
  if (oldText === newText) return { added: 0, deleted: 0, hunks: [] };
  if (oldText === '') return oneSidedDiff('+', newText);
  if (newText === '') return oneSidedDiff('-', oldText);

  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, {
    context: DIFF_CONTEXT_LINES,
    maxEditLength: MAX_DIFF_EDIT_LENGTH,
  });
  if (!patch) return null;

  let added = 0;
  let deleted = 0;
  const hunks: FileChangeHunk[] = patch.hunks.map((hunk) => {
    // The "\ No newline at end of file" marker annotates the patch, not the text.
    const lines = hunk.lines.filter((line) => !line.startsWith('\\'));
    for (const line of lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) deleted++;
    }
    return {
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
    };
  });
  return { added, deleted, hunks };
}

function withLines(hunk: FileChangeHunk, lines: string[]): FileChangeHunk {
  return {
    oldStart: hunk.oldStart,
    oldLines: lines.filter((line) => !line.startsWith('+')).length,
    newStart: hunk.newStart,
    newLines: lines.filter((line) => !line.startsWith('-')).length,
    lines,
  };
}

/** Leading hunk lines within the line and per-line character budgets. */
function limitLines(hunks: FileChangeHunk[]): { hunks: FileChangeHunk[]; cut: boolean } {
  const kept: FileChangeHunk[] = [];
  let remaining = MAX_SAVED_DIFF_LINES;
  let cut = false;
  for (const hunk of hunks) {
    if (remaining === 0) {
      cut = true;
      break;
    }
    const taken = hunk.lines.slice(0, remaining);
    const lines = taken.map((line) => {
      if (line.length <= MAX_SAVED_LINE_CHARS + 1) return line;
      cut = true;
      return line.slice(0, MAX_SAVED_LINE_CHARS + 1);
    });
    remaining -= lines.length;
    if (taken.length < hunk.lines.length) {
      cut = true;
      kept.push(withLines(hunk, lines));
    } else {
      kept.push({ ...hunk, lines });
    }
  }
  return { hunks: kept, cut };
}

function serializedBytes(change: FileChange): number {
  return utf8Length(JSON.stringify(change));
}

/** Drops trailing hunk lines until the serialized change fits the byte budget. */
function limitBytes(change: FileChange): FileChange {
  let bytes = serializedBytes(change);
  if (bytes <= MAX_FILE_CHANGE_BYTES || !change.hunks) return change;

  const hunks = change.hunks.map((hunk) => ({ ...hunk, lines: [...hunk.lines] }));
  let result: FileChange = { ...change, hunks, cut: true };
  bytes = serializedBytes(result);
  while (bytes > MAX_FILE_CHANGE_BYTES && hunks.length > 0) {
    const last = hunks[hunks.length - 1];
    // Estimate while popping, then measure the real serialization once.
    while (bytes > MAX_FILE_CHANGE_BYTES && last.lines.length > 0) {
      const line = last.lines.pop() as string;
      bytes -= utf8Length(JSON.stringify(line)) + 1;
    }
    if (last.lines.length === 0) hunks.pop();
    else hunks[hunks.length - 1] = withLines(last, last.lines);
    result = hunks.length > 0 ? { ...result, hunks } : withoutHunks(result);
    bytes = serializedBytes(result);
  }
  return result;
}

function withoutHunks(change: FileChange): FileChange {
  const { hunks: _hunks, ...rest } = change;
  return rest;
}

/**
 * The change one file edit made. `before` is null when the file did not exist,
 * `after` is null when the file was deleted. When the texts cannot be compared
 * (see diffTexts) the result carries only `path` and `kind`.
 */
export function computeFileChange(input: {
  path: string;
  before: string | null;
  after: string | null;
}): FileChange {
  const kind: FileChange['kind'] = input.before === null ? 'create' : input.after === null ? 'delete' : 'modify';
  const base: FileChange = { path: normalizeSeparators(input.path), kind };
  const diff = diffTexts(input.before ?? '', input.after ?? '');
  if (!diff) return base;

  const counted: FileChange = { ...base, added: diff.added, deleted: diff.deleted };
  if (diff.hunks.length === 0) return counted;
  const limited = limitLines(diff.hunks);
  return limitBytes({
    ...counted,
    hunks: limited.hunks,
    ...(limited.cut ? { cut: true as const } : {}),
  });
}
