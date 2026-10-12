// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import type { TurnUndoPlan } from '@/core/session/turnUndo';
import TurnUndoDialog from './TurnUndoDialog';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const UNDO_PLAN: TurnUndoPlan = {
  willRestore: [
    { path: '/ws/new.md', display: 'new.md', action: 'trash' },
    { path: '/ws/old.md', display: 'old.md', action: 'put-back' },
    { path: '/ws/plan.md', display: 'plan.md', action: 'write-before' },
  ],
  wontRestore: [
    { path: '/ws/big.log', display: 'big.log', reason: 'too-large' },
    { path: '/ws/build.sh', display: 'build.sh', reason: 'by-command' },
    { path: '/ws/docs/gone.md', display: 'docs/gone.md', reason: 'folder-gone' },
    { path: '/ws/notes.md', display: 'notes.md', reason: 'changed-since' },
  ],
};

const REAPPLY_PLAN: TurnUndoPlan = {
  willRestore: [
    { path: '/ws/new.md', display: 'new.md', action: 'put-back' },
    { path: '/ws/old.md', display: 'old.md', action: 'trash' },
    { path: '/ws/plan.md', display: 'plan.md', action: 'write-after' },
  ],
  wontRestore: [
    { path: '/ws/docs/gone.md', display: 'docs/gone.md', reason: 'folder-gone' },
    { path: '/ws/notes.md', display: 'notes.md', reason: 'changed-since' },
  ],
};

const lines = (testId: string): string[][] => within(screen.getByTestId(testId))
  .getAllByRole('listitem')
  .map((item) => [...item.children].map((child) => child.textContent ?? ''));

describe('TurnUndoDialog', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    initLanguage('en-US');
  });

  it('asks about undoing with the count, each file with what happens to it, and the files left alone with the reason', () => {
    render(<TurnUndoDialog open direction="undo" plan={UNDO_PLAN} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const dialog = screen.getByRole('alertdialog', { name: '撤销这一轮的文件改动？' });
    expect(dialog).toHaveTextContent('3 个文件会恢复到这一轮开始之前');
    expect(lines('turn-undo-will')).toEqual([
      ['new.md', '移到废纸篓'],
      ['old.md', '恢复到原来的位置'],
      ['plan.md', '恢复为修改前的内容'],
    ]);
    expect(within(dialog).getByRole('list', { name: '不会恢复' })).toBe(screen.getByTestId('turn-undo-wont'));
    expect(lines('turn-undo-wont')).toEqual([
      ['big.log', '这份文件过大，没有保存修改前的内容'],
      ['build.sh', '这份文件是用命令改动的，没有保存修改前的内容'],
      ['docs/gone.md', '原来的文件夹已经不在'],
      ['notes.md', '这份文件在这一轮之后又被改过'],
    ]);
    expect(within(dialog).getByRole('button', { name: '撤销' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('asks about putting back with the count, each file with what happens to it, and the files left alone with the reason', () => {
    render(<TurnUndoDialog open direction="reapply" plan={REAPPLY_PLAN} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const dialog = screen.getByRole('alertdialog', { name: '把这一轮的改动放回来？' });
    expect(dialog).toHaveTextContent('3 个文件会回到撤销之前的样子');
    expect(lines('turn-undo-will')).toEqual([
      ['new.md', '放回原来的位置'],
      ['old.md', '移到废纸篓'],
      ['plan.md', '放回阿布改完的内容'],
    ]);
    expect(within(dialog).getByRole('list', { name: '不会放回' })).toBe(screen.getByTestId('turn-undo-wont'));
    expect(lines('turn-undo-wont')).toEqual([
      ['docs/gone.md', '原来的文件夹已经不在'],
      ['notes.md', '这份文件在撤销之后又被改过'],
    ]);
    expect(within(dialog).getByRole('button', { name: '放回改动' })).toBeEnabled();
  });

  it('shows no group of files left alone when every file will be restored', () => {
    render(<TurnUndoDialog open direction="undo" plan={{ ...UNDO_PLAN, wontRestore: [] }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('turn-undo-wont')).toBeNull();
    expect(screen.queryByText('不会恢复')).toBeNull();
  });

  it('offers no confirmation when no file will be restored', () => {
    render(<TurnUndoDialog open direction="undo" plan={{ ...UNDO_PLAN, willRestore: [] }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('0 个文件会恢复到这一轮开始之前');
    expect(screen.queryByTestId('turn-undo-will')).toBeNull();
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
  });

  it('opens with the focus on Cancel', () => {
    render(<TurnUndoDialog open direction="undo" plan={UNDO_PLAN} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
  });

  it('answers no on Escape', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<TurnUndoDialog open direction="undo" plan={UNDO_PLAN} onConfirm={onConfirm} onCancel={onCancel} />);

    await userEvent.setup().keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('answers no on Cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<TurnUndoDialog open direction="reapply" plan={REAPPLY_PLAN} onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('answers yes once on the confirming button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<TurnUndoDialog open direction="undo" plan={UNDO_PLAN} onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    render(<TurnUndoDialog open={false} direction="undo" plan={UNDO_PLAN} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
