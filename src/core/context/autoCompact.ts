/**
 * Context usage levels and percentages for the context ring.
 *
 *   Level 0 (< 60%):  Normal
 *   Level 1 (60-75%): Warning
 *   Level 2 (75-85%): Warning
 *   Level 3 (> 85%):  Critical
 *
 * When to compact is decided elsewhere (compaction.ts, at 90 % of the input
 * budget).
 */

export type ContextWarningLevel = 0 | 1 | 2 | 3;

/** Thresholds as fractions of max input tokens */
const LEVEL_1_THRESHOLD = 0.60;
const LEVEL_2_THRESHOLD = 0.75;
const LEVEL_3_THRESHOLD = 0.85;

/**
 * Calculate the context warning level based on current usage.
 *
 * @param currentTokens - Current total input tokens (system + messages + tools)
 * @param maxInputTokens - Maximum allowed input tokens (contextWindow - reserveForOutput)
 */
export function calculateWarningLevel(currentTokens: number, maxInputTokens: number): ContextWarningLevel {
  if (maxInputTokens <= 0) return 0;
  const ratio = currentTokens / maxInputTokens;

  if (ratio >= LEVEL_3_THRESHOLD) return 3;
  if (ratio >= LEVEL_2_THRESHOLD) return 2;
  if (ratio >= LEVEL_1_THRESHOLD) return 1;
  return 0;
}

/**
 * Get the raw usage percentage. Unclamped on purpose — the compaction and
 * truncation paths need to see how far PAST the budget a payload is.
 */
export function getUsagePercent(currentTokens: number, maxInputTokens: number): number {
  if (maxInputTokens <= 0) return 0;
  return Math.round((currentTokens / maxInputTokens) * 100);
}

/**
 * Usage percentage for anything a user reads. Clamped to 0–100 so an estimate
 * that runs over the window can never surface as "108% used": the request the
 * agent loop actually sends is guaranteed to fit by `enforceContextBudget`, so
 * a >100% reading is always a measurement artifact, never a real overflow.
 */
export function getDisplayPercent(currentTokens: number, maxInputTokens: number): number {
  return Math.min(100, Math.max(0, getUsagePercent(currentTokens, maxInputTokens)));
}
