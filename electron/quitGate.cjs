/**
 * Quit gate — the handshake a quit goes through before the application
 * leaves, so conversations are on disk when it does.
 *
 * The renderer owns the conversation ledger's write queue and knows whether a
 * conversation is running. On a quit the main process asks it (`send`) and
 * hears back through `report`:
 *
 *   asking     a conversation is running and the user is being asked; no
 *              timer runs while the question is open
 *   cancelled  the user chose to stay: the quit is called off
 *   flushing   the quit goes ahead and the renderer is writing; it has
 *              `flushTimeoutMs` to finish
 *   ready      everything is written
 *
 * A quit always ends: a renderer that does not answer within `ackTimeoutMs`,
 * a write that outlasts `flushTimeoutMs`, and a request nobody is there to
 * hear all let the quit through. While the question is open, a second quit
 * attempt sends the same request again and expects `asking` back in time.
 *
 * No Electron import: the host wires `send` and the callbacks, and the test
 * drives the timers.
 */
'use strict';

const ACK_TIMEOUT_MS = 2_000;
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * @param {{
 *   send: (payload: { requestId: number, sessionEnding: boolean }) => number,
 *   onProceed: () => void,
 *   onCancelled: () => void,
 *   onFlushing?: () => void,
 *   ackTimeoutMs?: number,
 *   flushTimeoutMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} options `send` returns how many renderers the request reached.
 */
function createQuitGate(options) {
  const {
    send,
    onProceed,
    onCancelled,
    onFlushing = () => {},
    ackTimeoutMs = ACK_TIMEOUT_MS,
    flushTimeoutMs = FLUSH_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  /** @type {'idle' | 'requested' | 'asking' | 'flushing' | 'passed'} */
  let state = 'idle';
  let requestId = 0;
  let timer = null;

  function stopTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function startTimer(ms) {
    stopTimer();
    timer = setTimer(() => {
      timer = null;
      pass();
    }, ms);
  }

  /** The quit goes ahead; `onProceed` restarts it. */
  function pass() {
    stopTimer();
    state = 'passed';
    onProceed();
  }

  /**
   * Called for every quit attempt. Returns true when the quit may go ahead
   * now; false when it has to wait for the handshake, which ends in
   * `onProceed` or `onCancelled`.
   * @param {{ sessionEnding?: boolean }} [request]
   */
  function request({ sessionEnding = false } = {}) {
    if (state === 'passed') return true;
    if (state === 'asking') {
      // The user quits again while the question is open. A page that is
      // still there says `asking` once more; one that has hung says nothing,
      // and the acknowledge timeout lets this quit through.
      if (send({ requestId, sessionEnding }) === 0) {
        stopTimer();
        state = 'passed';
        return true;
      }
      startTimer(ackTimeoutMs);
      return false;
    }
    if (state !== 'idle') return false;
    requestId += 1;
    if (send({ requestId, sessionEnding }) === 0) {
      state = 'passed';
      return true;
    }
    state = 'requested';
    startTimer(ackTimeoutMs);
    return false;
  }

  /**
   * A stage reported by the renderer for the request it was sent. A report
   * for an earlier request, or one the current state has no place for, is
   * dropped.
   * @param {number} id
   * @param {'asking' | 'cancelled' | 'flushing' | 'ready'} stage
   */
  function report(id, stage) {
    if (id !== requestId || state === 'idle' || state === 'passed') return;
    if (stage === 'asking' && (state === 'requested' || state === 'asking')) {
      stopTimer();
      state = 'asking';
    } else if (stage === 'cancelled' && state !== 'flushing') {
      stopTimer();
      state = 'idle';
      onCancelled();
    } else if (stage === 'flushing' && state !== 'flushing') {
      state = 'flushing';
      onFlushing();
      startTimer(flushTimeoutMs);
    } else if (stage === 'ready') {
      pass();
    }
  }

  /** The renderer the handshake was talking to is gone or hung: nobody is left to answer. */
  function rendererGone() {
    if (state === 'idle' || state === 'passed') return;
    pass();
  }

  /**
   * A quit that needs no handshake is on its way: the renderer saved before
   * it asked for one (restart to install an update). `onProceed` is not
   * called; the caller drives that quit itself.
   */
  function allow() {
    stopTimer();
    state = 'passed';
  }

  /** A later exit participant refused this quit; the next attempt needs a new handshake. */
  function cancel() {
    stopTimer();
    state = 'idle';
    onCancelled();
  }

  return {
    request,
    report,
    rendererGone,
    allow,
    cancel,
    passed: () => state === 'passed',
    state: () => state,
  };
}

module.exports = { createQuitGate, ACK_TIMEOUT_MS, FLUSH_TIMEOUT_MS };
