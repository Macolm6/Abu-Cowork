// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { foldRowList } from '@/utils/toolResultFold';
import { FoldedRows } from './FoldedRows';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

const renderRows = (rows: readonly string[]) => rows.map((row) => <div key={row}>{row}</div>);

describe('FoldedRows', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the start and the end with the button, then everything', () => {
    render(<FoldedRows fold={foldRowList(lines(12), () => true)} renderRows={renderRows} />);
    for (const line of ['line 1', 'line 5', 'line 9', 'line 12']) expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByText('line 7')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '显示全部 12 行' }));
    expect(screen.getByText('line 7')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a short list whole without a button', () => {
    const { container } = render(<FoldedRows fold={foldRowList(lines(3), () => true)} renderRows={renderRows} className="text-label" />);
    for (const line of lines(3)) expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const root = container.querySelector('[data-tool-result]');
    expect(root).toHaveClass('max-h-[300px]', 'overflow-y-auto', 'px-3', 'py-2', 'text-label');
  });

  it('hands everything to renderAll once pressed', () => {
    const fold = foldRowList(lines(12), () => true);
    const renderAll = vi.fn((rows: readonly string[]) => <div>all {rows.length}</div>);
    render(<FoldedRows fold={fold} renderRows={renderRows} renderAll={renderAll} />);
    expect(renderAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '显示全部 12 行' }));
    expect(renderAll).toHaveBeenCalledWith(fold.rows);
    expect(screen.getByText('all 12')).toBeInTheDocument();
  });
});
