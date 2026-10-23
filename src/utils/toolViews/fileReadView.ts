import type { FileReadOutcome } from '@/types';
import { toResultRows, type ToolResultNoteKind, type ToolResultRow } from '@/utils/toolResultFold';

export type FileReadHeader =
  | { kind: 'all'; count: number }
  | { kind: 'range'; start: number; end: number; total: number };

export type NumberedRow =
  | { kind: 'line'; number: number | null; text: string }
  | { kind: 'note'; note: ToolResultNoteKind; count?: number };

export interface FileReadView {
  header: FileReadHeader | null;
  /** Lines with numbers; null for a document, a notice or a step without a record. */
  numbered: NumberedRow[] | null;
  plain: ToolResultRow[] | null;
}

function noteRow(row: Extract<ToolResultRow, { kind: 'note' }>): NumberedRow {
  return row.count === undefined ? { kind: 'note', note: row.note } : { kind: 'note', note: row.note, count: row.count };
}

/**
 * Line numbers for the rows of a text read. Rows count up from the first line
 * read, a lines-not-read note skips its count. After a chars-not-read note the
 * lines cut away are unknown, so the rows after the last such note count down
 * from the last line read, or carry no number when the end was not saved.
 */
function numberRows(rows: ToolResultRow[], firstLine: number, lastLine: number): NumberedRow[] {
  let lastCharsNote = -1;
  rows.forEach((row, index) => {
    if (row.kind === 'note' && row.note === 'charsNotRead') lastCharsNote = index;
  });
  const endSaved = !rows.some((row) => row.kind === 'note' && row.note === 'partNotSaved');
  const numbered: NumberedRow[] = new Array(rows.length);

  const forwardEnd = lastCharsNote === -1 ? rows.length : lastCharsNote + 1;
  let next = firstLine;
  for (let index = 0; index < forwardEnd; index++) {
    const row = rows[index];
    if (row.kind === 'note') {
      if (row.note === 'linesNotRead') next += row.count ?? 0;
      numbered[index] = noteRow(row);
      continue;
    }
    numbered[index] = { kind: 'line', number: next, text: row.text };
    next++;
  }

  let previous = lastLine;
  for (let index = rows.length - 1; index >= forwardEnd; index--) {
    const row = rows[index];
    if (row.kind === 'note') {
      if (row.note === 'linesNotRead') previous -= row.count ?? 0;
      numbered[index] = noteRow(row);
      continue;
    }
    numbered[index] = { kind: 'line', number: endSaved ? previous : null, text: row.text };
    previous--;
  }
  return numbered;
}

/** A read_file result as a header and numbered lines, read by the record read_file made. */
export function fileReadView(text: string, outcome: FileReadOutcome | undefined): FileReadView {
  if (outcome?.kind !== 'text') return { header: null, numbered: null, plain: toResultRows(text) };
  const { startLine, lineCount, totalLines, bodyStart } = outcome;
  const lastLine = startLine + lineCount - 1;
  const header: FileReadHeader = startLine === 1 && lineCount === totalLines
    ? { kind: 'all', count: totalLines }
    : { kind: 'range', start: startLine, end: lastLine, total: totalLines };
  const body = text.slice(Math.min(bodyStart, text.length));
  const rows = body === '' ? [] : toResultRows(body);
  return { header, numbered: numberRows(rows, startLine, lastLine), plain: null };
}
