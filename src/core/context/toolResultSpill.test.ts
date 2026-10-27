import { describe, it, expect, vi } from 'vitest';
import { boundToolResult, SPILL_THRESHOLD_TOKENS } from './toolResultSpill';
import { estimateTokens } from './tokenEstimator';
import { CHARS_OMITTED_LINE } from './truncation';

/** ASCII text of about `tokens` tokens (4 characters per token, uncalibrated). */
function textOf(tokens: number): string {
  const lines: string[] = [];
  for (let i = 0; lines.join('\n').length < tokens * 4; i++) lines.push(`line ${i} ${'x'.repeat(60)}`);
  return lines.join('\n');
}

describe('boundToolResult', () => {
  it('keeps a result within the threshold as it is, and writes nothing', async () => {
    const writeFile = vi.fn();
    const result = textOf(SPILL_THRESHOLD_TOKENS - 100);
    expect(await boundToolResult({
      toolCallId: 'tc-1', toolName: 'search_files', input: {}, result, writeFile,
    })).toBe(result);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes a longer result to a file and keeps its beginning, its end and the path', async () => {
    const writeFile = vi.fn(async (toolCallId: string) => `/data/results/${toolCallId}.txt`);
    const result = `FIRST-LINE\n${textOf(SPILL_THRESHOLD_TOKENS * 2)}\nLAST-LINE`;
    const bounded = await boundToolResult({
      toolCallId: 'tc-1', toolName: 'search_files', input: {}, result, writeFile,
    });

    expect(writeFile).toHaveBeenCalledWith('tc-1', result);
    expect(bounded.startsWith('FIRST-LINE')).toBe(true);
    expect(bounded).toContain('LAST-LINE');
    expect(bounded).toContain('/data/results/tc-1.txt');
    expect(bounded).toContain(`${result.length} characters`);
    expect(estimateTokens(bounded)).toBeLessThan(4_000);
    // The omission line is the one the step view folds.
    expect(bounded.split('\n').some((line) => CHARS_OMITTED_LINE.test(line))).toBe(true);
  });

  it('keeps a long single-line read_file result complete', async () => {
    const writeFile = vi.fn();
    const result = 'x'.repeat(SPILL_THRESHOLD_TOKENS * 8);
    const bounded = await boundToolResult({
      toolCallId: 'tc-2',
      toolName: 'read_file',
      input: { path: '/ws/big.log' },
      result,
      writeFile,
    });
    expect(writeFile).not.toHaveBeenCalled();
    expect(bounded).toBe(result);
  });

  it('lets a failed write throw', async () => {
    const writeFile = vi.fn(async () => { throw new Error('disk full'); });
    await expect(boundToolResult({
      toolCallId: 'tc-3', toolName: 'search_files', input: {}, result: textOf(SPILL_THRESHOLD_TOKENS * 2), writeFile,
    })).rejects.toThrow('disk full');
  });
});
