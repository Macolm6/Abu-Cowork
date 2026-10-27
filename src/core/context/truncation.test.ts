import { describe, it, expect } from 'vitest';
import {
  CHARS_OMITTED_LINE,
  COMMAND_OUTPUT_RULE,
  HTTP_FETCH_RULE,
  LINES_OMITTED_LINE,
  charsOmittedMarker,
  linesOmittedMarker,
  truncateText,
} from './truncation';

describe('truncateText', () => {
  it('returns a text within the limit as it is', () => {
    const text = 'short output';
    expect(truncateText(text, COMMAND_OUTPUT_RULE)).toBe(text);
    expect(truncateText('', COMMAND_OUTPUT_RULE)).toBe('');
  });

  it('keeps the head and tail lines of long command output, with the omission line between', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    const result = truncateText(lines.join('\n'), COMMAND_OUTPUT_RULE);

    expect(result.length).toBeLessThanOrEqual(COMMAND_OUTPUT_RULE.maxChars);
    expect(result.startsWith('line 0 ')).toBe(true);
    expect(result).toContain('line 149 ');
    expect(result).not.toContain('line 150 ');
    expect(result).toContain('line 399 ');
    expect(result.split('\n').some((line) => LINES_OMITTED_LINE.test(line))).toBe(true);
  });

  it('falls back to a character cut when the kept lines are still too long', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(400)}`);
    const result = truncateText(lines.join('\n'), COMMAND_OUTPUT_RULE);
    expect(result.length).toBeLessThanOrEqual(COMMAND_OUTPUT_RULE.maxChars);
    expect(result.split('\n').some((line) => CHARS_OMITTED_LINE.test(line))).toBe(true);
  });

  it('cuts an http_fetch body by characters, keeping its head and tail', () => {
    const body = `BEGIN${'b'.repeat(10_000)}END`;
    const result = truncateText(body, HTTP_FETCH_RULE);
    expect(result.length).toBeLessThanOrEqual(HTTP_FETCH_RULE.maxChars);
    expect(result.startsWith('BEGIN')).toBe(true);
    expect(result.endsWith('END')).toBe(true);
  });
});

describe('omission markers', () => {
  it('are whole lines the step view can recognize, with their counts', () => {
    expect(LINES_OMITTED_LINE.exec(linesOmittedMarker(12))?.[1]).toBe('12');
    expect(CHARS_OMITTED_LINE.exec(charsOmittedMarker(3456))?.[1]).toBe('3456');
  });
});
