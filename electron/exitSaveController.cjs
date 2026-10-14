'use strict';

/** Owns the user's decision while the renderer finishes saving for exit. */
function createExitSaveController({ preparation, ask, finish = () => Promise.resolve(), delayMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;
  let forced = false;
  let finished = false;

  async function clearQuestion(request) {
    clearTimer(request.timer);
    request.timer = null;
    const question = request.question;
    if (!question) return;
    question.controller.abort();
    await Promise.allSettled([question.promise]);
    if (request.question === question) request.question = null;
  }

  function settle(request, error) {
    if (pending !== request) return;
    if (error) request.error = error;
    if (request.settling) return;
    request.settling = true;
    const complete = () => {
      if (pending !== request) return;
      pending = null;
      if (request.error) request.reject(request.error);
      else {
        finished = true;
        request.resolve();
      }
    };
    void clearQuestion(request).then(() => {
      if (request.error || pending !== request) return;
      return finish();
    }).then(complete, error => {
      request.error = error;
      complete();
    });
  }

  function cancel() {
    forced = false;
    finished = false;
    preparation.cancel();
    if (pending) settle(pending, new Error('Application exit was cancelled'));
  }

  function arm(request) {
    request.timer = setTimer(() => question(request, 'waiting'), delayMs);
  }

  async function question(request, kind) {
    const version = ++request.questionVersion;
    await clearQuestion(request);
    if (pending !== request || request.settling || version !== request.questionVersion) return;
    const controller = new AbortController();
    const promise = ask(kind, controller.signal);
    const active = { controller, promise };
    request.question = active;
    void promise.then(answer => {
      if (pending !== request || controller.signal.aborted || request.question !== active || request.settling) return;
      request.question = null;
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
      if (pending !== request || controller.signal.aborted || request.question !== active || request.settling) return;
      request.question = null;
      preparation.cancel();
      settle(request, error);
    });
  }

  function start(request) {
    if (forced) { settle(request); return; }
    arm(request);
    void preparation.prepare().then(() => settle(request), () => {
      if (pending === request) question(request, 'failed');
    });
  }

  function isPrepared() { return !pending && finished && (forced || preparation.isPrepared()); }

  function force() {
    forced = true;
    if (pending) settle(pending);
  }

  function prepare() {
    if (pending) return pending.promise;
    if (isPrepared()) return Promise.resolve();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const request = { promise, resolve, reject, timer: null, question: null, questionVersion: 0, settling: false, error: null };
    pending = request;
    start(request);
    return promise;
  }

  return { prepare, isPrepared, cancel, force };
}

module.exports = { createExitSaveController };
