import { describe, expect, it } from 'vitest';
import type { CommandOutcome } from '@/types';
import { linesOmittedMarker } from '@/core/context/truncation';
import { DURABLE_RESULT_OMITTED_NOTE } from '@/core/session/durableToolResultContent';
import { COMMAND_OUTPUT_CUT_NOTE, type ToolResultRow } from '@/utils/toolResultFold';
import { commandOutputSections } from './commandView';

/** The result run_command returns, with the positions it records after joining. */
function commandResult(
  stdout: string,
  stderr: string,
  exitCode: number,
  lead?: string,
): { text: string; outcome: CommandOutcome } {
  const outcome: CommandOutcome = { exitCode };
  const parts: string[] = [];
  const nextStart = (): number => (parts.length === 0 ? 0 : parts.join('\n\n').length + 2);
  if (lead) parts.push(lead);
  if (stdout) {
    const start = nextStart() + 'stdout:\n'.length;
    parts.push(`stdout:\n${stdout}`);
    outcome.stdout = [start, start + stdout.length];
  }
  if (stderr) {
    const start = nextStart() + 'stderr:\n'.length;
    parts.push(`stderr:\n${stderr}`);
    outcome.stderr = [start, start + stderr.length];
  }
  parts.push(`exit code: ${exitCode}`);
  return { text: parts.join('\n\n'), outcome };
}

function texts(rows: ToolResultRow[] | null): string[] | null {
  return rows === null ? null : rows.map((row) => (row.kind === 'text' ? row.text : `<${row.note}>`));
}

describe('commandOutputSections', () => {
  it('splits both sections by their positions', () => {
    const { text, outcome } = commandResult('a\nb', 'warn', 1);
    const sections = commandOutputSections(text, outcome);
    expect(texts(sections.stdout)).toEqual(['a', 'b']);
    expect(texts(sections.stderr)).toEqual(['warn']);
    expect(sections.whole).toBeNull();
  });

  it('gives one section alone', () => {
    const { text, outcome } = commandResult('', 'only error', 2);
    const sections = commandOutputSections(text, outcome);
    expect(sections.stdout).toBeNull();
    expect(texts(sections.stderr)).toEqual(['only error']);
    expect(sections.whole).toBeNull();
  });

  it('gives nothing for a silent command', () => {
    const sections = commandOutputSections('exit code: 0', { exitCode: 0 });
    expect(sections).toEqual({ stdout: null, stderr: null, whole: null });
  });

  it('keeps a stderr heading inside stdout in the stdout section', () => {
    const { text, outcome } = commandResult('a\n\nstderr:\nb', 'c', 1);
    const sections = commandOutputSections(text, outcome);
    expect(texts(sections.stdout)).toEqual(['a', '', 'stderr:', 'b']);
    expect(texts(sections.stderr)).toEqual(['c']);
  });

  it('counts the recovery notice in front of the sections', () => {
    const { text, outcome } = commandResult('', 'execution error: Not authorized\nline two', 1, 'Abu blocked control of Mail.\n\nAllow it in settings.');
    const sections = commandOutputSections(text, outcome);
    expect(sections.stdout).toBeNull();
    expect(texts(sections.stderr)).toEqual(['execution error: Not authorized', 'line two']);
  });

  it('strips ANSI sequences after cutting', () => {
    const { text, outcome } = commandResult('\u001b[31mred\u001b[0m', 'plain', 1);
    expect(outcome.stdout).toEqual([8, 8 + '\u001b[31mred\u001b[0m'.length]);
    const sections = commandOutputSections(text, outcome);
    expect(texts(sections.stdout)).toEqual(['red']);
    expect(texts(sections.stderr)).toEqual(['plain']);
  });

  it('turns the command cut note into its note row', () => {
    const { text, outcome } = commandResult(`first\nsecond\n${COMMAND_OUTPUT_CUT_NOTE}`, '', 0);
    const sections = commandOutputSections(text, outcome);
    expect(sections.stdout).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
      { kind: 'note', note: 'restNotKept' },
    ]);
  });

  it('puts the not-saved note in the section the storage budget cut', () => {
    const { text: full, outcome } = commandResult(`one\ntwo\n${'three '.repeat(40)}`, 'late error', 1);
    const kept = full.slice(0, full.indexOf('two') + 'two'.length);
    const text = `${kept}\n\n${DURABLE_RESULT_OMITTED_NOTE}`;
    expect(outcome.stderr![0]).toBeGreaterThan(text.length);
    const sections = commandOutputSections(text, outcome);
    expect(sections.stdout).toEqual([
      { kind: 'text', text: 'one' },
      { kind: 'text', text: 'two' },
      { kind: 'note', note: 'partNotSaved' },
    ]);
    expect(sections.stderr).toEqual([{ kind: 'note', note: 'partNotSaved' }]);
    expect(sections.whole).toBeNull();
  });

  it('treats a section that starts inside the storage note as not saved', () => {
    const { text: full, outcome } = commandResult('alpha\nbeta', 'gamma', 1);
    const kept = full.slice(0, outcome.stderr![0] - 4);
    const text = `${kept}\n\n${DURABLE_RESULT_OMITTED_NOTE}`;
    expect(outcome.stderr![0]).toBeGreaterThanOrEqual(kept.length);
    expect(outcome.stderr![0]).toBeLessThanOrEqual(text.length);
    const sections = commandOutputSections(text, outcome);
    expect(sections.stderr).toEqual([{ kind: 'note', note: 'partNotSaved' }]);
    expect(sections.stdout).toEqual([
      { kind: 'text', text: 'alpha' },
      { kind: 'text', text: 'beta' },
    ]);
    const rows = [...sections.stdout!, ...sections.stderr!];
    expect(rows.some((row) => row.kind === 'text' && DURABLE_RESULT_OMITTED_NOTE.includes(row.text) && row.text !== '')).toBe(false);
  });

  it("turns each section's omission line into its note row", () => {
    const stdout = ['out 1', 'out 2', `\n${linesOmittedMarker(40)}\n`, 'out 43'].join('\n');
    const stderr = ['err 1', `\n${linesOmittedMarker(7)}\n`, 'err 9', 'err 10'].join('\n');
    const { text, outcome } = commandResult(stdout, stderr, 1);
    const sections = commandOutputSections(text, outcome);
    expect(sections.stdout).toEqual([
      { kind: 'text', text: 'out 1' },
      { kind: 'text', text: 'out 2' },
      { kind: 'note', note: 'linesNotRead', count: 40 },
      { kind: 'text', text: 'out 43' },
    ]);
    expect(sections.stderr).toEqual([
      { kind: 'text', text: 'err 1' },
      { kind: 'note', note: 'linesNotRead', count: 7 },
      { kind: 'text', text: 'err 9' },
      { kind: 'text', text: 'err 10' },
    ]);
  });

  it('shows the whole text without a record', () => {
    const text = 'stdout:\n\u001b[1mbold\u001b[0m\n\nexit code: 0';
    const sections = commandOutputSections(text, undefined);
    expect(texts(sections.whole)).toEqual(['stdout:', 'bold', '', 'exit code: 0']);
    expect(sections.stdout).toBeNull();
    expect(sections.stderr).toBeNull();
  });
});
