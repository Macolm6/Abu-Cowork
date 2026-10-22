// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { format, getI18n, initLanguage } from '@/i18n';
import type { PathListRow } from '@/utils/toolViews/pathListView';
import { PathListStepView } from './PathListStepView';

interface MockVirtuosoProps {
  data?: PathListRow[];
  itemContent?: (index: number, row: PathListRow) => ReactNode;
  className?: string;
}

const harness = vi.hoisted(() => ({
  props: null as MockVirtuosoProps | null,
}));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: function MockVirtuoso(props: MockVirtuosoProps) {
      harness.props = props;
      return React.createElement(
        'div',
        { 'data-testid': 'mock-virtuoso' },
        ...(props.data ?? []).map((row, index) => React.createElement(
          'div',
          { 'data-index': String(index), key: index },
          props.itemContent?.(index, row),
        )),
      );
    },
  };
});

const PATHS = Array.from({ length: 23 }, (_, i) => `/work/src/file-${i + 1}.ts`);

describe('PathListStepView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    harness.props = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('lists the found files under their count', () => {
    const t = getI18n();
    render(<PathListStepView kind="find" subject="*.ts" status="completed" text={`Found 23 files:\n${PATHS.join('\n')}`} />);
    expect(screen.getByText('*.ts')).toBeInTheDocument();
    expect(screen.getByText('23 个文件')).toBeInTheDocument();
    expect(screen.getByText('/work/src/file-1.ts')).toBeInTheDocument();
    expect(screen.queryByText('/work/src/file-12.ts')).not.toBeInTheDocument();
    expect(harness.props).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: format(t.chat.toolResultShowAllLines, { count: 23 }) }));
    expect(harness.props?.data).toHaveLength(23);
    expect(harness.props?.className).toBe('h-[300px]');
    // The list scrolls inside the 300px Virtuoso alone: its box adds no vertical padding around it.
    const box = screen.getByTestId('mock-virtuoso').closest('[data-tool-result]');
    expect(box).toHaveClass('py-0');
    expect(box).not.toHaveClass('py-2');
    expect(box).not.toHaveClass('pb-2');
    const shown = Array.from(screen.getByTestId('mock-virtuoso').children, (item) => item.textContent);
    expect(shown).toEqual(PATHS);
  });

  it('lists directory entries with a folder or a file icon', () => {
    const lines = [
      ...Array.from({ length: 4 }, (_, i) => `[DIR] folder-${i + 1}`),
      ...Array.from({ length: 8 }, (_, i) => `[FILE] note-${i + 1}.md`),
    ];
    render(<PathListStepView kind="list" subject="/work" status="completed" text={lines.join('\n')} />);
    expect(screen.getByText('12 个条目')).toBeInTheDocument();
    const folderIcon = screen.getByText('folder-1').parentElement?.querySelector('svg');
    const fileIcon = screen.getByText('note-8.md').parentElement?.querySelector('svg');
    expect(folderIcon).toBeTruthy();
    expect(fileIcon).toBeTruthy();
    expect(folderIcon!.innerHTML).not.toBe(fileIcon!.innerHTML);
    expect(screen.getByText('folder-2').parentElement?.querySelector('svg')?.innerHTML).toBe(folderIcon!.innerHTML);
  });

  it('says the folder is empty, and nothing else', () => {
    const t = getI18n();
    const { container } = render(<PathListStepView kind="list" subject="/work/empty" status="completed" text='Directory "/work/empty" is empty.' />);
    expect(container.textContent).toBe(t.task.directoryEmpty);
    expect(container.querySelector('[data-tool-result]')).toBeNull();
  });

  it('shows zero files as a count', () => {
    render(<PathListStepView kind="find" subject="*.zzz" status="completed" text="No files found matching the pattern." />);
    expect(screen.getByText('0 个文件')).toBeInTheDocument();
  });

  it('shows only the subject while running', () => {
    const { container } = render(<PathListStepView kind="find" subject="*.ts" status="running" text="" />);
    expect(container.textContent).toBe('*.ts');
  });
});
