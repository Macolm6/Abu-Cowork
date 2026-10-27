/**
 * Head-and-tail cuts that run_command and http_fetch apply to their own
 * output inside `execute`, so the positions they record stay valid in the
 * result. Every other tool result is bounded by `toolResultSpill.ts`, which
 * writes a result too long for the conversation to a file.
 */

export interface TruncationRule {
  headLines: number;
  tailLines: number;
  maxChars: number;
}

/** run_command's stdout and stderr together. */
export const COMMAND_OUTPUT_RULE: TruncationRule = { headLines: 150, tailLines: 30, maxChars: 15000 };

/** http_fetch's response body. */
export const HTTP_FETCH_RULE: TruncationRule = { headLines: 0, tailLines: 0, maxChars: 3500 };

/** The line `truncateText` writes where it dropped lines from the middle. */
export function linesOmittedMarker(count: number): string {
  return `[... ${count} lines omitted ...]`;
}

/** The line written where characters were dropped from the middle. */
export function charsOmittedMarker(count: number): string {
  return `[... ${count} characters omitted ...]`;
}

/** A whole line written by `linesOmittedMarker`, its count captured. */
export const LINES_OMITTED_LINE = /^\[\.\.\. (\d+) lines omitted \.\.\.\]$/;
/** A whole line written by `charsOmittedMarker`, its count captured. */
export const CHARS_OMITTED_LINE = /^\[\.\.\. (\d+) characters omitted \.\.\.\]$/;

/** Head and tail lines, then head and tail characters. */
export function truncateText(text: string, rule: TruncationRule): string {
  // If within char limit, no truncation needed
  if (text.length <= rule.maxChars) return text;

  // Line-based truncation for tools with line rules
  if (rule.headLines > 0) {
    const lines = text.split('\n');
    if (lines.length > rule.headLines + rule.tailLines + 1) {
      const head = lines.slice(0, rule.headLines);
      const tail = rule.tailLines > 0 ? lines.slice(-rule.tailLines) : [];
      const omitted = lines.length - rule.headLines - rule.tailLines;
      const truncated = [
        ...head,
        `\n${linesOmittedMarker(omitted)}\n`,
        ...tail,
      ].join('\n');

      // Further trim if still too long
      if (truncated.length > rule.maxChars) {
        return charTruncate(truncated, rule.maxChars);
      }
      return truncated;
    }
  }

  // Character-based truncation (default fallback)
  return charTruncate(text, rule.maxChars);
}

/**
 * Character-level truncation preserving head and tail
 */
function charTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const tailChars = Math.min(500, Math.floor(maxChars * 0.15));
  const headChars = maxChars - tailChars - 50; // 50 chars for omission message

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - headChars - tailChars;

  return `${head}\n\n${charsOmittedMarker(omitted)}\n\n${tail}`;
}
