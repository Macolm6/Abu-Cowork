import { acquireAgentDispatchBarrier, closeRunningRunsForExit } from '@/core/agent/agentLoopRunner';
import {
  acknowledgeConversationPersistence, flushTokenBuffer, getConversationPersistenceRevision,
  useChatStore, waitForConversationPersistence,
} from '@/stores/chatStore';
import * as storage from '@/core/session/conversationStorage';
import { getI18n } from '@/i18n';

type QuitShell = {
  registerQuitParticipant: (
    prepare: (onCancel: (cancel: () => void) => void) => Promise<() => void>,
    failureMessage: string,
    dialogText: { waiting: string; failed: string; wait: string; retry: string; cancel: string; force: string },
  ) => Promise<void>;
};

let registered = false;

export async function prepareConversationExit(onCancel: (cancel: () => void) => void): Promise<() => void> {
  const controller = new AbortController();
  closeRunningRunsForExit();
  const barrier = acquireAgentDispatchBarrier();
  onCancel(() => { controller.abort(); barrier.release(); });
  const [result] = await Promise.allSettled([(async () => {
    await barrier.wait();
    controller.signal.throwIfAborted();
    for (const conversation of Object.values(useChatStore.getState().conversations)) {
      flushTokenBuffer(conversation.id);
    }
    // Checkpointing repairs any failed queued write from the loaded history.
    await Promise.allSettled(Object.keys(useChatStore.getState().conversations).map(waitForConversationPersistence));
    controller.signal.throwIfAborted();
    do {
      const saved: { id: string; revision: symbol }[] = [];
      for (const id of Object.keys(useChatStore.getState().conversations)) {
        const conversation = useChatStore.getState().conversations[id];
        const revision = getConversationPersistenceRevision(id);
        if (!conversation || !revision) continue;
        controller.signal.throwIfAborted();
        await storage.checkpointMessages(conversation.id, conversation.messages, controller.signal);
        controller.signal.throwIfAborted();
        const current = useChatStore.getState().conversations[conversation.id];
        if (!current) continue;
        await storage.updateIndexEntry(storage.buildMeta(current));
        saved.push({ id: conversation.id, revision });
      }
      controller.signal.throwIfAborted();
      await storage.flushIndex();
      controller.signal.throwIfAborted();
      for (const { id, revision } of saved) acknowledgeConversationPersistence(id, revision);
    } while (Object.keys(useChatStore.getState().conversations).some(getConversationPersistenceRevision));
  })()]);
  if (result.status === 'rejected') {
    throw result.reason;
  }
  return barrier.release;
}

export function initializeConversationExit(): void {
  if (registered) return;
  const shell = (globalThis as typeof globalThis & { __ABU_SHELL__?: QuitShell }).__ABU_SHELL__;
  if (!shell) return;
  registered = true;
  const text = getI18n().chat;
  void shell.registerQuitParticipant(prepareConversationExit, text.exitSaveFailed, {
    waiting: text.exitSaveWaiting, failed: text.exitSaveFailed,
    wait: text.exitSaveWait, retry: text.exitSaveRetry, cancel: text.exitSaveCancel, force: text.exitSaveForce,
  });
}
