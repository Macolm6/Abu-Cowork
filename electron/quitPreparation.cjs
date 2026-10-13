'use strict';

const { randomUUID } = require('node:crypto');
const { wireRendererResourceCleanup } = require('./rendererLifecycle.cjs');

function createQuitPreparation({ ipcMain, assertSender, timeoutMs = 30000 }) {
  let owner = null;
  let generation = 0;
  let preparedGeneration = -1;
  let required = false;
  let pending = null;
  let preparedRequest = null;
  let disposeOwner = null;

  function cancel() {
    preparedGeneration = -1;
    if (preparedRequest && !preparedRequest.sender.isDestroyed()) {
      preparedRequest.sender.send('abu:quit-cancel', preparedRequest.id);
    }
    preparedRequest = null;
    if (pending) {
      const request = pending;
      pending = null;
      clearTimeout(request.timer);
      if (!request.sender.isDestroyed()) request.sender.send('abu:quit-cancel', request.id);
      request.reject(new Error('Application exit preparation was cancelled'));
    }
  }

  function clearOwner() {
    cancel();
    generation++;
    owner = null;
    disposeOwner?.();
    disposeOwner = null;
  }

  function destroyOwner() {
    const saved = preparedGeneration === generation;
    clearOwner();
    // Updaters close windows before before-quit; the acknowledged save remains valid.
    if (saved) preparedGeneration = generation;
  }

  ipcMain.handle('abu:quit-register', (event, failureMessage) => {
    assertSender(event);
    if (typeof failureMessage !== 'string' || !failureMessage.trim() || failureMessage.length > 500) {
      throw new Error('Invalid exit preparation message');
    }
    clearOwner();
    required = true;
    owner = { sender: event.sender, failureMessage };
    const navigation = wireRendererResourceCleanup(event.sender, clearOwner);
    event.sender.on('destroyed', destroyOwner);
    event.sender.on('render-process-gone', clearOwner);
    disposeOwner = () => {
      navigation();
      event.sender.removeListener('destroyed', destroyOwner);
      event.sender.removeListener('render-process-gone', clearOwner);
    };
  });

  ipcMain.handle('abu:quit-ack', (event, payload) => {
    assertSender(event);
    if (!payload || typeof payload.id !== 'string' || typeof payload.success !== 'boolean') {
      throw new Error('Invalid exit preparation acknowledgement');
    }
    if (!pending || pending.sender !== event.sender || pending.id !== payload.id) return false;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    if (payload.success) {
      preparedGeneration = generation;
      preparedRequest = request;
      request.resolve();
    } else {
      event.sender.send('abu:quit-cancel', request.id);
      request.reject(new Error('Application data could not be saved'));
    }
    return true;
  });

  function prepare() {
    if (isPrepared()) return Promise.resolve();
    if (pending) return pending.promise;
    if (!owner || owner.sender.isDestroyed()) {
      return Promise.reject(new Error('Application exit participant is unavailable'));
    }
    const id = randomUUID();
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(cancel, timeoutMs);
    pending = { id, sender: owner.sender, promise, resolve, reject, timer };
    owner.sender.send('abu:quit-prepare', id);
    return promise;
  }

  function isPrepared() { return !required || preparedGeneration === generation; }
  return {
    prepare,
    isPrepared,
    cancel,
    failureMessage: () => owner?.failureMessage ?? 'Your data could not be saved. Please try closing the application again.',
  };
}

module.exports = { createQuitPreparation };
