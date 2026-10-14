'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createExitSaveController } = require('./exitSaveController.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const attempts = [];
  const questions = [];
  let timer;
  let prepared = false;
  let cancelled = 0;
  const controller = createExitSaveController({
    preparation: {
      prepare: () => { const attempt = deferred(); attempts.push(attempt); return attempt.promise.then(() => { prepared = true; }); },
      isPrepared: () => prepared,
      cancel: () => { cancelled++; prepared = false; },
    },
    ask: (kind, signal) => { const answer = deferred(); questions.push({ kind, signal, ...answer }); return answer.promise; },
    setTimer: (fn) => { timer = fn; return fn; },
    clearTimer: () => { timer = undefined; },
  });
  return { controller, attempts, questions, fire: () => timer(), cancelled: () => cancelled };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('slow saves keep waiting, coalesce exits, and close the question when saved', async () => {
  const f = fixture();
  const saving = f.controller.prepare();
  assert.equal(f.controller.prepare(), saving);
  f.fire();
  assert.equal(f.questions[0].kind, 'waiting');
  f.questions[0].resolve('wait');
  await tick();
  assert.equal(f.controller.isPrepared(), false);
  assert.equal(f.attempts.length, 1);
  f.fire();
  f.attempts[0].resolve();
  await saving;
  assert.equal(f.questions[1].signal.aborted, true);
  assert.equal(f.controller.isPrepared(), true);
});

test('forcing exit requires an explicit answer and ignores late answers after saving', async () => {
  const f = fixture();
  const saving = f.controller.prepare();
  f.fire();
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

test('a failure replaces the wait question and its old force answer has no effect', async () => {
  const f = fixture();
  const saving = f.controller.prepare();
  f.fire();
  f.attempts[0].reject(new Error('disk full'));
  await tick();
  assert.equal(f.questions[0].signal.aborted, true);
  assert.equal(f.questions[1].kind, 'failed');
  f.questions[0].resolve('force');
  await tick();
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
