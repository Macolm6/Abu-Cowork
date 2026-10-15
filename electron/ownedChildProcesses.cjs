'use strict';

function createOwnedChildProcesses() {
  const entries = new Set();
  let closing = false;

  function assertAdmission() {
    if (closing) throw new Error('Application is exiting');
  }

  function track(child, stop) {
    let resolve;
    const closed = new Promise(done => { resolve = done; });
    trackCompletion(closed, stop);
    child.once('close', resolve);
  }

  function trackCompletion(closed, stop) {
    const entry = { stop, closed };
    entries.add(entry);
    void closed.then(() => {
      entries.delete(entry);
    });
  }

  async function shutdown() {
    closing = true;
    const pending = [...entries];
    for (const entry of pending) entry.stop();
    // Keep Node's event loop alive until its process-exit callbacks have run.
    // Closing live process handles during FreeEnvironment can block on Windows.
    await Promise.all(pending.map(entry => entry.closed));
  }

  return { assertAdmission, track, trackCompletion, shutdown, resume() { closing = false; } };
}

module.exports = { createOwnedChildProcesses, ownedChildProcesses: createOwnedChildProcesses() };
