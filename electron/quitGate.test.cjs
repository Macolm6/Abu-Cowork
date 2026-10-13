'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createQuitGate, ACK_TIMEOUT_MS, FLUSH_TIMEOUT_MS } = require('./quitGate.cjs');

/** A gate on hand-driven timers, with everything it told its host recorded. */
function harness({ reached = 1 } = {}) {
  const events = [];
  const sent = [];
  let pending = null;
  let renderers = reached;
  const gate = createQuitGate({
    send: (payload) => {
      sent.push(payload);
      return renderers;
    },
    onProceed: () => events.push('proceed'),
    onCancelled: () => events.push('cancelled'),
    onFlushing: () => events.push('flushing'),
    setTimer: (fn, ms) => {
      pending = { fn, ms };
      return pending;
    },
    clearTimer: (handle) => {
      if (pending === handle) pending = null;
    },
  });
  return {
    gate,
    events,
    sent,
    timerMs: () => (pending ? pending.ms : null),
    fireTimer: () => {
      const { fn } = pending;
      pending = null;
      fn();
    },
    setRenderers: (count) => {
      renderers = count;
    },
  };
}

test('a quit nobody is there to hear goes ahead at once', () => {
  const h = harness({ reached: 0 });
  assert.equal(h.gate.request(), true);
  assert.equal(h.gate.passed(), true);
  assert.deepEqual(h.events, []);
  assert.equal(h.timerMs(), null);
});

test('a renderer with nothing running: flushing, then ready, then the quit proceeds', () => {
  const h = harness();
  assert.equal(h.gate.request(), false);
  assert.deepEqual(h.sent, [{ requestId: 1, sessionEnding: false }]);
  assert.equal(h.timerMs(), ACK_TIMEOUT_MS);

  h.gate.report(1, 'flushing');
  assert.equal(h.timerMs(), FLUSH_TIMEOUT_MS);
  h.gate.report(1, 'ready');

  assert.deepEqual(h.events, ['flushing', 'proceed']);
  assert.equal(h.timerMs(), null);
  assert.equal(h.gate.request(), true);
});

test('a renderer that never answers lets the quit through after the acknowledge timeout', () => {
  const h = harness();
  h.gate.request();
  h.fireTimer();
  assert.deepEqual(h.events, ['proceed']);
  assert.equal(h.gate.passed(), true);
});

test('a later exit participant failure cancels a passed handshake and the next quit asks anew', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'flushing');
  h.gate.report(1, 'ready');
  assert.equal(h.gate.passed(), true);
  h.gate.cancel();
  assert.equal(h.gate.state(), 'idle');
  assert.equal(h.gate.request(), false);
  assert.deepEqual(h.sent, [
    { requestId: 1, sessionEnding: false },
    { requestId: 2, sessionEnding: false },
  ]);
  h.gate.report(1, 'ready');
  assert.equal(h.gate.state(), 'requested');
  h.gate.report(2, 'asking');
  assert.equal(h.gate.state(), 'asking');
});

test('a cancelled update restart clears its preapproved exit before the next quit', () => {
  const h = harness();
  h.gate.allow();
  assert.equal(h.gate.request(), true);
  h.gate.cancel();
  assert.equal(h.gate.request(), false);
  h.gate.report(1, 'asking');
  assert.equal(h.gate.state(), 'asking');
  assert.equal(h.timerMs(), null);
});

test('no timer runs while the user is being asked', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'asking');
  assert.equal(h.timerMs(), null);
  assert.equal(h.gate.state(), 'asking');
  assert.deepEqual(h.events, []);
});

test('the user stays: the quit is called off and a later quit asks again', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'asking');
  h.gate.report(1, 'cancelled');
  assert.deepEqual(h.events, ['cancelled']);
  assert.equal(h.gate.passed(), false);

  assert.equal(h.gate.request(), false);
  assert.deepEqual(h.sent[1], { requestId: 2, sessionEnding: false });
});

test('the user confirms: the write gets its own timeout, and an overrun lets the quit through', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'asking');
  h.gate.report(1, 'flushing');
  assert.equal(h.timerMs(), FLUSH_TIMEOUT_MS);
  h.fireTimer();
  assert.deepEqual(h.events, ['flushing', 'proceed']);
});

test('repeated quit attempts before the renderer answers send one request', () => {
  const h = harness();
  assert.equal(h.gate.request(), false);
  assert.equal(h.gate.request(), false);
  assert.equal(h.sent.length, 1);
});

test('a second quit while the question is open sends the same request again; a page that answers keeps asking', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'asking');
  assert.equal(h.gate.request(), false);
  assert.deepEqual(h.sent[1], { requestId: 1, sessionEnding: false });
  assert.equal(h.timerMs(), ACK_TIMEOUT_MS);

  h.gate.report(1, 'asking');
  assert.equal(h.timerMs(), null);
  assert.equal(h.gate.state(), 'asking');
  assert.deepEqual(h.events, []);
});

test('a second quit while the question is open on a page that has hung goes through after the acknowledge timeout', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'asking');
  h.gate.request();
  h.fireTimer();
  assert.deepEqual(h.events, ['proceed']);
});

test('a second quit while the question is open and the window is gone goes ahead at once', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'asking');
  h.setRenderers(0);
  assert.equal(h.gate.request(), true);
  assert.equal(h.timerMs(), null);
});

test('a report for an earlier request is dropped', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'cancelled');
  h.gate.request();
  h.gate.report(1, 'ready');
  assert.deepEqual(h.events, ['cancelled']);
  assert.equal(h.gate.state(), 'requested');
});

test('a cancel that arrives once the write has begun changes nothing', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'flushing');
  h.gate.report(1, 'cancelled');
  assert.equal(h.gate.state(), 'flushing');
  assert.deepEqual(h.events, ['flushing']);
});

test('reports after the quit went ahead are dropped', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'flushing');
  h.gate.report(1, 'ready');
  h.gate.report(1, 'ready');
  h.gate.report(1, 'cancelled');
  assert.deepEqual(h.events, ['flushing', 'proceed']);
});

test('the renderer goes away mid-handshake: the quit proceeds', () => {
  const h = harness();
  h.gate.request();
  h.gate.report(1, 'asking');
  h.gate.rendererGone();
  assert.deepEqual(h.events, ['proceed']);
  h.gate.rendererGone();
  assert.deepEqual(h.events, ['proceed']);
});

test('a quit that was allowed beforehand goes ahead with no request and no callback', () => {
  const h = harness();
  h.gate.allow();
  assert.equal(h.gate.request(), true);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.events, []);
});

test('allowing a quit during a handshake ends its timer', () => {
  const h = harness();
  h.gate.request();
  h.gate.allow();
  assert.equal(h.timerMs(), null);
  assert.equal(h.gate.passed(), true);
  assert.deepEqual(h.events, []);
});

test('a session that is ending says so in the request', () => {
  const h = harness();
  h.gate.request({ sessionEnding: true });
  assert.deepEqual(h.sent, [{ requestId: 1, sessionEnding: true }]);
});
