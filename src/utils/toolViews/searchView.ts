import { toResultRows, type ToolResultNoteKind } from '@/utils/toolResultFold';

export type SearchHeader =
  | { kind: 'count'; matches: number; files: number }
  | { kind: 'capped'; matches: number }
  | { kind: 'none' };

export type SearchRow =
  | { kind: 'match'; path: string; line: number; text: string }
  | { kind: 'note'; note: ToolResultNoteKind; count?: number };

export interface SearchView { header: SearchHeader; rows: SearchRow[] }

export type SearchSegment =
  | { kind: 'group'; path: string; count: number; rows: Extract<SearchRow, { kind: 'match' }>[] }
  | { kind: 'note'; note: ToolResultNoteKind; count?: number };

const HEADER_LINE = /^Found (\d+)(\+?) matches:$/;
const NO_MATCHES = 'No matches found.';
const MATCH_LINE = /^(.*?):(\d+):(.*)$/;

/** A search_files result as its header and its match lines; lines of another shape are left out. */
export function parseSearchResult(text: string): SearchView {
  const rows: SearchRow[] = [];
  let found: { matches: number; capped: boolean } | null = null;
  for (const row of toResultRows(text)) {
    if (row.kind === 'note') {
      rows.push(row.count === undefined ? { kind: 'note', note: row.note } : { kind: 'note', note: row.note, count: row.count });
      continue;
    }
    const head = HEADER_LINE.exec(row.text);
    if (head) {
      found = { matches: Number(head[1]), capped: head[2] === '+' };
      continue;
    }
    if (row.text === NO_MATCHES) continue;
    const line = MATCH_LINE.exec(row.text);
    if (line) rows.push({ kind: 'match', path: line[1], line: Number(line[2]), text: line[3] });
  }
  if (!found) return { header: { kind: 'none' }, rows };
  if (found.capped) return { header: { kind: 'capped', matches: found.matches }, rows };
  const files = new Set(rows.flatMap((row) => (row.kind === 'match' ? [row.path] : []))).size;
  return { header: { kind: 'count', matches: found.matches, files }, rows };
}

/** Visible rows regrouped by file; `count` is the file's matches in all of `all`. */
export function groupSearchRows(visible: readonly SearchRow[], all: readonly SearchRow[]): SearchSegment[] {
  const segments: SearchSegment[] = [];
  for (const row of visible) {
    if (row.kind === 'note') {
      segments.push(row);
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === 'group' && last.path === row.path) {
      last.rows.push(row);
      continue;
    }
    const count = all.filter((other) => other.kind === 'match' && other.path === row.path).length;
    segments.push({ kind: 'group', path: row.path, count, rows: [row] });
  }
  return segments;
}
