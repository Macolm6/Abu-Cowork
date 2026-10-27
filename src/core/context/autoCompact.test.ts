import { describe, it, expect } from 'vitest';
import { calculateWarningLevel, getUsagePercent, getDisplayPercent } from './autoCompact';

describe('autoCompact', () => {
  describe('calculateWarningLevel', () => {
    it('returns 0 for low usage', () => {
      expect(calculateWarningLevel(50000, 100000)).toBe(0);
    });

    it('returns 1 for 60-75% usage', () => {
      expect(calculateWarningLevel(65000, 100000)).toBe(1);
    });

    it('returns 2 for 75-85% usage', () => {
      expect(calculateWarningLevel(80000, 100000)).toBe(2);
    });

    it('returns 3 for >85% usage', () => {
      expect(calculateWarningLevel(90000, 100000)).toBe(3);
    });

    it('returns 0 for zero max tokens', () => {
      expect(calculateWarningLevel(1000, 0)).toBe(0);
    });

    it('returns level at exact boundaries', () => {
      // At 60% exactly
      expect(calculateWarningLevel(60000, 100000)).toBe(1);
      // At 75% exactly
      expect(calculateWarningLevel(75000, 100000)).toBe(2);
      // At 85% exactly
      expect(calculateWarningLevel(85000, 100000)).toBe(3);
    });
  });

  describe('getUsagePercent', () => {
    it('returns correct percentage', () => {
      expect(getUsagePercent(75000, 100000)).toBe(75);
    });

    it('returns 0 for zero max', () => {
      expect(getUsagePercent(1000, 0)).toBe(0);
    });

    it('stays unclamped so compaction can see how far past the budget it is', () => {
      expect(getUsagePercent(138_400, 128_000)).toBe(108);
    });
  });

  describe('getDisplayPercent', () => {
    it('matches getUsagePercent inside the window', () => {
      expect(getDisplayPercent(75000, 100000)).toBe(75);
    });

    it('clamps an over-budget estimate to 100 rather than showing 108%', () => {
      expect(getDisplayPercent(138_400, 128_000)).toBe(100);
    });

    it('clamps a negative reading to 0', () => {
      expect(getDisplayPercent(-500, 100000)).toBe(0);
    });

    it('returns 0 for zero max', () => {
      expect(getDisplayPercent(1000, 0)).toBe(0);
    });
  });
});
