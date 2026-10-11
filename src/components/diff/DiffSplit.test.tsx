// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import type { FileChangeHunk } from '@/types/fileChange';
import { DiffSplit } from './DiffSplit';

/** Each pair as `[before, after]`, a side as `number kind text` or null when it is empty. */
function pairs(): Array<[string | null, string | null]> {
  return [...document.querySelectorAll('[data-diff-pair]')].map((pair) => {
    const side = (name: string): string | null => {
      const cell = pair.querySelector(`[data-diff-side="${name}"]`);
      const kind = cell?.getAttribute('data-diff-row');
      if (!cell || !kind) return null;
      const number = cell.querySelector('[data-diff-number]')?.textContent ?? '';
      const text = cell.querySelector('[data-diff-text]')?.textContent ?? '';
      return `${number} ${kind} ${text}`;
    };
    return [side('before'), side('after')];
  });
}

describe('DiffSplit', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    initLanguage('en-US');
  });

  it('puts the text before the change on the left and the text after it on the right, with line numbers', () => {
    const hunks: FileChangeHunk[] = [
      { oldStart: 4, oldLines: 3, newStart: 4, newLines: 3, lines: [' intro', '-old line', '+new line', ' outro'] },
    ];
    render(<DiffSplit hunks={hunks} />);

    expect(pairs()).toEqual([
      ['4 context intro', '4 context intro'],
      ['5 deleted old line', '5 added new line'],
      ['6 context outro', '6 context outro'],
    ]);
  });

  it('pairs a run of deleted lines with the added lines that follow it, row by row', () => {
    const hunks: FileChangeHunk[] = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 1, lines: ['-a', '-b', '-c', '+A'] },
    ];
    render(<DiffSplit hunks={hunks} />);

    expect(pairs()).toEqual([
      ['1 deleted a', '1 added A'],
      ['2 deleted b', null],
      ['3 deleted c', null],
    ]);
  });

  it('leaves the left side empty for lines that were only added', () => {
    const hunks: FileChangeHunk[] = [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: [' keep', '+one', '+two'] },
    ];
    render(<DiffSplit hunks={hunks} />);

    expect(pairs()).toEqual([
      ['1 context keep', '1 context keep'],
      [null, '2 added one'],
      [null, '3 added two'],
    ]);
  });

  it('does not pair a deleted line with an added line across a context line', () => {
    const hunks: FileChangeHunk[] = [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-gone', ' keep', '+new'] },
    ];
    render(<DiffSplit hunks={hunks} />);

    expect(pairs()).toEqual([
      ['1 deleted gone', null],
      ['2 context keep', '1 context keep'],
      [null, '2 added new'],
    ]);
  });

  it('continues the line numbers of each hunk from its own start and marks where a later hunk begins', () => {
    const hunks: FileChangeHunk[] = [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] },
      { oldStart: 40, oldLines: 1, newStart: 41, newLines: 1, lines: ['-z', '+Z'] },
    ];
    render(<DiffSplit hunks={hunks} />);

    expect(pairs()).toEqual([
      ['1 deleted a', '1 added A'],
      ['40 deleted z', '41 added Z'],
    ]);
    const rows = [...document.querySelectorAll('[data-diff-pair]')];
    expect(rows[0]).not.toHaveAttribute('data-diff-hunk-start');
    expect(rows[1]).toHaveAttribute('data-diff-hunk-start');
  });

  it('closes with the cut line when the hunks stop before the end of the change', () => {
    const hunks: FileChangeHunk[] = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }];
    const { rerender } = render(<DiffSplit hunks={hunks} />);
    expect(screen.queryByText('对比过长，只显示前面的部分')).toBeNull();

    rerender(<DiffSplit hunks={hunks} cut />);
    expect(screen.getByText('对比过长，只显示前面的部分')).toBeInTheDocument();
  });

  it('renders nothing for no hunks', () => {
    const { container } = render(<DiffSplit hunks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
