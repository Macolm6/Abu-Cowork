import { describe, expect, it } from 'vitest';
import {
  computeFileChange,
  diffTexts,
  MAX_COMPARABLE_TEXT_BYTES,
  MAX_DIFF_EDIT_LENGTH,
  MAX_FILE_CHANGE_BYTES,
  MAX_SAVED_DIFF_LINES,
  MAX_SAVED_LINE_CHARS,
} from './fileChange';

function numberedLines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe('computeFileChange', () => {
  describe('kind and counts', () => {
    it('records a new file as added lines only', () => {
      const change = computeFileChange({ path: '/work/outline.md', before: null, after: '# Title\n\nBody\n' });
      expect(change).toEqual({
        path: '/work/outline.md',
        kind: 'create',
        added: 3,
        deleted: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+# Title', '+', '+Body'] }],
      });
    });

    it('records a deleted file as deleted lines only', () => {
      const change = computeFileChange({ path: '/work/draft.md', before: 'one\ntwo\n', after: null });
      expect(change).toEqual({
        path: '/work/draft.md',
        kind: 'delete',
        added: 0,
        deleted: 2,
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-one', '-two'] }],
      });
    });

    it('records three changed lines with three lines of context on each side', () => {
      const before = numberedLines(12);
      const after = before
        .replace('line 5\n', 'five\n')
        .replace('line 6\n', 'six\n')
        .replace('line 7\n', 'seven\n');
      const change = computeFileChange({ path: '/work/plan.md', before, after });
      expect(change.kind).toBe('modify');
      expect(change.added).toBe(3);
      expect(change.deleted).toBe(3);
      expect(change.hunks).toEqual([{
        oldStart: 2,
        oldLines: 9,
        newStart: 2,
        newLines: 9,
        lines: [
          ' line 2', ' line 3', ' line 4',
          '-line 5', '-line 6', '-line 7',
          '+five', '+six', '+seven',
          ' line 8', ' line 9', ' line 10',
        ],
      }]);
      expect(change.cut).toBeUndefined();
    });

    it('keeps distant edits as separate hunks', () => {
      const before = numberedLines(30);
      const after = before.replace('line 3\n', 'three\n').replace('line 26\n', 'twenty-six\n');
      const change = computeFileChange({ path: '/work/plan.md', before, after });
      expect(change.added).toBe(2);
      expect(change.deleted).toBe(2);
      expect(change.hunks).toHaveLength(2);
    });

    it('reports zero counts and no hunks for identical texts', () => {
      const change = computeFileChange({ path: '/work/plan.md', before: 'same\n', after: 'same\n' });
      expect(change).toEqual({ path: '/work/plan.md', kind: 'modify', added: 0, deleted: 0 });
    });

    it('records an empty new file with zero counts', () => {
      expect(computeFileChange({ path: '/work/empty.txt', before: null, after: '' }))
        .toEqual({ path: '/work/empty.txt', kind: 'create', added: 0, deleted: 0 });
    });

    it('stores the path with forward slashes', () => {
      const change = computeFileChange({ path: 'C:\\work\\plan.md', before: null, after: 'x\n' });
      expect(change.path).toBe('C:/work/plan.md');
    });
  });

  describe('line endings', () => {
    it('treats CRLF and LF as the same line ending', () => {
      const change = computeFileChange({
        path: '/work/a.txt',
        before: 'one\r\ntwo\r\nthree\r\n',
        after: 'one\ntwo changed\nthree\n',
      });
      expect(change.added).toBe(1);
      expect(change.deleted).toBe(1);
      expect(change.hunks?.[0].lines).toEqual([' one', '-two', '+two changed', ' three']);
    });

    it('leaves the missing-final-newline marker out of the hunk lines', () => {
      const change = computeFileChange({ path: '/work/a.txt', before: null, after: 'one\ntwo' });
      expect(change.added).toBe(2);
      expect(change.hunks?.[0].lines).toEqual(['+one', '+two']);
      const edited = computeFileChange({ path: '/work/a.txt', before: 'one\ntwo', after: 'one\n2' });
      expect(edited.hunks?.[0].lines).toEqual([' one', '-two', '+2']);
    });
  });

  describe('texts that are not compared', () => {
    it('records only path and kind when a side is over the size limit', () => {
      const big = 'x'.repeat(MAX_COMPARABLE_TEXT_BYTES + 1);
      expect(computeFileChange({ path: '/work/big.log', before: 'small\n', after: big }))
        .toEqual({ path: '/work/big.log', kind: 'modify' });
      expect(computeFileChange({ path: '/work/big.log', before: big, after: null }))
        .toEqual({ path: '/work/big.log', kind: 'delete' });
    });

    it('measures the size limit in UTF-8 bytes', () => {
      const charsUnderLimit = Math.floor(MAX_COMPARABLE_TEXT_BYTES / 3) + 1;
      const cjk = '文'.repeat(charsUnderLimit);
      expect(computeFileChange({ path: '/work/big.txt', before: null, after: cjk }))
        .toEqual({ path: '/work/big.txt', kind: 'create' });
    });

    it('compares a text exactly at the size limit', () => {
      const atLimit = 'x'.repeat(MAX_COMPARABLE_TEXT_BYTES);
      const change = computeFileChange({ path: '/work/big.txt', before: null, after: atLimit });
      expect(change.added).toBe(1);
    });

    it('records only path and kind when a side contains a NUL byte', () => {
      expect(computeFileChange({ path: '/work/data.bin', before: 'a\u0000b', after: 'text\n' }))
        .toEqual({ path: '/work/data.bin', kind: 'modify' });
      expect(computeFileChange({ path: '/work/data.bin', before: null, after: 'a\u0000b' }))
        .toEqual({ path: '/work/data.bin', kind: 'create' });
    });

    it('records only path and kind when the comparison exceeds the edit limit', () => {
      const count = MAX_DIFF_EDIT_LENGTH + 10;
      const change = computeFileChange({
        path: '/work/rewrite.txt',
        before: numberedLines(count, 'old'),
        after: numberedLines(count, 'new'),
      });
      expect(change).toEqual({ path: '/work/rewrite.txt', kind: 'modify' });
    });

    it('compares a new file longer than the edit limit', () => {
      const count = MAX_DIFF_EDIT_LENGTH * 3;
      const change = computeFileChange({ path: '/work/long.txt', before: null, after: numberedLines(count) });
      expect(change.added).toBe(count);
    });
  });

  describe('saved-hunk budget', () => {
    it('keeps the leading lines and exact counts when the hunks exceed the line budget', () => {
      const total = MAX_SAVED_DIFF_LINES + 50;
      const change = computeFileChange({ path: '/work/long.txt', before: null, after: numberedLines(total) });
      expect(change.added).toBe(total);
      expect(change.deleted).toBe(0);
      expect(change.cut).toBe(true);
      expect(change.hunks).toHaveLength(1);
      expect(change.hunks?.[0].lines).toHaveLength(MAX_SAVED_DIFF_LINES);
      expect(change.hunks?.[0].lines[0]).toBe('+line 1');
      expect(change.hunks?.[0].newLines).toBe(MAX_SAVED_DIFF_LINES);
      expect(change.hunks?.[0].oldLines).toBe(0);
    });

    it('does not mark a change that fits the line budget exactly', () => {
      const change = computeFileChange({
        path: '/work/long.txt',
        before: null,
        after: numberedLines(MAX_SAVED_DIFF_LINES),
      });
      expect(change.cut).toBeUndefined();
      expect(change.hunks?.[0].lines).toHaveLength(MAX_SAVED_DIFF_LINES);
    });

    it('stops at the line budget when the lines are spread over many hunks', () => {
      const count = MAX_SAVED_DIFF_LINES * 4;
      const before = numberedLines(count);
      const after = before
        .split('\n')
        .map((line, index) => (index % 10 === 0 && line ? `${line} changed` : line))
        .join('\n');
      const change = computeFileChange({ path: '/work/many.txt', before, after });
      const savedLines = change.hunks?.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0;
      expect(change.cut).toBe(true);
      expect(change.hunks?.length).toBeGreaterThan(1);
      expect(savedLines).toBe(MAX_SAVED_DIFF_LINES);
      expect(change.added).toBe(count / 10);
      expect(change.deleted).toBe(count / 10);
      for (const hunk of change.hunks ?? []) {
        expect(hunk.lines.filter((line) => !line.startsWith('+'))).toHaveLength(hunk.oldLines);
        expect(hunk.lines.filter((line) => !line.startsWith('-'))).toHaveLength(hunk.newLines);
      }
    });

    it('shortens an over-long line and marks the change as cut', () => {
      const long = 'y'.repeat(MAX_SAVED_LINE_CHARS + 100);
      const change = computeFileChange({ path: '/work/min.js', before: null, after: `${long}\nshort\n` });
      expect(change.cut).toBe(true);
      expect(change.added).toBe(2);
      expect(change.hunks?.[0].lines).toEqual([`+${'y'.repeat(MAX_SAVED_LINE_CHARS)}`, '+short']);
    });

    it('keeps the serialized change within the byte budget', () => {
      const wideLine = '文'.repeat(MAX_SAVED_LINE_CHARS);
      const after = Array.from({ length: MAX_SAVED_DIFF_LINES }, () => wideLine).join('\n') + '\n';
      const change = computeFileChange({ path: '/work/wide.txt', before: null, after });
      expect(change.cut).toBe(true);
      expect(change.added).toBe(MAX_SAVED_DIFF_LINES);
      expect(utf8Bytes(change)).toBeLessThanOrEqual(MAX_FILE_CHANGE_BYTES);
      expect(change.hunks?.[0].lines.length).toBeGreaterThan(0);
      expect(change.hunks?.[0].newLines).toBe(change.hunks?.[0].lines.length);
    });
  });
});

