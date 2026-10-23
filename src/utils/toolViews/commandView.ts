import stripAnsi from 'strip-ansi';
import type { CommandOutcome } from '@/types';
import { DURABLE_RESULT_OMITTED_NOTE } from '@/core/session/durableToolResultContent';
import { toResultRows, type ToolResultRow } from '@/utils/toolResultFold';

export interface CommandOutputSections {
  /** Rows of the standard output; null when that stream was empty or unknown. */
  stdout: ToolResultRow[] | null;
  stderr: ToolResultRow[] | null;
  /** Without usable positions: the whole result as rows. */
  whole: ToolResultRow[] | null;
}

const NOT_SAVED: ToolResultRow = { kind: 'note', note: 'partNotSaved' };

/**
 * One section of a saved result. `kept` is the length of the result the
 * storage budget kept, or null when the text is whole; the budget appends
 * `\n\n` and its note after what it kept.
 */
function sectionRows(text: string, range: [number, number] | undefined, kept: number | null): ToolResultRow[] | null {
  if (!range) return null;
  const [start, end] = range;
  if (kept !== null && start >= kept) return [NOT_SAVED];
  if (kept !== null && end > kept) return [...toResultRows(stripAnsi(text.slice(start, kept))), NOT_SAVED];
  return toResultRows(stripAnsi(text.slice(start, Math.min(end, text.length))));
}

/** The output streams of a run_command result, read by the positions run_command recorded. */
export function commandOutputSections(text: string, outcome: CommandOutcome | undefined): CommandOutputSections {
  if (!outcome) return { stdout: null, stderr: null, whole: toResultRows(stripAnsi(text)) };
  const kept = text.endsWith(DURABLE_RESULT_OMITTED_NOTE)
    ? Math.max(0, text.length - DURABLE_RESULT_OMITTED_NOTE.length - 2)
    : null;
  return {
    stdout: sectionRows(text, outcome.stdout, kept),
    stderr: sectionRows(text, outcome.stderr, kept),
    whole: null,
  };
}
