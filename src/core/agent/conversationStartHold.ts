/**
 * Holds new runs of one conversation while a redo (regenerate, edit and
 * resend, retry, resend) restores files and starts its own run.
 *
 * Between the user's confirmation and the moment the redo's run is registered
 * as joinable, every other dispatch for the conversation (an IM message, the
 * next goal round, a pet-window message, a schedule, a trigger, a queued
 * follow-up) waits here, then goes through the dispatcher's ordinary
 * concurrency guard: it joins or stages into the redo's run, or starts as
 * usual when the redo stopped.
 *
 * The hold lives in memory only: it ends with the process and is never
 * restored.
 */

export interface StartHold {
  readonly conversationId: string;
  /** Ends the hold. A second call does nothing. */
  release(): void;
}

interface HoldEntry {
  hold: StartHold;
  released: Promise<void>;
  resolve: () => void;
}

const holds = new Map<string, HoldEntry>();

/** Takes the hold of a conversation; null while another hold is live for it. */
export function holdConversationStarts(conversationId: string): StartHold | null {
  if (holds.has(conversationId)) return null;
  let resolve!: () => void;
  const released = new Promise<void>((res) => { resolve = res; });
  const hold: StartHold = {
    conversationId,
    release: () => {
      if (holds.get(conversationId) !== entry) return;
      holds.delete(conversationId);
      entry.resolve();
    },
  };
  const entry: HoldEntry = { hold, released, resolve };
  holds.set(conversationId, entry);
  return hold;
}

/**
 * Resolves at once when the conversation is not held or the live hold is
 * `own`; otherwise once no hold other than `own` is live. A hold taken right
 * after a release is waited for as well.
 */
export async function waitForConversationStarts(conversationId: string, own?: StartHold): Promise<void> {
  for (;;) {
    const entry = holds.get(conversationId);
    if (!entry || entry.hold === own) return;
    await entry.released;
  }
}
