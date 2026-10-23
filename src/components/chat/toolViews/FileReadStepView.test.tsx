// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { format, getI18n, initLanguage } from '@/i18n';
import { charsOmittedMarker } from '@/core/context/truncation';
import { DURABLE_RESULT_OMITTED_NOTE } from '@/core/session/durableToolResultContent';
import { FileReadStepView } from './FileReadStepView';

const rows = (n: number, prefix = 'row') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

/** Every line number shown, in order; an unnumbered line is ''. */
function shownNumbers(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-line-numbers]')).flatMap((pre) => (pre.textContent ?? '').split('\n'));
}

describe('FileReadStepView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
  });

  it('numbers a whole read and says how many lines', () => {
    const t = getI18n();
    const { container } = render(
      <FileReadStepView
        path="/work/a.ts"
        status="completed"
        outcome={{ kind: 'text', startLine: 1, lineCount: 120, totalLines: 120, bodyStart: 0 }}
        text={rows(120)}
      />,
    );
    expect(screen.getByText(format(t.task.readAllLines, { count: 120 }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: format(t.chat.toolResultShowAllLines, { count: 120 }) }));
    const numbers = shownNumbers(container);
    expect(numbers).toHaveLength(120);
    expect(numbers[0]).toBe('1');
    expect(numbers.at(-1)).toBe('120');
    expect(screen.getByText(/row 60/)).toBeInTheDocument();
  });

  it('starts the numbers at the range', () => {
    const t = getI18n();
    const header = '[File: /work/big.ts | 40 KB | Lines 199-298 of 1500 total]';
    const { container } = render(
      <FileReadStepView
        path="/work/big.ts"
        status="completed"
        outcome={{ kind: 'text', startLine: 200, lineCount: 100, totalLines: 1500, bodyStart: header.length + 1 }}
        text={`${header}\n${rows(100)}`}
      />,
    );
    expect(screen.getByText(format(t.task.readLineRange, { start: 200, end: 299, total: 1500 }))).toBeInTheDocument();
    expect(shownNumbers(container)[0]).toBe('200');
    expect(screen.queryByText(/\[File:/)).not.toBeInTheDocument();
  });

  it('leaves the number cell empty for a line without a number', () => {
    const text = ['l1', 'l2', '', charsOmittedMarker(9000), '', 'tail', '', DURABLE_RESULT_OMITTED_NOTE].join('\n');
    const { container } = render(
      <FileReadStepView
        path="/work/c.ts"
        status="completed"
        outcome={{ kind: 'text', startLine: 1, lineCount: 400, totalLines: 400, bodyStart: 0 }}
        text={text}
      />,
    );
    expect(shownNumbers(container)).toEqual(['1', '2', '']);
    expect(screen.getByText('tail')).toBeInTheDocument();
  });

  it('shows a document without numbers or a header', () => {
    const { container } = render(
      <FileReadStepView path="/work/report.docx" status="completed" outcome={{ kind: 'document' }} text={'Title\nParagraph one'} />,
    );
    expect(container.querySelector('[data-line-numbers]')).toBeNull();
    expect(screen.queryByText(/共/)).not.toBeInTheDocument();
    expect(screen.getByText(/Paragraph one/)).toBeInTheDocument();
  });

  it('shows the notice as it is', () => {
    const notice = 'This file is binary and was not read as text.';
    const { container } = render(
      <FileReadStepView path="/work/app.bin" status="completed" outcome={{ kind: 'notice' }} text={notice} />,
    );
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(container.querySelector('[data-line-numbers]')).toBeNull();
  });

  it('shows only the path while running', () => {
    const { container } = render(<FileReadStepView path="/work/a.ts" status="running" outcome={undefined} text="" />);
    expect(screen.getByText('/work/a.ts')).toBeInTheDocument();
    expect(container.textContent).toBe('/work/a.ts');
    expect(container.querySelector('[data-tool-result]')).toBeNull();
  });
});
