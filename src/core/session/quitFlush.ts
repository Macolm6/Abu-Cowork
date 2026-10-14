/**
 * The renderer's side of the quit handshake (`electron/quitGate.cjs`).
 *
 * The main process sends `quit-requested` before it lets the application
 * leave. This module answers it: it asks the user when a conversation is
 * running, records the running turns as closed on, waits until every
 * conversation is on disk, and reports each stage back.
 */
import { closeRunningRunsForExit } from '@/core/agent/agentLoopRunner';
import { shutdownConversationStorage } from '@/core/session/conversationStorage';
import { snapshotStreamingMessagesForExit, waitForAllConversationPersistence } from '@/stores/chatStore';

export interface QuitRequest {
  requestId: number;
  /** The OS is shutting down or logging out: the user is asked nothing. */
  sessionEnding: boolean;
}

export type QuitStage = 'asking' | 'cancelled' | 'flushing' | 'ready';

export interface QuitAnswerDeps {
  hasRunningConversation: () => boolean;
  /** Bring the window forward and ask; true means quit. */
  askToQuit: () => Promise<boolean>;
  report: (requestId: number, stage: QuitStage) => Promise<void>;
  save: () => Promise<void>;
}

// The user chose 「退出」 in the close dialog while it showed the running-task
// warning: the quit that follows is already answered.
let quitConfirmedByUser = false;

export function noteQuitConfirmedByUser(): void {
  quitConfirmedByUser = true;
}

/**
 * Everything the next start reads is on disk when this resolves: running
 * turns are marked as closed on, replies still streaming are snapshotted as
 * they stand, queued conversation writes have gone out, and the writer has
 * promoted its stream snapshots and flushed the index.
 */
export async function saveConversationsForExit(): Promise<void> {
  closeRunningRunsForExit();
  await snapshotStreamingMessagesForExit();
  await waitForAllConversationPersistence();
  await shutdownConversationStorage();
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
  await deps.report(request.requestId, 'flushing');
  await deps.save();
  await deps.report(request.requestId, 'ready');
}
