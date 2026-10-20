import { describe, expect, it } from 'vitest';
import { holdConversationStarts, waitForConversationStarts } from './conversationStartHold';

/** Lets every continuation queued so far run, without touching the clock. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('conversationStartHold', () => {
  it('gives one hold per conversation at a time', () => {
    const first = holdConversationStarts('conv-a');
    expect(first).not.toBeNull();
    expect(first?.conversationId).toBe('conv-a');
    expect(holdConversationStarts('conv-a')).toBeNull();
    const other = holdConversationStarts('conv-b');
    expect(other).not.toBeNull();
    first?.release();
    other?.release();
  });

  it('lets the holder through and makes others wait until release', async () => {
    const hold = holdConversationStarts('conv-c');
    expect(hold).not.toBeNull();

    let holderThrough = false;
    void waitForConversationStarts('conv-c', hold!).then(() => { holderThrough = true; });
    let otherThrough = false;
    void waitForConversationStarts('conv-c').then(() => { otherThrough = true; });
    let unrelatedThrough = false;
    void waitForConversationStarts('conv-d').then(() => { unrelatedThrough = true; });
    await flushMicrotasks();

    expect(holderThrough).toBe(true);
    expect(unrelatedThrough).toBe(true);
    expect(otherThrough).toBe(false);

    hold!.release();
    await flushMicrotasks();

    expect(otherThrough).toBe(true);
  });

  it('takes a second release as nothing and gives a new hold after release', async () => {
    const hold = holdConversationStarts('conv-e');
    expect(hold).not.toBeNull();
    hold!.release();
    hold!.release();

    const next = holdConversationStarts('conv-e');
    expect(next).not.toBeNull();
    expect(next).not.toBe(hold);

    let waiterThrough = false;
    void waitForConversationStarts('conv-e').then(() => { waiterThrough = true; });
    await flushMicrotasks();
    expect(waiterThrough).toBe(false);

    // The stale hold's release leaves the live hold in place.
    hold!.release();
    await flushMicrotasks();
    expect(waiterThrough).toBe(false);

    next!.release();
    await flushMicrotasks();
    expect(waiterThrough).toBe(true);
  });
});
