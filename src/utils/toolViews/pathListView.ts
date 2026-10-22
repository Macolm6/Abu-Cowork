import { toResultRows, type ToolResultNoteKind, type ToolResultRow } from '@/utils/toolResultFold';

export type PathListHeader =
  | { kind: 'files'; count: number }
  | { kind: 'entries'; count: number }
  | { kind: 'empty' };

export type PathListRow =
  | { kind: 'path'; path: string }
  | { kind: 'entry'; name: string; directory: boolean }
  | { kind: 'note'; note: ToolResultNoteKind; count?: number };

export interface PathListView { header: PathListHeader; rows: PathListRow[] }

const FOUND_FILES = /^Found (\d+)\+? files:$/;
const NO_FILES = 'No files found matching the pattern.';
const EMPTY_DIRECTORY = /^Directory ".*" is empty\.$/;
const ENTRY_LINE = /^\[(DIR|FILE)\] (.*)$/;

function noteRow(row: Extract<ToolResultRow, { kind: 'note' }>): PathListRow {
  return row.count === undefined ? { kind: 'note', note: row.note } : { kind: 'note', note: row.note, count: row.count };
}

/** A find_files result as its file count and one row per path. */
export function parseFindResult(text: string): PathListView {
  let count = 0;
  const rows: PathListRow[] = [];
  for (const row of toResultRows(text)) {
    if (row.kind === 'note') {
      rows.push(noteRow(row));
      continue;
    }
    const head = FOUND_FILES.exec(row.text);
    if (head) {
      count = Number(head[1]);
      continue;
    }
    if (row.text === NO_FILES || row.text === '') continue;
    rows.push({ kind: 'path', path: row.text });
  }
  return { header: { kind: 'files', count }, rows };
}

/** A list_directory result as one row per entry, each with its kind. */
export function parseListDirectoryResult(text: string): PathListView {
  if (EMPTY_DIRECTORY.test(text)) return { header: { kind: 'empty' }, rows: [] };
  const rows: PathListRow[] = [];
  let count = 0;
  for (const row of toResultRows(text)) {
    if (row.kind === 'note') {
      rows.push(noteRow(row));
      continue;
    }
    const entry = ENTRY_LINE.exec(row.text);
    if (!entry) continue;
    rows.push({ kind: 'entry', name: entry[2], directory: entry[1] === 'DIR' });
    count++;
  }
  return { header: { kind: 'entries', count }, rows };
}
