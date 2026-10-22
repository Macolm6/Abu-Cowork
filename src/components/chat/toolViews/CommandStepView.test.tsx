// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import type { ReactElement } from 'react';
import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { format, getI18n, initLanguage } from '@/i18n';
import type { CommandOutcome } from '@/types';
import { DURABLE_RESULT_OMITTED_NOTE } from '@/core/session/durableToolResultContent';
import { CommandStepView } from './CommandStepView';

/** The result run_command returns, with the positions it records after joining. */
function commandResult(stdout: string, stderr: string, exitCode: number): { text: string; outcome: CommandOutcome } {
  const outcome: CommandOutcome = { exitCode };
  const parts: string[] = [];
  const nextStart = (): number => (parts.length === 0 ? 0 : parts.join('\n\n').length + 2);
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

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

/** The output area under a section heading. */
function sectionOf(heading: string): HTMLElement {
  const title = screen.getByText(heading);
  const section = title.nextElementSibling;
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

describe('CommandStepView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the command, the output and the error output apart', () => {
    const t = getI18n();
    const { text, outcome } = commandResult('built', 'warning: slow', 1);
    render(<CommandStepView command="npm run build" background={false} status="completed" outcome={outcome} text={text} />);
    expect(screen.getByText('npm run build')).toBeInTheDocument();
    expect(sectionOf(t.task.output)).toHaveTextContent('built');
    const stderr = sectionOf(t.task.errorOutput);
    expect(stderr).toHaveTextContent('warning: slow');
    expect(stderr).toHaveClass('text-danger');
    expect(sectionOf(t.task.output)).not.toHaveClass('text-danger');
  });

  it('copies the command', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { text, outcome } = commandResult('ok', '', 0);
    render(<CommandStepView command="ls -la" background={false} status="completed" outcome={outcome} text={text} />);
    fireEvent.click(screen.getByRole('button', { name: getI18n().chat.copy }));
    expect(writeText).toHaveBeenCalledWith('ls -la');
  });

  it('says there is no output', () => {
    const t = getI18n();
    render(<CommandStepView command="true" background={false} status="completed" outcome={{ exitCode: 0 }} text="exit code: 0" />);
    expect(screen.getByText(t.task.noOutput)).toBeInTheDocument();
    expect(screen.queryByText(t.task.output)).not.toBeInTheDocument();
  });

  it('folds a thirty-line output', () => {
    const { text, outcome } = commandResult(lines(30), '', 0);
    render(<CommandStepView command="seq 30" background={false} status="completed" outcome={outcome} text={text} />);
    expect(screen.queryByText(/line 15/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: format(getI18n().chat.toolResultShowAllLines, { count: 30 }) }));
    expect(screen.getByText(/line 15/)).toBeInTheDocument();
  });

  it('folds one long line of output and of error output by characters', () => {
    const t = getI18n();
    const { text, outcome } = commandResult('a'.repeat(3000), 'b'.repeat(1500), 1);
    render(<CommandStepView command="build" background={false} status="completed" outcome={outcome} text={text} />);
    expect(sectionOf(t.task.output)).toHaveTextContent(format(t.chat.toolResultShowAllChars, { count: 3000 }));
    expect(sectionOf(t.task.errorOutput)).toHaveTextContent(format(t.chat.toolResultShowAllChars, { count: 1500 }));
    fireEvent.click(screen.getByRole('button', { name: format(t.chat.toolResultShowAllChars, { count: 3000 }) }));
    expect(sectionOf(t.task.output)).toHaveTextContent('a'.repeat(3000));
  });

  it('shows only the command while running, with the pending line', () => {
    const t = getI18n();
    render(<CommandStepView command="sleep 5" background={false} status="running" outcome={undefined} text="" />);
    expect(screen.getByText('sleep 5')).toBeInTheDocument();
    expect(screen.getByText(t.task.outputPending)).toBeInTheDocument();
    expect(screen.queryByText(t.task.output)).not.toBeInTheDocument();
  });

  it('shows only the command for a background start and a stopped step', () => {
    const t = getI18n();
    const { text, outcome } = commandResult('server ready', '', 0);
    render(<CommandStepView command="npm run dev" background status="completed" outcome={{ ...outcome, background: true }} text={text} />);
    expect(screen.getByText('npm run dev')).toBeInTheDocument();
    expect(screen.queryByText(t.task.output)).not.toBeInTheDocument();
    expect(screen.queryByText(t.task.outputPending)).not.toBeInTheDocument();
    cleanup();
    render(<CommandStepView command="make" background={false} status="cancelled" outcome={undefined} text="" />);
    expect(screen.getByText('make')).toBeInTheDocument();
    expect(screen.queryByText(t.task.output)).not.toBeInTheDocument();
    expect(screen.queryByText(t.task.outputPending)).not.toBeInTheDocument();
  });

  it('puts the whole text in the output without a record', () => {
    const t = getI18n();
    const text = 'stdout:\nhello\n\nexit code: 0';
    render(<CommandStepView command="echo hello" background={false} status="completed" outcome={undefined} text={text} />);
    expect(screen.getAllByText(t.task.output)).toHaveLength(1);
    const section = sectionOf(t.task.output);
    expect(section).toHaveTextContent('stdout:');
    expect(section).toHaveTextContent('hello');
    expect(section).toHaveTextContent('exit code: 0');
  });

  it('says a part was not saved inside the cut section', () => {
    const t = getI18n();
    const { text: full, outcome } = commandResult(`one\ntwo\n${'three '.repeat(40)}`, 'late error', 1);
    const kept = full.slice(0, full.indexOf('two') + 'two'.length);
    const text = `${kept}\n\n${DURABLE_RESULT_OMITTED_NOTE}`;
    expect(outcome.stderr![0]).toBeGreaterThan(text.length);
    render(<CommandStepView command="build" background={false} status="completed" outcome={outcome} text={text} />);
    const stderr = sectionOf(t.task.errorOutput);
    expect(stderr).toHaveTextContent(new RegExp(`^${t.chat.toolResultPartNotSaved}$`));
  });
});
