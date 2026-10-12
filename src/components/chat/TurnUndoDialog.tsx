import { useId } from 'react';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { format, useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type {
  TurnUndoAction,
  TurnUndoDirection,
  TurnUndoPlan,
  TurnUndoSkipReason,
} from '@/core/session/turnUndo';

function actionLabel(t: TranslationDict, direction: TurnUndoDirection, action: TurnUndoAction): string {
  if (direction === 'undo') {
    if (action === 'trash') return t.chat.undoActionTrash;
    if (action === 'put-back') return t.chat.undoActionPutBack;
    return t.chat.undoActionWriteBefore;
  }
  if (action === 'trash') return t.chat.reapplyActionTrash;
  if (action === 'put-back') return t.chat.reapplyActionPutBack;
  return t.chat.reapplyActionWriteAfter;
}

function reasonLabel(t: TranslationDict, direction: TurnUndoDirection, reason: TurnUndoSkipReason): string {
  if (reason === 'by-command') return t.chat.undoReasonByCommand;
  if (reason === 'too-large') return t.chat.undoReasonTooLarge;
  if (reason === 'folder-gone') return t.chat.undoReasonFolderGone;
  if (reason === 'not-authorized') return t.chat.undoReasonNotAuthorized;
  return direction === 'undo' ? t.chat.undoReasonChangedSince : t.chat.reapplyReasonChangedSince;
}

function FileLine({ display, note }: { display: string; note: string }) {
  return (
    <li className="py-1">
      <div className="break-all text-ui text-label">{display}</div>
      <div className="text-ui-sm text-label-secondary">{note}</div>
    </li>
  );
}

/**
 * The question before a turn's file changes are undone, or put back: the files
 * that will be written, each with what happens to it, and the files that are
 * left as they are, each with the reason. It opens on Cancel; Escape and
 * Cancel answer no. The owner closes it by `open` and keeps `plan` while it
 * fades.
 */
export default function TurnUndoDialog({ open, direction, plan, onConfirm, onCancel }: {
  open: boolean;
  direction: TurnUndoDirection;
  plan: TurnUndoPlan;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const skippedHeading = useId();
  const undoing = direction === 'undo';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onCancel(); }}
      role="alertdialog"
      title={undoing ? t.chat.undoConfirmTitle : t.chat.reapplyConfirmTitle}
      description={format(undoing ? t.chat.undoConfirmCount : t.chat.reapplyConfirmCount, { count: plan.willRestore.length })}
      initialFocus={(content) => content.querySelector<HTMLElement>('[data-turn-undo-cancel]')}
      contentProps={{ 'data-testid': 'turn-undo-dialog' }}
      footer={(
        <>
          <Button variant="secondary" data-turn-undo-cancel onClick={onCancel}>{t.common.cancel}</Button>
          <Button variant="primary" disabled={plan.willRestore.length === 0} onClick={onConfirm}>
            {undoing ? t.chat.undoTurn : t.chat.reapplyTurn}
          </Button>
        </>
      )}
    >
      {plan.willRestore.length > 0 && (
        <ul data-testid="turn-undo-will">
          {plan.willRestore.map((file) => (
            <FileLine key={file.path} display={file.display} note={actionLabel(t, direction, file.action)} />
          ))}
        </ul>
      )}
      {plan.wontRestore.length > 0 && (
        <section className="mt-3 border-t border-separator pt-3">
          <h3 id={skippedHeading} className="text-ui font-medium text-label">
            {undoing ? t.chat.undoWontRestore : t.chat.reapplyWontPutBack}
          </h3>
          <ul data-testid="turn-undo-wont" aria-labelledby={skippedHeading}>
            {plan.wontRestore.map((file) => (
              <FileLine key={file.path} display={file.display} note={reasonLabel(t, direction, file.reason)} />
            ))}
          </ul>
        </section>
      )}
    </Dialog>
  );
}
