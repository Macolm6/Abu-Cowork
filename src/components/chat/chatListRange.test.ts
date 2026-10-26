import { describe, expect, it } from 'vitest';
import { extendRangeByPx, initialScrollOffset, rowResizeMovesScroll } from './chatListRange';

// Six rows, 500px each: row i spans [i*500, i*500 + 500).
const rows = Array.from({ length: 6 }, (_, i) => ({ start: i * 500, end: i * 500 + 500 }));

describe('chatListRange', () => {
  describe('extendRangeByPx', () => {
    it('takes in rows above that end within the extension and leaves out rows beyond it', () => {
      // Visible from row 4 (starts at 2000). Row 3 ends at 2000, row 2 at 1500,
      // row 1 at 1000: within 900px of 2000 are rows 3 and 2 (1500 >= 1100), not row 1.
      expect(extendRangeByPx(rows, 4, 4, 900)).toEqual([2, 3, 4, 5]);
    });

    it('takes in rows below that start within the extension', () => {
      // Visible row 1 ends at 1000. Row 2 starts at 1000, row 3 at 1500 (<= 1900),
      // row 4 at 2000 is beyond.
      expect(extendRangeByPx(rows, 1, 1, 900)).toEqual([0, 1, 2, 3]);
    });

    it('stays within the list at both ends', () => {
      expect(extendRangeByPx(rows, 0, 5, 900)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('returns nothing for an empty list', () => {
      expect(extendRangeByPx([], 0, 0, 900)).toEqual([]);
    });
  });

  describe('rowResizeMovesScroll', () => {
    const at = (overrides: Partial<Parameters<typeof rowResizeMovesScroll>[0]>) => rowResizeMovesScroll({
      keepsBottom: false,
      firstMeasure: false,
      row: { start: 1000, end: 1500 },
      scrollOffset: 1200,
      scrollingBackward: false,
      ...overrides,
    });

    it('keeps a reader at the bottom there when the row they are reading grows (a chart finishing its render)', () => {
      expect(at({ keepsBottom: true })).toBe(true);
    });

    it('leaves the offset alone for a re-measured row that reaches into the viewport', () => {
      expect(at({})).toBe(false);
    });

    it('moves the offset for a re-measured row entirely above the viewport, except while scrolling up', () => {
      expect(at({ scrollOffset: 1500 })).toBe(true);
      expect(at({ scrollOffset: 1500, scrollingBackward: true })).toBe(false);
    });

    it('moves the offset on a first measure of a row that starts above the viewport', () => {
      expect(at({ firstMeasure: true })).toBe(true);
      expect(at({ firstMeasure: true, scrollOffset: 900 })).toBe(false);
    });
  });

  describe('initialScrollOffset', () => {
    it('places the end of the estimated list at the bottom of the viewport', () => {
      expect(initialScrollOffset({
        location: { index: 'LAST', align: 'end' },
        count: 10,
        estimate: 400,
        scrollMargin: 20,
        viewportHeight: 800,
      })).toBe(20 + 10 * 400 - 800);
    });

    it('never goes above the top', () => {
      expect(initialScrollOffset({
        location: { index: 'LAST', align: 'end' },
        count: 1,
        estimate: 400,
        scrollMargin: 20,
        viewportHeight: 800,
      })).toBe(0);
    });

    it('centres the estimated position of a row', () => {
      // Row 5 is estimated at [2000, 2400) below a 20px margin: centre 2220, minus half of 800.
      expect(initialScrollOffset({
        location: { index: 5, align: 'center' },
        count: 10,
        estimate: 400,
        scrollMargin: 20,
        viewportHeight: 800,
      })).toBe(2220 - 400);
    });

    it('aligns the estimated start of a row to the top', () => {
      expect(initialScrollOffset({
        location: { index: 3, align: 'start' },
        count: 10,
        estimate: 400,
        scrollMargin: 20,
        viewportHeight: 800,
      })).toBe(20 + 3 * 400);
    });
  });
});
