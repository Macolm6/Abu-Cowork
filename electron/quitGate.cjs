'use strict';

const ACK_TIMEOUT_MS = 2_000;

/**
 * Confirms interruption of running work before the host starts saving.
 * `backgroundCommandCount` counts the background commands of every conversation still running;
 * each request carries it, so the page can name them in its question.
 */
function createQuitGate({ send, backgroundCommandCount, onProceed, onCancelled, onUnavailable = onCancelled,
  ackTimeoutMs = ACK_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof backgroundCommandCount !== 'function') {
    throw new TypeError('createQuitGate: backgroundCommandCount is required');
  }
  let state = 'idle';
  let requestId = 0;
  let timer = null;

  function stopTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function reset() {
    stopTimer();
    state = 'idle';
  }
  function unavailable() {
    reset();
    onUnavailable();
  }
  function request({ sessionEnding = false } = {}) {
    if (state === 'passed') return true;
    if (state === 'requested') return false;
    if (state === 'idle') requestId++;
    if (send({ requestId, sessionEnding, backgroundCommandCount: backgroundCommandCount() }) === 0) {
      unavailable();
      return false;
    }
    state = 'requested';
    stopTimer();
    timer = setTimer(unavailable, ackTimeoutMs);
    return false;
  }
  function report(id, stage) {
    if (id !== requestId || state === 'idle' || state === 'passed') return;
    if (stage === 'asking') {
      stopTimer();
      state = 'asking';
    } else if (stage === 'cancelled') {
      reset();
      onCancelled();
    } else if (stage === 'ready') {
      allow();
      onProceed();
    }
  }
  function rendererGone() {
    if (state === 'idle' || state === 'passed') return;
    unavailable();
  }
  function allow() {
    stopTimer();
    state = 'passed';
  }
  return { request, report, rendererGone, allow, reset,
    passed: () => state === 'passed', state: () => state };
}

module.exports = { createQuitGate, ACK_TIMEOUT_MS };
