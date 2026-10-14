'use strict';

/** Owns the user's decision while the renderer finishes saving for exit. */
function createExitSaveController({ preparation, ask, delayMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;
  let forced = false;

  function clearQuestion(request) {
    clearTimer(request.timer);
    request.timer = null;
    request.question?.abort();
    request.question = null;
  }

  function settle(request, error) {
    if (pending !== request) return;
    pending = null;
    clearQuestion(request);
    if (error) request.reject(error);
    else request.resolve();
  }

  function cancel() {
    forced = false;
    preparation.cancel();
    if (pending) settle(pending, new Error('Application exit was cancelled'));
  }

  function arm(request) {
    request.timer = setTimer(() => question(request, 'waiting'), delayMs);
  }

  function question(request, kind) {
    clearQuestion(request);
    const controller = new AbortController();
    request.question = controller;
    void ask(kind, controller.signal).then(answer => {
      if (pending !== request || controller.signal.aborted) return;
      clearQuestion(request);
      if (answer === 'force') {
        forced = true;
        settle(request);
      } else if (kind === 'waiting' && answer === 'wait') {
        arm(request);
      } else if (kind === 'failed' && answer === 'retry') {
        start(request);
      } else {
        cancel();
      }
    }, error => {
      if (pending !== request || controller.signal.aborted) return;
      preparation.cancel();
      settle(request, error);
    });
  }

  function start(request) {
    arm(request);
    void preparation.prepare().then(() => settle(request), () => {
      if (pending === request) question(request, 'failed');
    });
  }

  function isPrepared() { return forced || preparation.isPrepared(); }

  function force() {
    forced = true;
    if (pending) settle(pending);
  }

  function prepare() {
    if (pending) return pending.promise;
    if (isPrepared()) return Promise.resolve();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const request = { promise, resolve, reject, timer: null, question: null };
    pending = request;
    start(request);
    return promise;
  }

  return { prepare, isPrepared, cancel, force };
}

module.exports = { createExitSaveController };
