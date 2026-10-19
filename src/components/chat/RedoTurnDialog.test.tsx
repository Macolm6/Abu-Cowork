// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { format, getI18n, initLanguage } from '@/i18n';
import type { TurnUndoPlan } from '@/core/session/turnUndo';
import RedoTurnDialog, { type RedoEntry } from './RedoTurnDialog';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const PLAN: TurnUndoPlan = {
  willRestore: [
    { path: '/ws/a.md', display: 'a.md', action: 'write-before' },
    { path: '/ws/b.md', display: 'b.md', action: 'put-back' },
    { path: '/ws/c.md', display: 'c.md', action: 'trash' },
  ],
  wontRestore: [
    { path: '/ws/build.sh', display: 'build.sh', reason: 'by-command' },
    { path: '/ws/notes.md', display: 'notes.md', reason: 'changed-since' },
  ],
};

type Props = ComponentProps<typeof RedoTurnDialog>;

const props = (overrides: Partial<Props> = {}): Props => ({
  open: true,
  entry: 'regenerate',
  laterTurnsCount: 0,
  plan: PLAN,
  restoreFiles: true,
  onRestoreFilesChange: vi.fn(),
  busy: false,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  ...overrides,
});

const lines = (testId: string): string[][] => within(screen.getByTestId(testId))
  .getAllByRole('listitem')
  .map((item) => [...item.children].map((child) => child.textContent ?? ''));

describe('RedoTurnDialog', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    initLanguage('en-US');
  });

  it.each<[RedoEntry, 'redoRegenerateTitle' | 'redoEditTitle' | 'redoRetryTitle' | 'redoResendTitle', 'redoRegenerateConfirm' | 'redoEditConfirm' | 'redoRetryConfirm' | 'redoResendConfirm']>([
    ['regenerate', 'redoRegenerateTitle', 'redoRegenerateConfirm'],
    ['edit-resend', 'redoEditTitle', 'redoEditConfirm'],
    ['retry', 'redoRetryTitle', 'redoRetryConfirm'],
    ['resend', 'redoResendTitle', 'redoResendConfirm'],
  ])('titles and confirms each entry with its own words (%s)', (entry, title, confirm) => {
    const chat = getI18n().chat;
    render(<RedoTurnDialog {...props({ entry })} />);

    const dialog = screen.getByRole('alertdialog', { name: chat[title] });
    expect(dialog).toBe(screen.getByTestId('redo-turn-dialog'));
    expect(within(dialog).getByRole('button', { name: chat[confirm] })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: getI18n().common.cancel })).toBeEnabled();
  });

  it('says how many later turns are deleted only when there are some', () => {
    const chat = getI18n().chat;
    const { rerender } = render(<RedoTurnDialog {...props({ laterTurnsCount: 2 })} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(format(chat.redoLaterTurns, { count: 2 }));

    rerender(<RedoTurnDialog {...props({ laterTurnsCount: 0 })} />);
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(format(chat.redoLaterTurns, { count: 0 }));
  });

  it('shows the restore option checked, with the note and the lists only while checked', () => {
    const chat = getI18n().chat;
    const onRestoreFilesChange = vi.fn();
    const { rerender } = render(<RedoTurnDialog {...props({ onRestoreFilesChange })} />);

    const dialog = screen.getByRole('alertdialog');
    const box = within(dialog).getByRole('checkbox', { name: chat.redoRestoreFiles });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(`${chat.redoNoPutBack} ${chat.redoCommandNotRestored}`);
    expect(dialog).toHaveTextContent(chat.redoNoPutBack);
    expect(dialog).toHaveTextContent(chat.redoCommandNotRestored);
    expect(dialog).toHaveTextContent(format(chat.undoConfirmCount, { count: PLAN.willRestore.length }));
    expect(lines('redo-turn-will')).toEqual([
      ['a.md', chat.undoActionWriteBefore],
      ['b.md', chat.undoActionPutBack],
      ['c.md', chat.undoActionTrash],
    ]);
    expect(within(dialog).getByRole('list', { name: chat.undoWontRestore })).toBe(screen.getByTestId('redo-turn-wont'));
    expect(lines('redo-turn-wont')).toEqual([
      ['build.sh', chat.undoReasonByCommand],
      ['notes.md', chat.undoReasonChangedSince],
    ]);

    fireEvent.click(box);
    expect(onRestoreFilesChange).toHaveBeenCalledTimes(1);
    expect(onRestoreFilesChange).toHaveBeenCalledWith(false);

    rerender(<RedoTurnDialog {...props({ onRestoreFilesChange, restoreFiles: false })} />);
    expect(screen.getByRole('checkbox', { name: chat.redoRestoreFiles })).not.toBeChecked();
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(chat.redoNoPutBack);
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(chat.redoCommandNotRestored);
    expect(screen.getByRole('checkbox', { name: chat.redoRestoreFiles })).not.toHaveAttribute('aria-describedby');
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(format(chat.undoConfirmCount, { count: PLAN.willRestore.length }));
    expect(screen.queryByTestId('redo-turn-will')).toBeNull();
    expect(screen.queryByTestId('redo-turn-wont')).toBeNull();
  });

  it('has no restore option when nothing can be restored', () => {
    const plan: TurnUndoPlan = {
      willRestore: [],
      wontRestore: [{ path: '/ws/build.sh', display: 'build.sh', reason: 'by-command' }],
    };
    render(<RedoTurnDialog {...props({ plan, laterTurnsCount: 1 })} />);

    expect(screen.getByRole('alertdialog')).toHaveTextContent(format(getI18n().chat.redoLaterTurns, { count: 1 }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(getI18n().chat.redoCommandNotRestored);
    expect(screen.queryByTestId('redo-turn-will')).toBeNull();
    expect(screen.queryByTestId('redo-turn-wont')).toBeNull();
  });

  it('opens on Cancel; Escape and Cancel answer no', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<RedoTurnDialog {...props({ onConfirm, onCancel })} />);

    const cancel = screen.getByRole('button', { name: getI18n().common.cancel });
    expect(cancel).toHaveFocus();

    await userEvent.setup().keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('answers yes once on the confirming button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<RedoTurnDialog {...props({ onConfirm, onCancel })} />);

    fireEvent.click(screen.getByRole('button', { name: getI18n().chat.redoRegenerateConfirm }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keeps the question while it restores', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<RedoTurnDialog {...props({ busy: true, onConfirm, onCancel })} />);

    const confirm = screen.getByRole('button', { name: getI18n().chat.redoRegenerateConfirm });
    // The ds mark of a busy button: focusable, and it acts on no press.
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: getI18n().common.cancel })).toBeDisabled();

    await userEvent.setup().keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    render(<RedoTurnDialog {...props({ open: false })} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
