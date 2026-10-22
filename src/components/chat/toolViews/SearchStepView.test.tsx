// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { format, getI18n, initLanguage } from '@/i18n';
import { SearchStepView } from './SearchStepView';

/** The match lines search_files writes for `perFile` matches in each named file. */
function matchLines(perFile: Array<[string, number]>): string[] {
  const lines: string[] = [];
  for (const [path, count] of perFile) {
    for (let index = 0; index < count; index++) lines.push(`${path}:${12 + index}:  match ${path} ${index}`);
  }
  return lines;
}

const FILES: Array<[string, number]> = [['src/a.ts', 5], ['src/b.ts', 4], ['src/c.ts', 4], ['src/d.ts', 4]];
const SEVENTEEN = `Found 17 matches:\n${matchLines(FILES).join('\n')}`;

const groupHeader = (path: string, count: number) =>
  screen.queryByRole('button', { name: `${path} ${format(getI18n().task.searchGroupCount, { count })}` });

describe('SearchStepView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
  });

  it('heads the view with the matches and the files, grouped by file', () => {
    const t = getI18n();
    render(<SearchStepView pattern="useEffect" status="completed" text={SEVENTEEN} />);
    expect(screen.getByText('useEffect')).toBeInTheDocument();
    expect(screen.getByText('17 处匹配 · 4 个文件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: format(t.chat.toolResultShowAllLines, { count: 17 }) }));
    for (const [path, count] of FILES) {
      expect(groupHeader(path, count)).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByText('match src/b.ts 2')).toBeInTheDocument();
    expect(screen.getAllByText('14')).toHaveLength(4);
  });

  it('folds the rows across files and hides a group without visible rows', () => {
    const t = getI18n();
    render(<SearchStepView pattern="useEffect" status="completed" text={SEVENTEEN} />);
    expect(groupHeader('src/a.ts', 5)).toBeInTheDocument();
    expect(groupHeader('src/d.ts', 4)).toBeInTheDocument();
    expect(groupHeader('src/b.ts', 4)).not.toBeInTheDocument();
    expect(groupHeader('src/c.ts', 4)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: format(t.chat.toolResultShowAllLines, { count: 17 }) }));
    expect(groupHeader('src/b.ts', 4)).toBeInTheDocument();
    expect(groupHeader('src/c.ts', 4)).toBeInTheDocument();
  });

  it('collapses one group on its header', () => {
    render(<SearchStepView pattern="useEffect" status="completed" text={SEVENTEEN} />);
    expect(screen.getByText('match src/a.ts 0')).toBeInTheDocument();
    fireEvent.click(groupHeader('src/a.ts', 5)!);
    expect(groupHeader('src/a.ts', 5)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('match src/a.ts 0')).not.toBeInTheDocument();
    expect(groupHeader('src/d.ts', 4)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('match src/d.ts 0')).toBeInTheDocument();
  });

  it('says there are no matches, and nothing else', () => {
    const t = getI18n();
    const { container } = render(<SearchStepView pattern="nowhere" status="completed" text="No matches found." />);
    expect(container.textContent).toBe(t.task.searchNoMatches);
    expect(container.querySelector('[data-tool-result]')).toBeNull();
  });

  it('says the results were capped', () => {
    const lines = matchLines([['src/a.ts', 100]]);
    render(<SearchStepView pattern="x" status="completed" text={`Found 100+ matches:\n${lines.join('\n')}`} />);
    expect(screen.getByText('显示 100 处匹配，还有更多没有列出')).toBeInTheDocument();
  });

  it('shows only the pattern while running', () => {
    const { container } = render(<SearchStepView pattern="useEffect" status="running" text="" />);
    expect(container.textContent).toBe('useEffect');
  });
});
