import { useId } from 'react';
import { Button } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { Dialog } from '@/components/ds/dialog';
import { format, useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { TurnUndoPlan } from '@/core/session/turnUndo';
import { actionLabel, FileLine, reasonLabel } from './TurnUndoDialog';

export type RedoEntry = 'regenerate' | 'edit-resend' | 'retry' | 'resend';

function entryWords(t: TranslationDict, entry: RedoEntry): { title: string; confirm: string } {
  if (entry === 'edit-resend') return { title: t.chat.redoEditTitle, confirm: t.chat.redoEditConfirm };
  if (entry === 'retry') return { title: t.chat.redoRetryTitle, confirm: t.chat.redoRetryConfirm };
  if (entry === 'resend') return { title: t.chat.redoResendTitle, confirm: t.chat.redoResendConfirm };
  return { title: t.chat.redoRegenerateTitle, confirm: t.chat.redoRegenerateConfirm };
}

/**
 * The question before a turn is redone: how many later turns go with it, and, when files of
 * these turns can be restored, the option to restore them first, with the files that will be
 * restored and the files left as they are. It opens on Cancel; Escape and Cancel answer no.
 * While the files are restored (`busy`) only the restore itself ends it. The owner holds the
 * option's state and closes the dialog by `open`.
 */
export default function RedoTurnDialog({
  open, entry, laterTurnsCount, plan, restoreFiles, onRestoreFilesChange, busy, onConfirm, onCancel,
}: {
  open: boolean;
  entry: RedoEntry;
  laterTurnsCount: number;
  plan: TurnUndoPlan;
  restoreFiles: boolean;
  onRestoreFilesChange: (next: boolean) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const noteId = useId();
  const skippedHeading = useId();
  const words = entryWords(t, entry);
  const canRestore = plan.willRestore.length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) onCancel(); }}
      role="alertdialog"
      busy={busy}
      title={words.title}
      description={laterTurnsCount > 0 ? format(t.chat.redoLaterTurns, { count: laterTurnsCount }) : undefined}
      initialFocus={(content) => content.querySelector<HTMLElement>('[data-redo-turn-cancel]')}
      contentProps={{ 'data-testid': 'redo-turn-dialog' }}
      footer={(
        <>
          <Button variant="secondary" data-redo-turn-cancel disabled={busy} onClick={onCancel}>{t.common.cancel}</Button>
          <Button variant="primary" busy={busy} onClick={onConfirm}>{words.confirm}</Button>
        </>
      )}
    >
      {canRestore && (
        <>
          <div>
            <Checkbox
              checked={restoreFiles}
              onCheckedChange={onRestoreFilesChange}
              label={t.chat.redoRestoreFiles}
              aria-describedby={restoreFiles ? noteId : undefined}
            />
            {restoreFiles && (
              <p id={noteId} className="mt-1 pl-6 text-ui-sm text-label-secondary">{t.chat.redoNoPutBack}</p>
            )}
          </div>
          {restoreFiles && (
            <section className="mt-3 border-t border-separator pt-3">
              <p className="text-ui text-label">{format(t.chat.undoConfirmCount, { count: plan.willRestore.length })}</p>
              <ul data-testid="redo-turn-will" className="mt-1">
                {plan.willRestore.map((file) => (
                  <FileLine key={file.path} display={file.display} note={actionLabel(t, 'undo', file.action)} />
                ))}
              </ul>
              {plan.wontRestore.length > 0 && (
                <div className="mt-3 border-t border-separator pt-3">
                  <h3 id={skippedHeading} className="text-ui font-medium text-label">{t.chat.undoWontRestore}</h3>
                  <ul data-testid="redo-turn-wont" aria-labelledby={skippedHeading}>
                    {plan.wontRestore.map((file) => (
                      <FileLine key={file.path} display={file.display} note={reasonLabel(t, 'undo', file.reason)} />
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}
