import { describe, expect, it } from 'vitest';
import { linesOmittedMarker, truncateToolResult } from '@/core/context/truncation';
import { DURABLE_RESULT_OMITTED_NOTE } from '@/core/session/durableToolResultContent';
import { fileReadView, type NumberedRow } from './fileReadView';

function numbers(rows: NumberedRow[] | null): Array<number | null | string> {
  return (rows ?? []).map((row) => (row.kind === 'line' ? row.number : `<${row.note}>`));
}

/** A whole read of 1000 lines of 300 characters, cut as the context at 90 % cuts it. */
function charCutWholeRead(): string {
  const lines = Array.from({ length: 1000 }, (_, index) => `line ${index + 1} `.padEnd(300, 'x'));
  return truncateToolResult('read_file', lines.join('\n'), 90);
}

describe('fileReadView', () => {
  it('numbers a whole read from one', () => {
    const view = fileReadView('a\nb\nc', { kind: 'text', startLine: 1, lineCount: 3, totalLines: 3, bodyStart: 0 });
    expect(view.header).toEqual({ kind: 'all', count: 3 });
    expect(view.numbered).toEqual([
      { kind: 'line', number: 1, text: 'a' },
      { kind: 'line', number: 2, text: 'b' },
      { kind: 'line', number: 3, text: 'c' },
    ]);
    expect(view.plain).toBeNull();
  });

  it('numbers a ranged read from its first line and drops the header line', () => {
    const header = '[File: /work/big.ts | 40 KB | Lines 199-298 of 1500 total]';
    const body = Array.from({ length: 100 }, (_, index) => `row ${index}`).join('\n');
    const view = fileReadView(`${header}\n${body}`, {
      kind: 'text', startLine: 200, lineCount: 100, totalLines: 1500, bodyStart: header.length + 1,
    });
    expect(view.header).toEqual({ kind: 'range', start: 200, end: 299, total: 1500 });
    expect(view.numbered![0]).toEqual({ kind: 'line', number: 200, text: 'row 0' });
    expect(view.numbered!.at(-1)).toEqual({ kind: 'line', number: 299, text: 'row 99' });
    expect(view.numbered!.some((row) => row.kind === 'line' && row.text.includes('[File:'))).toBe(false);
  });

  it('adds the omitted count after a lines-not-read note', () => {
    const text = ['l1', 'l2', 'l3', `\n${linesOmittedMarker(10)}\n`, 'l14', 'l15'].join('\n');
    const view = fileReadView(text, { kind: 'text', startLine: 1, lineCount: 15, totalLines: 15, bodyStart: 0 });
    expect(numbers(view.numbered)).toEqual([1, 2, 3, '<linesNotRead>', 14, 15]);
    expect(view.numbered![3]).toEqual({ kind: 'note', note: 'linesNotRead', count: 10 });
  });

  it('numbers the rows after a chars-not-read note from the end', () => {
    const text = charCutWholeRead();
    const view = fileReadView(text, { kind: 'text', startLine: 1, lineCount: 1000, totalLines: 1000, bodyStart: 0 });
    const rows = view.numbered!;
    const note = rows.findIndex((row) => row.kind === 'note' && row.note === 'charsNotRead');
    expect(note).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ kind: 'line', number: 1 });
    expect(rows.at(-1)).toMatchObject({ kind: 'line', number: 1000 });
    expect((rows.at(-1) as { text: string }).text.startsWith('line 1000 ')).toBe(true);
    expect(rows.at(-2)).toMatchObject({ kind: 'line', number: 999 });
    expect(rows.slice(note + 1).every((row) => row.kind === 'line')).toBe(true);
  });

  it('leaves the rows after a chars-not-read note unnumbered when the end was not saved', () => {
    const text = `${charCutWholeRead()}\n\n${DURABLE_RESULT_OMITTED_NOTE}`;
    const view = fileReadView(text, { kind: 'text', startLine: 1, lineCount: 1000, totalLines: 1000, bodyStart: 0 });
    const rows = view.numbered!;
    const note = rows.findIndex((row) => row.kind === 'note' && row.note === 'charsNotRead');
    const after = rows.slice(note + 1);
    expect(after.at(-1)).toEqual({ kind: 'note', note: 'partNotSaved' });
    const lines = after.filter((row) => row.kind === 'line');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((row) => row.number === null)).toBe(true);
    expect(rows[0]).toMatchObject({ kind: 'line', number: 1 });
  });

  it('shows a document, a notice and a step without a record as plain text', () => {
    for (const outcome of [{ kind: 'document' } as const, { kind: 'notice' } as const, undefined]) {
      const view = fileReadView('first\nsecond', outcome);
      expect(view.header).toBeNull();
      expect(view.numbered).toBeNull();
      expect(view.plain).toEqual([
        { kind: 'text', text: 'first' },
        { kind: 'text', text: 'second' },
      ]);
    }
  });

  it('cuts a body start past the text to the text length', () => {
    const view = fileReadView('short', { kind: 'text', startLine: 1, lineCount: 1, totalLines: 1, bodyStart: 40 });
    expect(view.numbered).toEqual([]);
    expect(view.header).toEqual({ kind: 'all', count: 1 });
  });
});
