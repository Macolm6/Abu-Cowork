'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createQuitPreparation } = require('./quitPreparation.cjs');

function fixture() {
  const handlers = new Map();
  const sender = new EventEmitter();
  const sent = [];
  sender.send = (channel, payload) => sent.push({ channel, payload });
  sender.isDestroyed = () => false;
  const event = { sender, mainFrame: true };
  const preparation = createQuitPreparation({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertSender: incoming => {
      if (incoming.sender !== sender || !incoming.mainFrame) throw new Error('Untrusted sender');
    },
  });
  const invoke = (channel, payload, incoming = event) => handlers.get(channel)(incoming, payload);
  return { preparation, sender, sent, event, invoke };
}

test('exit requests share one preparation and require the matching main-frame acknowledgement', async () => {
  const f = fixture();
  assert.equal(f.preparation.isPrepared(), true);
  f.invoke('abu:quit-register', 'Save failed. Please try again.');
  const first = f.preparation.prepare();
  assert.equal(f.preparation.prepare(), first);
  assert.equal(f.sent.length, 1);
  const id = f.sent[0].payload;
  assert.throws(() => f.invoke('abu:quit-ack', { id, success: true }, { ...f.event, mainFrame: false }), /Untrusted/);
  assert.equal(f.invoke('abu:quit-ack', { id: 'old-request', success: true }), false);
  assert.equal(f.preparation.isPrepared(), false);
  f.invoke('abu:quit-ack', { id, success: true });
  await first;
  assert.equal(f.preparation.isPrepared(), true);
});

test('failed saves cancel preparation and a retry needs a fresh acknowledgement', async () => {
  const f = fixture();
  f.invoke('abu:quit-register', 'Save failed. Please try again.');
  const failed = f.preparation.prepare();
  const rejected = assert.rejects(failed, /could not be saved/);
  const oldId = f.sent[0].payload;
  f.invoke('abu:quit-ack', { id: oldId, success: false });
  await rejected;
  assert.equal(f.sent[1].channel, 'abu:quit-cancel');
  assert.equal(f.preparation.isPrepared(), false);
  const retry = f.preparation.prepare();
  const id = f.sent[2].payload;
  assert.notEqual(id, oldId);
  assert.equal(f.invoke('abu:quit-ack', { id: oldId, success: true }), false);
  f.invoke('abu:quit-ack', { id, success: true });
  await retry;
});

test('document replacement cancels pending preparation and requires registration again', async () => {
  const f = fixture();
  f.invoke('abu:quit-register', 'Save failed. Please try again.');
  const prepared = f.preparation.prepare();
  const rejected = assert.rejects(prepared, /cancelled/);
  f.sender.emit('did-start-navigation', {}, 'about:srcdoc', false, false);
  assert.equal(f.sent.length, 1);
  f.sender.emit('did-start-navigation', {}, 'file:///app/index.html#chat', true, true);
  assert.equal(f.sent.length, 1);
  f.sender.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
  await rejected;
  await assert.rejects(f.preparation.prepare(), /unavailable/);
  assert.equal(f.preparation.isPrepared(), false);
});

test('explicit cancellation rejects pending preparation and ignores its late acknowledgement', async () => {
  const f = fixture();
  f.invoke('abu:quit-register', 'Save failed. Please try again.');
  const prepared = f.preparation.prepare();
  const rejected = assert.rejects(prepared, /cancelled/);
  const id = f.sent[0].payload;
  f.preparation.cancel();
  await rejected;
  assert.equal(f.invoke('abu:quit-ack', { id, success: true }), false);
  assert.equal(f.preparation.isPrepared(), false);
});

test('a confirmed save remains prepared when an updater destroys the window before before-quit', async () => {
  const f = fixture();
  f.invoke('abu:quit-register', 'Save failed. Please try again.');
  const ready = f.preparation.prepare();
  f.invoke('abu:quit-ack', { id: f.sent[0].payload, success: true });
  await ready;
  f.sender.isDestroyed = () => true;
  f.sender.emit('destroyed');
  assert.equal(f.preparation.isPrepared(), true);
  await f.preparation.prepare();
  f.preparation.cancel();
  assert.equal(f.preparation.isPrepared(), false);
});

test('destroying a window without a confirmed save rejects exit preparation', async () => {
  const f = fixture();
  f.invoke('abu:quit-register', 'Save failed. Please try again.');
  const ready = f.preparation.prepare();
  const rejected = assert.rejects(ready, /cancelled/);
  f.sender.isDestroyed = () => true;
  f.sender.emit('destroyed');
  await rejected;
  assert.equal(f.preparation.isPrepared(), false);
  await assert.rejects(f.preparation.prepare(), /unavailable/);
});
