import { describe, expect, it } from 'vitest';
import type { FileChangeHunk } from '@/types/fileChange';
import { limitHunkLines, MAX_RENDERED_DIFF_LINES } from './hunkLimit';

function hunk(oldStart: number, lines: string[]): FileChangeHunk {
  return {
    oldStart,
    oldLines: lines.filter((line) => !line.startsWith('+')).length,
    newStart: oldStart,
    newLines: lines.filter((line) => !line.startsWith('-')).length,
    lines,
  };
}

describe('limitHunkLines', () => {
  const hunks = [hunk(1, [' a', '-b', '+B']), hunk(20, ['+c', '+d', ' e'])];

  it('returns the same hunks when they fit', () => {
    expect(limitHunkLines(hunks, 6)).toEqual({ hunks, cut: false });
    expect(limitHunkLines(hunks, 6).hunks).toBe(hunks);
  });

  it('keeps the leading lines and recounts the hunk it shortens', () => {
    expect(limitHunkLines(hunks, 4)).toEqual({
      hunks: [hunks[0], { oldStart: 20, oldLines: 0, newStart: 20, newLines: 1, lines: ['+c'] }],
      cut: true,
    });
  });

  it('drops a hunk that would start past the limit', () => {
    expect(limitHunkLines(hunks, 3)).toEqual({ hunks: [hunks[0]], cut: true });
  });

  it('reports no cut for no hunks', () => {
    expect(limitHunkLines([], 10)).toEqual({ hunks: [], cut: false });
  });

  it('sets the rendered limit of one file at 5000 lines', () => {
    expect(MAX_RENDERED_DIFF_LINES).toBe(5000);
  });
});
