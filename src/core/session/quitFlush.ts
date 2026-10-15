/**
 * The renderer's side of the quit handshake (`electron/quitGate.cjs`).
 *
 * The main process sends `quit-requested` before it lets the application
 * leave. This module answers it: it asks the user when a conversation is
 * running and reports the user's decision before the host starts saving.
 */

export interface QuitRequest {
  requestId: number;
  /** The OS is shutting down or logging out: the user is asked nothing. */
  sessionEnding: boolean;
}

export type QuitStage = 'asking' | 'cancelled' | 'ready';

export interface QuitAnswerDeps {
  hasRunningConversation: () => boolean;
  /** Bring the window forward and ask; true means quit. */
  askToQuit: () => Promise<boolean>;
  report: (requestId: number, stage: QuitStage) => Promise<void>;
}

// The user chose 「退出」 in the close dialog while it showed the running-task
// warning: the quit that follows is already answered.
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
  if (!request.sessionEnding && !confirmed && deps.hasRunningConversation()) {
    await deps.report(request.requestId, 'asking');
    askingRequestId = request.requestId;
    const quit = await deps.askToQuit();
    askingRequestId = null;
    if (!quit) {
      await deps.report(request.requestId, 'cancelled');
      return;
    }
  }
  await deps.report(request.requestId, 'ready');
}