describe('diffTexts', () => {
  it('returns every hunk line without the saved-line budget', () => {
    const total = MAX_SAVED_DIFF_LINES * 3;
    const long = 'z'.repeat(MAX_SAVED_LINE_CHARS * 2);
    const result = diffTexts('', `${long}\n${numberedLines(total)}`);
    expect(result?.added).toBe(total + 1);
    expect(result?.deleted).toBe(0);
    expect(result?.hunks[0].lines).toHaveLength(total + 1);
    expect(result?.hunks[0].lines[0]).toBe(`+${long}`);
  });

  it('returns counts and hunks for a modification', () => {
    const result = diffTexts('a\nb\nc\n', 'a\nB\nc\n');
    expect(result).toEqual({
      added: 1,
      deleted: 1,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }],
    });
  });

  it('returns empty hunks for identical texts', () => {
    expect(diffTexts('same\n', 'same\n')).toEqual({ added: 0, deleted: 0, hunks: [] });
  });

  it('returns null for texts it does not compare', () => {
    expect(diffTexts('a\u0000', 'b')).toBeNull();
    expect(diffTexts('x'.repeat(MAX_COMPARABLE_TEXT_BYTES + 1), 'b')).toBeNull();
    const count = MAX_DIFF_EDIT_LENGTH + 10;
    expect(diffTexts(numberedLines(count, 'old'), numberedLines(count, 'new'))).toBeNull();
  });
});

describe('budget constants', () => {
  it('holds the documented limits', () => {
    expect(MAX_COMPARABLE_TEXT_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_SAVED_DIFF_LINES).toBe(400);
    expect(MAX_SAVED_LINE_CHARS).toBe(500);
    expect(MAX_FILE_CHANGE_BYTES).toBe(64 * 1024);
    expect(MAX_DIFF_EDIT_LENGTH).toBe(1000);
  });
});
