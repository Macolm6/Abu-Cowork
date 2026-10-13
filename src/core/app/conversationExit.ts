import { acquireAgentDispatchBarrier } from '@/core/agent/agentLoopRunner';
import { flushTokenBuffer, useChatStore, waitForConversationPersistence } from '@/stores/chatStore';
import * as storage from '@/core/session/conversationStorage';
import { getI18n } from '@/i18n';

type QuitShell = {
  registerQuitParticipant: (
    prepare: (onCancel: (cancel: () => void) => void) => Promise<() => void>,
    failureMessage: string,
  ) => Promise<void>;
};

let registered = false;

export async function prepareConversationExit(onCancel: (cancel: () => void) => void): Promise<() => void> {
  const controller = new AbortController();
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
    for (const conversation of Object.values(useChatStore.getState().conversations)) {
      controller.signal.throwIfAborted();
      await storage.checkpointMessages(conversation.id, conversation.messages, controller.signal);
      controller.signal.throwIfAborted();
      await storage.updateIndexEntry(storage.buildMeta(conversation));
    }
    controller.signal.throwIfAborted();
    await storage.flushIndex();
  })()]);
  if (result.status === 'rejected') {
    barrier.release();
    throw result.reason;
  }
  return barrier.release;
}

export function initializeConversationExit(): void {
  if (registered) return;
  const shell = (globalThis as typeof globalThis & { __ABU_SHELL__?: QuitShell }).__ABU_SHELL__;
  if (!shell) return;
  registered = true;
  void shell.registerQuitParticipant(prepareConversationExit, getI18n().chat.exitSaveFailed);
}
