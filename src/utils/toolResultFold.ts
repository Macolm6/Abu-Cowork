import { CHARS_OMITTED_LINE, LINES_OMITTED_LINE } from '@/core/context/truncation';
import { DURABLE_RESULT_OMITTED_NOTE } from '@/core/session/durableToolResultContent';

/** Appended by electron/commandHost.cjs when a command's output passes its 2 MB buffer. */
export const COMMAND_OUTPUT_CUT_NOTE = '[truncated: output too large]';

/**
 * `restNotKept`: the command host dropped the end of the output.
 * `partNotSaved`: the conversation record ran out of room for this call; that
 * note also marks a call whose images were dropped with its text whole.
 */
export type ToolResultNoteKind = 'linesNotRead' | 'charsNotRead' | 'restNotKept' | 'partNotSaved';

export type ToolResultRow =
  | { kind: 'text'; text: string }
  | { kind: 'note'; note: ToolResultNoteKind; count?: number };

export interface RowFold<T> {
  rows: T[];
  head: T[];
  tail: T[];
  /** What the fold leaves out, or null when the rows show whole. */
  hidden: null | { unit: 'lines' | 'chars'; count: number };
}

export type ToolResultFold = RowFold<ToolResultRow>;

const HEAD_ROWS = 5;
const TAIL_ROWS = 4;
const MAX_CHARS = 1000;
const HEAD_CHARS = 700;
const TAIL_CHARS = 300;

function noteOf(line: string): ToolResultRow | null {
  const lines = LINES_OMITTED_LINE.exec(line);
  if (lines) return { kind: 'note', note: 'linesNotRead', count: Number(lines[1]) };
  const chars = CHARS_OMITTED_LINE.exec(line);
  if (chars) return { kind: 'note', note: 'charsNotRead', count: Number(chars[1]) };
  if (line === COMMAND_OUTPUT_CUT_NOTE) return { kind: 'note', note: 'restNotKept' };
  if (line === DURABLE_RESULT_OMITTED_NOTE) return { kind: 'note', note: 'partNotSaved' };
  return null;
}

/**
 * A tool result as rows: its own lines, and one note row for each line Abu's
 * code wrote where content was left out. The blank line written on each side
 * of such a line belongs to the note.
 */
export function toResultRows(text: string): ToolResultRow[] {
  const lines = text.split('\n');
  const rows: ToolResultRow[] = [];
  for (let index = 0; index < lines.length; index++) {
    const note = noteOf(lines[index]);
    if (!note) {
      rows.push({ kind: 'text', text: lines[index] });
      continue;
    }
    const previous = rows.at(-1);
    if (previous?.kind === 'text' && previous.text === '') rows.pop();
    if (lines[index + 1] === '') index++;
    rows.push(note);
  }
  return rows;
}

function textLength(row: ToolResultRow): number {
  return row.kind === 'text' ? Array.from(row.text).length : 0;
}

/** Rows from one end of `rows` holding `budget` characters of text, the last one cut between code points. */
function takeChars(rows: ToolResultRow[], budget: number, from: 'start' | 'end'): ToolResultRow[] {
  const ordered = from === 'start' ? rows : [...rows].reverse();
  const taken: ToolResultRow[] = [];
  let left = budget;
  for (const row of ordered) {
    if (row.kind === 'note') {
      taken.push(row);
      continue;
    }
    const chars = Array.from(row.text);
    if (chars.length <= left) {
      taken.push(row);
      left -= chars.length;
      continue;
    }
    const part = from === 'start' ? chars.slice(0, left) : chars.slice(chars.length - left);
    taken.push({ kind: 'text', text: part.join('') });
    break;
  }
  return from === 'start' ? taken : taken.reverse();
}

/**
 * How a list of rows shows before the user asks for all of it: past nine rows
 * the first five and the last four. The count is the rows `countsAsLine` keeps.
 */
export function foldRowList<T>(rows: readonly T[], countsAsLine: (row: T) => boolean): RowFold<T> {
  const all = [...rows];
  if (all.length > HEAD_ROWS + TAIL_ROWS) {
    const count = all.filter(countsAsLine).length;
    return { rows: all, head: all.slice(0, HEAD_ROWS), tail: all.slice(all.length - TAIL_ROWS), hidden: { unit: 'lines', count } };
  }
  return { rows: all, head: all, tail: [], hidden: null };
}

/**
 * How a tool result shows before the user asks for all of it: the rows fold
 * as `foldRowList` folds them; on fewer rows past 1000 characters the first
 * 700 and the last 300. The count is what Abu read, notes left out.
 */
export function foldToolResult(text: string): ToolResultFold {
  const rows = toResultRows(text);
  const byRows = foldRowList(rows, (row) => row.kind === 'text');
  if (byRows.hidden) return byRows;
  const count = rows.reduce((total, row) => total + textLength(row), 0);
  if (count > MAX_CHARS) {
    return {
      rows,
      head: takeChars(rows, HEAD_CHARS, 'start'),
      tail: takeChars(rows, TAIL_CHARS, 'end'),
      hidden: { unit: 'chars', count },
    };
  }
  return { rows, head: rows, tail: [], hidden: null };
}
