// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { format, getI18n } from '@/i18n';
import type { FileChangeHunk } from '@/types/fileChange';
import { DiffLines } from './DiffLines';

afterEach(cleanup);

const editHunk: FileChangeHunk = {
  oldStart: 2,
  oldLines: 9,
  newStart: 2,
  newLines: 9,
  lines: [
    ' line 2', ' line 3', ' line 4',
    '-line 5', '-line 6', '-line 7',
    '+five', '+six', '+seven',
    ' line 8', ' line 9', ' line 10',
  ],
};

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-diff-row]'));
}

function cells(row: HTMLElement): (string | null)[] {
  return Array.from(row.children).map((cell) => cell.textContent);
}

const showAll = (count: number) => format(getI18n().chat.showAllDiffLines, { count });

describe('DiffLines', () => {
  it('renders each line with its old and new line number, its marker and its text', () => {
    const { container } = render(<DiffLines hunks={[editHunk]} />);
    const all = rows(container);

    expect(all).toHaveLength(12);
    expect(cells(all[0])).toEqual(['2', '2', '', 'line 2']);
    expect(cells(all[3])).toEqual(['5', '', '-', 'line 5']);
    expect(cells(all[5])).toEqual(['7', '', '-', 'line 7']);
    expect(cells(all[6])).toEqual(['', '5', '+', 'five']);
    expect(cells(all[8])).toEqual(['', '7', '+', 'seven']);
    expect(cells(all[9])).toEqual(['8', '8', '', 'line 8']);
    expect(cells(all[11])).toEqual(['10', '10', '', 'line 10']);
  });

  it('marks added and deleted rows with the status fills', () => {
    const { container } = render(<DiffLines hunks={[editHunk]} />);
    const all = rows(container);

    expect(all[3]).toHaveAttribute('data-diff-row', 'deleted');
    expect(all[3]).toHaveClass('bg-danger-soft', 'text-danger');
    expect(all[6]).toHaveAttribute('data-diff-row', 'added');
    expect(all[6]).toHaveClass('bg-success-soft', 'text-success');
    expect(all[0]).toHaveAttribute('data-diff-row', 'context');
    expect(all[0]).not.toHaveClass('bg-success-soft');
    expect(all[0]).not.toHaveClass('bg-danger-soft');
  });

  it('numbers a new file from line 1 on the new side only', () => {
    const { container } = render(
      <DiffLines hunks={[{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+# Title', '+Body'] }]} />,
    );
    expect(rows(container).map(cells)).toEqual([
      ['', '1', '+', '# Title'],
      ['', '2', '+', 'Body'],
    ]);
  });

  it('separates hunks with a line and restarts the numbers at each hunk', () => {
    const { container } = render(
      <DiffLines
        hunks={[
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] },
          { oldStart: 40, oldLines: 1, newStart: 40, newLines: 1, lines: ['-z', '+Z'] },
        ]}
      />,
    );
    const all = rows(container);
    expect(all[0]).not.toHaveClass('border-t');
    expect(all[1]).not.toHaveClass('border-t');
    expect(all[2]).toHaveClass('border-t', 'border-separator');
    expect(cells(all[2])).toEqual(['40', '', '-', 'z']);
    expect(cells(all[3])).toEqual(['', '40', '+', 'Z']);
  });

  it('renders nothing for an empty hunk list', () => {
    const { container } = render(<DiffLines hunks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('fold', () => {
    it('shows every row when no fold is given', () => {
      const { container } = render(<DiffLines hunks={[editHunk]} />);
      expect(rows(container)).toHaveLength(12);
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('shows every row when the rows fit the fold', () => {
      const nine = { ...editHunk, lines: editHunk.lines.slice(0, 9) };
      const { container } = render(<DiffLines hunks={[nine]} fold={{ head: 5, tail: 4 }} />);
      expect(rows(container)).toHaveLength(9);
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('shows the first five and the last four rows around a button that shows all', () => {
      const { container } = render(<DiffLines hunks={[editHunk]} fold={{ head: 5, tail: 4 }} />);

      const folded = rows(container);
      expect(folded.map((row) => cells(row)[3])).toEqual([
        'line 2', 'line 3', 'line 4', 'line 5', 'line 6',
        'seven', 'line 8', 'line 9', 'line 10',
      ]);
      const button = screen.getByRole('button', { name: showAll(12) });
      expect(folded[4].compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(button.compareDocumentPosition(folded[5]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      fireEvent.click(button);

      expect(rows(container)).toHaveLength(12);
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('keeps the line numbers of the rows after the fold', () => {
      const { container } = render(<DiffLines hunks={[editHunk]} fold={{ head: 5, tail: 4 }} />);
      expect(cells(rows(container)[8])).toEqual(['10', '10', '', 'line 10']);
    });
  });

  describe('cut', () => {
    it('closes with the note when every saved row is shown', () => {
      render(<DiffLines hunks={[{ ...editHunk, lines: editHunk.lines.slice(0, 4) }]} cut />);
      expect(screen.getByText(getI18n().chat.diffCut)).toBeInTheDocument();
    });

    it('shows the note only after the folded rows are shown', () => {
      const { container } = render(<DiffLines hunks={[editHunk]} fold={{ head: 5, tail: 4 }} cut />);
      expect(screen.queryByText(getI18n().chat.diffCut)).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: showAll(12) }));

      const note = screen.getByText(getI18n().chat.diffCut);
      const last = rows(container)[11];
      expect(last.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows no note for a change that was not cut', () => {
      render(<DiffLines hunks={[editHunk]} />);
      expect(screen.queryByText(getI18n().chat.diffCut)).toBeNull();
    });
  });
});
