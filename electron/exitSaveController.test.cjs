'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createExitSaveController } = require('./exitSaveController.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(closeOnAbort = true, finish = () => Promise.resolve()) {
  const attempts = [];
  const questions = [];
  let timer;
  let prepared = false;
  let cancelled = 0;
  const controller = createExitSaveController({
    finish,
    preparation: {
      prepare: () => { const attempt = deferred(); attempts.push(attempt); return attempt.promise.then(() => { prepared = true; }); },
      isPrepared: () => prepared,
      cancel: () => { cancelled++; prepared = false; },
    },
    ask: (kind, signal) => {
      const answer = deferred();
      if (closeOnAbort) signal.addEventListener('abort', () => answer.resolve('wait'), { once: true });
      questions.push({ kind, signal, ...answer });
      return answer.promise;
    },
    setTimer: (fn) => { timer = fn; return fn; },
    clearTimer: () => { timer = undefined; },
  });
  return { controller, attempts, questions, fire: () => timer(), cancelled: () => cancelled };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('repeated quit waits for runtime shutdown after the save acknowledgement', async () => {
  const runtime = deferred();
  const f = fixture(true, () => runtime.promise);
  const saving = f.controller.prepare();
  f.attempts[0].resolve();
  await tick();
  assert.equal(f.controller.isPrepared(), false);
  assert.equal(f.controller.prepare(), saving);
  runtime.resolve();
  await saving;
  assert.equal(f.controller.isPrepared(), true);
});

test('forcing an unavailable renderer still waits for runtime shutdown', async () => {
  const runtime = deferred();
  const f = fixture(true, () => runtime.promise);
  f.controller.force();
  assert.equal(f.controller.isPrepared(), false);
  const exiting = f.controller.prepare();
  await tick();
  assert.equal(f.attempts.length, 0);
  assert.equal(f.controller.isPrepared(), false);
  runtime.resolve();
  await exiting;
  assert.equal(f.controller.isPrepared(), true);
});

test('saved data cannot bypass a native question that is still closing', async () => {
  const f = fixture(false);
  const saving = f.controller.prepare();
  f.fire();
  await tick();
  f.attempts[0].resolve();
  await tick();
  assert.equal(f.questions[0].signal.aborted, true);
  assert.equal(f.controller.isPrepared(), false);
  assert.equal(f.controller.prepare(), saving);
  f.questions[0].resolve('wait');
  await saving;
  assert.equal(f.controller.isPrepared(), true);
});

test('slow saves keep waiting, coalesce exits, and close the question when saved', async () => {
  const f = fixture();
  const saving = f.controller.prepare();
  assert.equal(f.controller.prepare(), saving);
  f.fire();
  await tick();
  assert.equal(f.questions[0].kind, 'waiting');
  f.questions[0].resolve('wait');
  await tick();
  assert.equal(f.controller.isPrepared(), false);
  assert.equal(f.attempts.length, 1);
  f.fire();
  await tick();
  f.attempts[0].resolve();
  await saving;
  assert.equal(f.questions[1].signal.aborted, true);
  assert.equal(f.controller.isPrepared(), true);
});

test('forcing exit requires an explicit answer and ignores late answers after saving', async () => {
  const f = fixture();
  const saving = f.controller.prepare();
  f.fire();
  await tick();
  f.questions[0].resolve('force');
  await saving;
  assert.equal(f.controller.isPrepared(), true);
  f.controller.cancel();
  assert.equal(f.controller.isPrepared(), false);
  assert.equal(f.cancelled(), 1);
  f.attempts[0].reject(new Error('cancelled'));
  await tick();
});

test('failed saves can be retried and require a successful new attempt', async () => {
  const f = fixture();
  const saving = f.controller.prepare();
  f.attempts[0].reject(new Error('disk full'));
  await tick();
  assert.equal(f.questions[0].kind, 'failed');
  f.questions[0].resolve('retry');
  await tick();
  assert.equal(f.controller.isPrepared(), false);
  f.attempts[1].resolve();
  await saving;
  assert.equal(f.controller.isPrepared(), true);
});

test('cancelling after failure keeps the app open and permits a later exit', async () => {
  const f = fixture();
  const saving = f.controller.prepare();
  const rejected = assert.rejects(saving, /cancelled/);
  f.attempts[0].reject(new Error('disk full'));
  await tick();
  f.questions[0].resolve('cancel');
  await rejected;
  assert.equal(f.controller.isPrepared(), false);
  const retry = f.controller.prepare();
  f.attempts[1].resolve();
  await retry;
});

test('a failure closes the wait question before opening its next question', async () => {
  const f = fixture(false);
  const saving = f.controller.prepare();
  f.fire();
  await tick();
  f.attempts[0].reject(new Error('disk full'));
  await tick();
  assert.equal(f.questions[0].signal.aborted, true);
  assert.equal(f.questions.length, 1);
  f.questions[0].resolve('force');
  await tick();
  assert.equal(f.questions[1].kind, 'failed');
  assert.equal(f.controller.isPrepared(), false);
  f.questions[1].resolve('force');
  await saving;
  assert.equal(f.controller.isPrepared(), true);
});

test('a cancelled attempt cannot complete a newer save', async () => {
  const f = fixture();
  const first = f.controller.prepare();
  const rejected = assert.rejects(first, /cancelled/);
  f.fire();
  await tick();
  f.controller.cancel();
  await rejected;
  const second = f.controller.prepare();
  f.questions[0].resolve('force');
  f.attempts[0].reject(new Error('old attempt'));
  await tick();
  assert.equal(f.controller.isPrepared(), false);
  f.attempts[1].resolve();
  await second;
});
