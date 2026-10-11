'use strict';

function createApplicationExitWait(app, onFailure, timeoutMs = 30000) {
  let active = true;
  let resolve;
  let reject;
  const wait = new Promise((yes, no) => { resolve = yes; reject = no; });
  const cleanup = () => {
    active = false;
    clearTimeout(timer);
    app.removeListener('will-quit', success);
  };
  const success = () => { if (active) { cleanup(); resolve(); } };
  const fail = () => {
    if (!active) return;
    cleanup();
    onFailure();
    reject(new Error('Application restart did not complete. Please try again.'));
  };
  const timer = setTimeout(fail, timeoutMs);
  app.once('will-quit', success);
  return { wait, fail, cancel: success };
}

module.exports = { createApplicationExitWait };
