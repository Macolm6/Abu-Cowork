/**
 * The renderer's side of the quit handshake (`electron/quitGate.cjs`).
 *
 * The main process sends `quit-requested` before it lets the application
 * leave. This module answers it: it asks the user when a conversation or a
 * background command is running and reports the user's decision before the
 * host starts saving.
 */

import { format, type TranslationDict } from '@/i18n';

export interface QuitRequest {
  requestId: number;
  /** The OS is shutting down or logging out: the user is asked nothing. */
  sessionEnding: boolean;
  /** Background commands of every conversation still running; quitting stops them. */
  backgroundCommandCount: number;
}

export type QuitStage = 'asking' | 'cancelled' | 'ready';

/** What quitting would end. */
export interface QuitReason {
  runningConversation: boolean;
  backgroundCommandCount: number;
}

export interface QuitAnswerDeps {
  hasRunningConversation: () => boolean;
  /** Bring the window forward and ask; true means quit. */
  askToQuit: (reason: QuitReason) => Promise<boolean>;
  report: (requestId: number, stage: QuitStage) => Promise<void>;
}

/** The words of the quit question: one title, and the background commands below it when both apply. */
export function quitQuestion(
  reason: QuitReason,
  text: TranslationDict['windowClose'],
): { title: string; message?: string } {
  const count = reason.backgroundCommandCount;
  const commands = count > 0
    ? (count === 1 ? text.backgroundCommandsRunningOne : format(text.backgroundCommandsRunning, { count }))
    : undefined;
  if (!reason.runningConversation) {
    if (commands === undefined) throw new Error('quitQuestion: nothing would be interrupted');
    return { title: commands };
  }
  return commands === undefined
    ? { title: text.quitWhileRunning }
    : { title: text.quitWhileRunning, message: commands };
}

// The user chose 「退出」 in the close dialog while it showed the running-task
// or background-command warning: the quit that follows is already answered.
let quitConfirmedByUser = false;

export function noteQuitConfirmedByUser(): void {
  quitConfirmedByUser = true;
}

// The request whose question is on screen. The main process sends it again
// when the user quits a second time, to learn whether this page still answers.
let askingRequestId: number | null = null;

export async function answerQuitRequest(request: QuitRequest, deps: QuitAnswerDeps): Promise<void> {
  if (askingRequestId === request.requestId) {
    await deps.report(request.requestId, 'asking');
    return;
  }
  const confirmed = quitConfirmedByUser;
  quitConfirmedByUser = false;
  if (!request.sessionEnding && !confirmed) {
    const reason: QuitReason = {
      runningConversation: deps.hasRunningConversation(),
      backgroundCommandCount: request.backgroundCommandCount,
    };
    if (reason.runningConversation || reason.backgroundCommandCount > 0) {
      await deps.report(request.requestId, 'asking');
      askingRequestId = request.requestId;
      const quit = await deps.askToQuit(reason);
      askingRequestId = null;
      if (!quit) {
        await deps.report(request.requestId, 'cancelled');
        return;
      }
    }
  }
  await deps.report(request.requestId, 'ready');
}
