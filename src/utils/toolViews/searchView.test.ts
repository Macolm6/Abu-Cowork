import { describe, expect, it } from 'vitest';
import { linesOmittedMarker } from '@/core/context/truncation';
import { foldRowList } from '@/utils/toolResultFold';
import { groupSearchRows, parseSearchResult, type SearchRow } from './searchView';

/** The match lines search_files writes for `perFile` matches in each named file. */
function matchLines(perFile: Array<[string, number]>): string[] {
  const lines: string[] = [];
  for (const [path, count] of perFile) {
    for (let index = 0; index < count; index++) lines.push(`${path}:${12 + index}:  useEffect(() => {`);
  }
  return lines;
}

const SEVENTEEN = matchLines([['src/a.ts', 5], ['src/b.ts', 4], ['src/c.ts', 4], ['src/d.ts', 4]]);

function match(path: string, line: number): Extract<SearchRow, { kind: 'match' }> {
  return { kind: 'match', path, line, text: 'text' };
}

describe('parseSearchResult', () => {
  it('reads the count and the files from the header and the rows', () => {
    const view = parseSearchResult(`Found 17 matches:\n${SEVENTEEN.join('\n')}`);
    expect(view.header).toEqual({ kind: 'count', matches: 17, files: 4 });
    expect(view.rows).toHaveLength(17);
    expect(view.rows.every((row) => row.kind === 'match')).toBe(true);
    expect(view.rows[0]).toEqual({ kind: 'match', path: 'src/a.ts', line: 12, text: '  useEffect(() => {' });
  });

  it('reads a capped header', () => {
    const lines = matchLines([['src/a.ts', 100]]);
    const view = parseSearchResult(`Found 100+ matches:\n${lines.join('\n')}`);
    expect(view.header).toEqual({ kind: 'capped', matches: 100 });
    expect(view.rows).toHaveLength(100);
  });

  it('reads no matches', () => {
    const view = parseSearchResult('No matches found.');
    expect(view.header).toEqual({ kind: 'none' });
    expect(view.rows).toEqual([]);
  });

  it('keeps a Windows drive letter in the path', () => {
    const view = parseSearchResult('Found 1 matches:\nC:\\work\\a.ts:12:text');
    expect(view.rows).toEqual([{ kind: 'match', path: 'C:\\work\\a.ts', line: 12, text: 'text' }]);
  });

  it('keeps the header count when the rows were cut', () => {
    const kept = [...SEVENTEEN.slice(0, 3), '', linesOmittedMarker(11), '', ...SEVENTEEN.slice(14)];
    const view = parseSearchResult(`Found 17 matches:\n${kept.join('\n')}`);
    expect(view.header).toEqual({ kind: 'count', matches: 17, files: 2 });
    expect(view.rows.filter((row) => row.kind === 'match')).toHaveLength(6);
    expect(view.rows.filter((row) => row.kind === 'note')).toEqual([{ kind: 'note', note: 'linesNotRead', count: 11 }]);
    expect(view.rows[3]).toEqual({ kind: 'note', note: 'linesNotRead', count: 11 });
  });
});

describe('groupSearchRows', () => {
  it('groups visible rows by file and counts the whole file', () => {
    const all = [match('a.ts', 1), match('a.ts', 2), match('a.ts', 3), match('b.ts', 1), match('b.ts', 2)];
    const segments = groupSearchRows([all[0], all[3], all[4]], all);
    expect(segments).toEqual([
      { kind: 'group', path: 'a.ts', count: 3, rows: [all[0]] },
      { kind: 'group', path: 'b.ts', count: 2, rows: [all[3], all[4]] },
    ]);
  });

  it('leaves out a group with no visible row and keeps a note as its own segment', () => {
    const note: SearchRow = { kind: 'note', note: 'linesNotRead', count: 4 };
    const all = [match('a.ts', 1), match('a.ts', 2), note, match('b.ts', 1)];
    const segments = groupSearchRows([note, all[3]], all);
    expect(segments).toEqual([
      { kind: 'note', note: 'linesNotRead', count: 4 },
      { kind: 'group', path: 'b.ts', count: 1, rows: [all[3]] },
    ]);
  });

  it('folds across files by match rows', () => {
    const { rows } = parseSearchResult(`Found 17 matches:\n${SEVENTEEN.join('\n')}`);
    const fold = foldRowList(rows, (row) => row.kind === 'match');
    expect(fold.head).toHaveLength(5);
    expect(fold.tail).toHaveLength(4);
    expect(fold.hidden).toEqual({ unit: 'lines', count: 17 });
  });
});
