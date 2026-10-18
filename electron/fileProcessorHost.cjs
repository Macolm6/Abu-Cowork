'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createNativeFileSession } = require('./nativeHelperManager.cjs');
const { commandDispatch } = require('./commandHost.cjs');

/** A consumer receives a copy of an already retained input, for its lifetime. */
async function runFileProcessor(app, original, reference, request, root) {
  if (typeof request.program !== 'string' || !request.program || request.program.length > 256
    || !Array.isArray(request.args) || request.args.length > 128
    || request.args.filter(value => value === null).length !== 1
    || request.args.some(value => value !== null && (typeof value !== 'string' || value.length > 32_768))) {
    throw new Error('Invalid file processor request');
  }
  const bytes = await original.request('read', { reference });
  original.assertCurrent();
  if (!bytes || !Array.isArray(bytes.bytes) || bytes.bytes.length > 64 * 1024 * 1024) throw new Error('Invalid processor input');
  if (!path.isAbsolute(root)) throw new Error('Invalid processor directory');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  original.assertCurrent();
  const directory = await fs.mkdtemp(path.join(root, 'input-'));
  const identity = await fs.lstat(directory, { bigint: true });
  let retained;
  let consumerStarted = false;
  let cancelConsumer;
  const unsubscribe = original.onInvalidated(() => cancelConsumer?.());
  let consumerClosed;
  const closed = new Promise(resolve => { consumerClosed = resolve; });
  try {
    original.assertCurrent();
    const input = path.join(directory, 'input');
    await fs.writeFile(input, Buffer.from(bytes.bytes), { flag: 'wx', mode: 0o400 });
    original.assertCurrent();
    const target = { path: input, purpose: 'read', followFinalSymlink: false };
    retained = createNativeFileSession([target]);
    await retained.request('observe', target);
    original.assertCurrent();
    const result = await commandDispatch(app, 'run_argv_command', {
      program: request.program, args: request.args.map(value => value === null ? input : value),
      timeout: 30, sandboxEnabled: request.sandboxEnabled !== false,
      extraWritablePaths: [],
    }, {
      assertCurrent() { original.assertCurrent(); retained.assertCurrent(); },
      onConsumerStarted(cancel) { consumerStarted = true; cancelConsumer = cancel; },
      onConsumerClosed() { consumerClosed(); },
    });
    original.assertCurrent();
    return result;
  } finally {
    unsubscribe();
    if (consumerStarted) await closed;
    try { await retained?.release(); }
    finally { await removeProcessorDirectory(root, directory, identity); }
  }
}

async function removeProcessorDirectory(root, directory, identity) {
  const current = await fs.lstat(directory, { bigint: true });
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || !current.isDirectory() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) {
    throw new Error('Processor directory identity changed');
  }
  await fs.rm(directory, { recursive: true });
}

module.exports = { runFileProcessor };
