import { describe, expect, it } from 'vitest';
import { linesOmittedMarker, truncateToolResult } from '@/core/context/truncation';
import { TOOL_NAMES } from '@/core/tools/toolNames';
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

  it('drops the cut paths around a characters-left-out note', () => {
    const paths = [
      ...Array.from({ length: 50 }, (_, index) => `/work/${'d'.repeat(180)}/file${index}.ts`.padEnd(200, 'e')),
      `/work/${'q'.repeat(200)}/components/Foo.tsx`,
      '/work/z/'.padEnd(479, 'z'),
    ];
    const cut = truncateToolResult(TOOL_NAMES.FIND_FILES, `Found 52 files:\n${paths.join('\n')}`);
    expect(cut).toMatch(/\n\n\[\.\.\. \d+ characters omitted \.\.\.\]\n\nq\/components\/Foo\.tsx\n/);
    const view = parseFindResult(cut);
    expect(view.header).toEqual({ kind: 'files', count: 52 });
    const kept = view.rows.flatMap((row) => (row.kind === 'path' ? [row.path] : []));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((path) => paths.includes(path))).toBe(true);
    expect(kept.at(-1)).toBe(paths.at(-1));
    expect(view.rows.filter((row) => row.kind === 'note')).toEqual([
      { kind: 'note', note: 'charsNotRead', count: expect.any(Number) },
    ]);
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

  it('drops the cut entries around a characters-left-out note', () => {
    const lines = [
      ...Array.from({ length: 50 }, (_, index) => `[FILE] ${'n'.repeat(180)}${index}`.padEnd(200, 'e')),
      `[DIR] ${'m'.repeat(300)}`,
      '[FILE] '.padEnd(479, 'z'),
    ];
    const cut = truncateToolResult(TOOL_NAMES.LIST_DIRECTORY, lines.join('\n'));
    expect(cut).toMatch(/\n\n\[\.\.\. \d+ characters omitted \.\.\.\]\n\nm+\n/);
    const view = parseListDirectoryResult(cut);
    const kept = view.rows.flatMap((row) => (row.kind === 'entry' ? [`${row.directory ? '[DIR]' : '[FILE]'} ${row.name}`] : []));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((line) => lines.includes(line))).toBe(true);
    expect(kept.at(-1)).toBe(lines.at(-1));
    expect(view.header).toEqual({ kind: 'entries', count: kept.length });
    expect(view.rows.filter((row) => row.kind === 'note')).toEqual([
      { kind: 'note', note: 'charsNotRead', count: expect.any(Number) },
    ]);
  });
});
