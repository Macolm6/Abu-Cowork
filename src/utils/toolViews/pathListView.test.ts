import { describe, expect, it } from 'vitest';
import { linesOmittedMarker } from '@/core/context/truncation';
import { parseFindResult, parseListDirectoryResult } from './pathListView';

describe('parseFindResult', () => {
  it('reads the found files', () => {
    const paths = Array.from({ length: 23 }, (_, index) => `/work/src/file${index}.ts`);
    const view = parseFindResult(`Found 23 files:\n${paths.join('\n')}`);
    expect(view.header).toEqual({ kind: 'files', count: 23 });
    expect(view.rows).toHaveLength(23);
    expect(view.rows[0]).toEqual({ kind: 'path', path: '/work/src/file0.ts' });
    expect(view.rows.every((row) => row.kind === 'path')).toBe(true);
  });

  it('reads zero files', () => {
    const view = parseFindResult('No files found matching the pattern.');
    expect(view.header).toEqual({ kind: 'files', count: 0 });
    expect(view.rows).toEqual([]);
  });
});

describe('parseListDirectoryResult', () => {
  it('reads directory entries with their kind', () => {
    const view = parseListDirectoryResult('[DIR] src\n[FILE] a.ts');
    expect(view.header).toEqual({ kind: 'entries', count: 2 });
    expect(view.rows).toEqual([
      { kind: 'entry', name: 'src', directory: true },
      { kind: 'entry', name: 'a.ts', directory: false },
    ]);
  });

  it('reads an empty directory', () => {
    const view = parseListDirectoryResult('Directory "/work/empty" is empty.');
    expect(view.header).toEqual({ kind: 'empty' });
    expect(view.rows).toEqual([]);
  });

  it('keeps a note row of a cut listing', () => {
    const view = parseListDirectoryResult(['[DIR] a', '[FILE] b', '', linesOmittedMarker(5), '', '[FILE] h'].join('\n'));
    expect(view.header).toEqual({ kind: 'entries', count: 3 });
    expect(view.rows).toEqual([
      { kind: 'entry', name: 'a', directory: true },
      { kind: 'entry', name: 'b', directory: false },
      { kind: 'note', note: 'linesNotRead', count: 5 },
      { kind: 'entry', name: 'h', directory: false },
    ]);
  });
});
