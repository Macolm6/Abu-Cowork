import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { holdConversationStarts, type StartHold } from '@/core/agent/conversationStartHold';
import { planRedoRestore, restoreForRedo } from '@/core/session/redoRestore';
import { forgetTurns } from '@/core/session/turnChanges';
import type { TurnUndoOptions, TurnUndoPlan } from '@/core/session/turnUndo';
import { mayWrite } from '@/hooks/useTurnChanges';
import { format, useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { redoScope } from '@/utils/rewindImpact';
import RedoTurnDialog, { type RedoEntry } from './RedoTurnDialog';

export type RedoOutcome = 'started' | 'cancelled' | 'stopped';

export interface RedoRequest {
  conversationId: string;
  entry: RedoEntry;
  /** The message `chatStore.deleteMessagesFrom` truncates from. */
  cutMessageId: string;
  /** Messages the redo needs in the conversation: the one it was pressed on, the one it cuts at. */
  messageIds: string[];
  /** Checked after the answer, before any file is restored: for example that the model is still usable. */
  canProceed: () => boolean;
  /** Called right before the conversation is cut: for example to close the message editor. */
  onCommit?: () => void;
  /** Called once the conversation is cut: runs the turn again, with the hold the dispatcher releases. */
  start: (startHold: StartHold) => Promise<unknown>;
}

/** The question on the page; it keeps what it showed while it fades. */
interface Question {
  entry: RedoEntry;
  laterTurnsCount: number;
  plan: TurnUndoPlan;
  answer: (confirmed: boolean) => void;
}

/**
 * Redoing a turn (regenerate, edit and resend, retry, resend): the turns from
 * the cut onward are deleted and the turn runs again, and the files those
 * turns changed can be restored first.
 *
 * `redo` plans the restore, asks when files can be restored or later turns
 * would go, and after the answer holds the conversation's new runs while it
 * checks that the redo may still happen, restores the confirmed files, cuts
 * the conversation, forgets the deleted turns' records and starts the run.
 * The hold is handed to `start`; every other way out releases it here.
 * A file that was not restored stops the redo before the cut: the
 * conversation stays as it is and a notice says how many files were restored.
 */
export function useRedoTurn(): { redo: (request: RedoRequest) => Promise<RedoOutcome>; dialog: ReactNode } {
  const { t } = useI18n();
  const mounted = useRef(false);
  const [question, setQuestion] = useState<Question | null>(null);
  const [open, setOpen] = useState(false);
  const [restoreFiles, setRestoreFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  // The option as last set; read after the answer, which arrives outside a render.
  const restoreFilesRef = useRef(false);
  const pending = useRef<Question | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const changeRestoreFiles = useCallback((next: boolean) => {
    restoreFilesRef.current = next;
    setRestoreFiles(next);
  }, []);

  const ask = useCallback((entry: RedoEntry, laterTurnsCount: number, plan: TurnUndoPlan) => new Promise<boolean>((resolve) => {
    // A question still waiting is answered no by the one that takes its place.
    pending.current?.answer(false);
    const next: Question = {
      entry,
      laterTurnsCount,
      plan,
      answer: (confirmed) => {
        if (pending.current !== next) return;
        pending.current = null;
        resolve(confirmed);
      },
    };
    pending.current = next;
    // Every opening starts with the option checked when there is a file to restore.
    changeRestoreFiles(plan.willRestore.length > 0);
    setQuestion(next);
    setOpen(true);
  }), [changeRestoreFiles]);

  const redo = useCallback(async (request: RedoRequest): Promise<RedoOutcome> => {
    const { conversationId } = request;
    const conversation = () => useChatStore.getState().conversations[conversationId];
    const isRunning = () => conversation()?.status === 'running';
    const options: TurnUndoOptions = {
      authorize: (path) => mayWrite(conversationId, path),
      isConversationPresent: () => Boolean(conversation()),
    };
    const { loopIds, laterTurnsCount } = redoScope(conversation()?.messages ?? [], request.cutMessageId);
    const plan = await planRedoRestore(conversationId, loopIds, options);
    const ranWhenAsked = isRunning();

    let restore = false;
    if (plan.willRestore.length > 0 || laterTurnsCount > 0) {
      if (!(await ask(request.entry, laterTurnsCount, plan))) return 'cancelled';
      restore = restoreFilesRef.current;
    }

    const dismiss = () => {
      setBusy(false);
      setOpen(false);
    };
    const hold = holdConversationStarts(conversationId);
    if (!hold) {
      dismiss();
      return 'cancelled';
    }
    // Once the run is started the question is over; a question asked on this hook during the run is left alone.
    let handedToStart = false;
    try {
      // The question was asked about a conversation at rest. A run that started meanwhile (an IM
      // message, a goal's next round, a message from the pet window) owns the conversation now:
      // the redo would cut its messages away under it. The user can ask again once it has ended.
      const current = conversation();
      const stillRedoable = mounted.current
        && !(isRunning() && !ranWhenAsked)
        && current !== undefined
        && [...request.messageIds, request.cutMessageId].every((id) => current.messages.some((m) => m.id === id))
        && redoScope(current.messages, request.cutMessageId).laterTurnsCount === laterTurnsCount
        && request.canProceed();
      if (!stillRedoable) return 'cancelled';

      if (restore) {
        setBusy(true);
        const result = await restoreForRedo(conversationId, loopIds, plan.willRestore.map((file) => file.path), options);
        if (result.notDone.length > 0) {
          dismiss();
          useToastStore.getState().addToast({
            type: 'warning',
            title: format(t.chat.undoPartialNotice, { done: result.done, notDone: result.notDone.length }),
          });
          return 'stopped';
        }
        // The conversation may have been deleted while its files were restored.
        if (!conversation()) return 'cancelled';
      }

      request.onCommit?.();
      useChatStore.getState().deleteMessagesFrom(conversationId, request.cutMessageId);
      // The records of the deleted turns go in the conversation's queue, ahead of the new turn's own work.
      void forgetTurns(conversationId, loopIds);
      dismiss();
      handedToStart = true;
      await request.start(hold);
      return 'started';
    } finally {
      // The dispatcher releases the hold it was handed; every other way out ends it here.
      hold.release();
      if (!handedToStart) dismiss();
    }
  }, [ask, t]);

  const dialog = question && (
    <RedoTurnDialog
      open={open}
      entry={question.entry}
      laterTurnsCount={question.laterTurnsCount}
      plan={question.plan}
      restoreFiles={restoreFiles}
      onRestoreFilesChange={changeRestoreFiles}
      busy={busy}
      onConfirm={() => question.answer(true)}
      onCancel={() => {
        setOpen(false);
        question.answer(false);
      }}
    />
  );

  return { redo, dialog };
}
