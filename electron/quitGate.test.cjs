'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createQuitGate } = require('./quitGate.cjs');

function fixture(reached = 1, commands = { running: 0 }) {
  const events = [], sent = [];
  let timer;
  const gate = createQuitGate({
    send: value => { sent.push(value); return reached; },
    backgroundCommandCount: () => commands.running,
    onProceed: () => events.push('proceed'),
    onCancelled: () => events.push('cancelled'),
    onUnavailable: () => events.push('unavailable'),
    setTimer: fn => { timer = fn; return fn; },
    clearTimer: () => { timer = undefined; },
  });
  return { gate, events, sent, fire: () => timer(), timer: () => timer };
}

test('no renderer or an unanswered request requires an explicit host decision', () => {
  const absent = fixture(0);
  assert.equal(absent.gate.request(), false);
  assert.deepEqual(absent.events, ['unavailable']);
  assert.equal(absent.gate.passed(), false);
  const hung = fixture();
  hung.gate.request();
  hung.fire();
  assert.deepEqual(hung.events, ['unavailable']);
  hung.gate.report(1, 'ready');
  assert.equal(hung.gate.passed(), false);
});

test('confirmation waits for the user and cancellation permits a new request', () => {
  const f = fixture();
  f.gate.request();
  f.gate.request();
  assert.equal(f.sent.length, 1);
  f.gate.report(1, 'asking');
  assert.equal(f.timer(), undefined);
  f.gate.request();
  assert.equal(f.sent[1].requestId, 1);
  f.gate.report(1, 'asking');
  f.gate.report(1, 'cancelled');
  assert.deepEqual(f.events, ['cancelled']);
  f.gate.request();
  f.gate.report(1, 'ready');
  assert.equal(f.gate.passed(), false);
  f.gate.report(2, 'ready');
  assert.equal(f.gate.request(), true);
  assert.deepEqual(f.events, ['cancelled', 'proceed']);
});

test('a renderer lost during confirmation does not approve the quit', () => {
  const f = fixture();
  f.gate.request();
  f.gate.report(1, 'asking');
  f.gate.rendererGone();
  assert.deepEqual(f.events, ['unavailable']);
  assert.equal(f.gate.passed(), false);
});

test('a later exit participant failure resets a passed handshake and the next quit asks anew', () => {
  const f = fixture();
  f.gate.request();
  f.gate.report(1, 'ready');
  assert.equal(f.gate.passed(), true);
  f.gate.reset();
  assert.equal(f.gate.state(), 'idle');
  assert.equal(f.gate.request(), false);
  assert.deepEqual(f.sent.map(sent => sent.requestId), [1, 2]);
  f.gate.report(1, 'ready');
  assert.equal(f.gate.state(), 'requested');
  f.gate.report(2, 'asking');
  assert.equal(f.gate.state(), 'asking');
});

test('each request carries the count of background commands running at that moment', () => {
  const commands = { running: 2 };
  const f = fixture(1, commands);
  f.gate.request();
  assert.deepEqual(f.sent[0], { requestId: 1, sessionEnding: false, backgroundCommandCount: 2 });
  f.gate.report(1, 'asking');
  commands.running = 1;
  f.gate.request();
  assert.deepEqual(f.sent[1], { requestId: 1, sessionEnding: false, backgroundCommandCount: 1 });
  f.gate.report(1, 'cancelled');
  commands.running = 0;
  f.gate.request({ sessionEnding: true });
  assert.deepEqual(f.sent[2], { requestId: 2, sessionEnding: true, backgroundCommandCount: 0 });
});

test('a gate needs the count of background commands', () => {
  assert.throws(() => createQuitGate({ send: () => 1, onProceed() {}, onCancelled() {} }), TypeError);
});

test('an update confirmation can allow the quit and cancellation resets it', () => {
  const f = fixture();
  f.gate.allow();
  assert.equal(f.gate.request(), true);
  assert.equal(f.sent.length, 0);
  f.gate.reset();
  assert.equal(f.gate.request({ sessionEnding: true }), false);
  assert.equal(f.sent[0].sessionEnding, true);
});
