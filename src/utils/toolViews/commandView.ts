import stripAnsi from 'strip-ansi';
import type { CommandOutcome } from '@/types';
import { toResultRows, type ToolResultRow } from '@/utils/toolResultFold';

export interface CommandOutputSections {
  /** Rows of the standard output; null when that stream was empty or unknown. */
  stdout: ToolResultRow[] | null;
  stderr: ToolResultRow[] | null;
  /** Without usable positions: the whole result as rows. */
  whole: ToolResultRow[] | null;
}

/**
 * One section of a saved result. A section that starts past the saved text
 * was dropped by the storage budget, which ended the text with its note.
 */
function sectionRows(text: string, range: [number, number] | undefined): ToolResultRow[] | null {
  if (!range) return null;
  if (range[0] > text.length) return [{ kind: 'note', note: 'partNotSaved' }];
  return toResultRows(stripAnsi(text.slice(range[0], Math.min(range[1], text.length))));
}

/** The output streams of a run_command result, read by the positions run_command recorded. */
export function commandOutputSections(text: string, outcome: CommandOutcome | undefined): CommandOutputSections {
  if (!outcome) return { stdout: null, stderr: null, whole: toResultRows(stripAnsi(text)) };
  return {
    stdout: sectionRows(text, outcome.stdout),
    stderr: sectionRows(text, outcome.stderr),
    whole: null,
  };
}
