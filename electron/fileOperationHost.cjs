'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createNativeFileSession } = require('./nativeHelperManager.cjs');
const { wireRendererResourceCleanup } = require('./rendererLifecycle.cjs');
const { assertAllowed } = require('./fsHost.cjs');
const { runFileProcessor } = require('./fileProcessorHost.cjs');

const FILE_OPERATION_CHANNEL = 'abu:file-operation';
const ACTIONS = new Set(['observe', 'observe-child', 'validate', 'compare-component', 'exists', 'stat', 'read', 'office-document', 'search-lines', 'image-process', 'write', 'ensure-parent', 'enumerate', 'trash']);

function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 10_000) throw new Error('Invalid file operation targets');
  return Object.freeze(targets.map(target => {
    if (!target || typeof target.path !== 'string' || target.path.length > 32_768
      || target.path.includes('\0') || !path.isAbsolute(target.path)
      || !['read', 'write', 'list', 'traverse', 'delete'].includes(target.purpose)
      || typeof target.followFinalSymlink !== 'boolean'
      || (target.purpose === 'delete' && target.followFinalSymlink)) throw new Error('Invalid file operation target');
    return Object.freeze({ path: target.path, purpose: target.purpose, followFinalSymlink: target.followFinalSymlink });
  }));
}

function createFileOperationHost({ trashItem, app, processorRoot }) {
  const sessions = new Map();
  const watched = new WeakSet();
  let pending = 0;
  return async function dispatch(sender, action, request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid file operation request');
    if (action === 'open') {
      if (sessions.size >= 128) throw new Error('File operation session limit reached');
      const targets = validateTargets(request.targets);
      for (const target of targets) assertTargetAllowed(target);
      const session = randomUUID();
      sessions.set(session, { sender, targets, references: new Map(), entries: new Map(), native: createNativeFileSession(targets) });
      if (!watched.has(sender)) {
        watched.add(sender);
        const clearSessions = () => {
          const releases = [];
          for (const [token, record] of sessions) {
            if (record.sender !== sender) continue;
            sessions.delete(token);
            releases.push(record.native.release());
          }
          void Promise.allSettled(releases).then(results => {
            if (results.some(result => result.status === 'rejected')) console.error('[file-operation] Session cleanup failed');
          });
        };
        const removeNavigation = wireRendererResourceCleanup(sender, clearSessions);
        sender.on('render-process-gone', clearSessions);
        sender.once('destroyed', () => {
          clearSessions();
          removeNavigation();
          sender.removeListener('render-process-gone', clearSessions);
        });
      }
      return { session };
    }
    if (typeof request.session !== 'string') throw new Error('Invalid file operation session');
    const record = sessions.get(request.session);
    if (!record && action === 'release') return;
    if (!record || record.sender !== sender) throw new Error('File operation session is unavailable');
    if (action === 'release') {
      sessions.delete(request.session);
      await record.native.release();
      return;
    }
    if (!ACTIONS.has(action) && action !== 'processor') throw new Error('Invalid file operation action');
    if (pending >= 64) throw new Error('File operation queue limit reached');
    pending += 1;
    try {
      let target;
      if (action === 'observe') {
        target = record.targets.find(item => item.path === request.path
          && item.purpose === request.purpose && item.followFinalSymlink === request.followFinalSymlink);
        if (!target) throw new Error('File target is outside this operation');
        assertTargetAllowed(target);
      } else if (action === 'observe-child') {
        checkedReference(record, request.parent);
        const entry = record.entries.get(request.entry);
        if (!entry || entry.parent !== request.parent) throw new Error('File entry is outside this operation');
        [target] = validateTargets([{ path: entry.path, purpose: request.purpose, followFinalSymlink: request.followFinalSymlink }]);
        assertTargetAllowed(target);
      } else {
        target = checkedReference(record, request.reference).target;
        if (action === 'image-process' && request.outputReference !== undefined) checkedReference(record, request.outputReference);
        if (action === 'trash') {
          if (!Array.isArray(request.manifest) || request.manifest.length > 10_000) throw new Error('Invalid file manifest');
          for (const reference of request.manifest) checkedReference(record, reference);
        }
      }
      if (action === 'processor') {
        return await runFileProcessor(app, record.native, request.reference, request,
          processorRoot ?? path.join(app.getPath('userData'), 'file-processors'));
      }
      const result = await record.native.request(action, request);
      record.native.assertCurrent();
      if (action === 'observe' || action === 'observe-child') {
        if (!result || typeof result.reference !== 'string' || typeof result.path !== 'string'
          || path.resolve(result.path) !== path.resolve(target.path)
          || typeof result.canonicalPath !== 'string' || !path.isAbsolute(result.canonicalPath)) {
          throw new Error('Invalid checked file target');
        }
        assertTargetAllowed({ ...target, path: result.canonicalPath });
        record.references.set(result.reference, { target, canonicalPath: result.canonicalPath });
      } else if (action === 'enumerate') {
        if (!result || !Array.isArray(result.entries) || result.entries.length > 10_000) throw new Error('Invalid checked directory entries');
        for (const entry of result.entries) {
          if (!entry || typeof entry.reference !== 'string' || typeof entry.name !== 'string'
            || !entry.name || entry.name === '.' || entry.name === '..' || /[/\\\0]/.test(entry.name)) {
            throw new Error('Invalid checked directory entry');
          }
          record.entries.set(entry.reference, { parent: request.reference, path: path.join(target.path, entry.name) });
        }
      }
      if (action === 'trash') {
        if (!result || typeof result.path !== 'string' || !path.isAbsolute(result.path)) throw new Error('Invalid checked Trash entry');
        assertTargetAllowed({ ...target, path: result.path });
        await trashItem(path.resolve(result.path));
        record.native.assertCurrent();
        return;
      }
      return result;
    } finally {
      pending -= 1;
    }
  };
}

function assertTargetAllowed(target) {
  assertAllowed(target.path, { remove: target.purpose === 'delete', followFinalSymlink: target.followFinalSymlink });
}

function checkedReference(record, reference) {
  const observed = record.references.get(reference);
  if (!observed) throw new Error('File reference is outside this operation');
  assertTargetAllowed(observed.target);
  assertTargetAllowed({ ...observed.target, path: observed.canonicalPath });
  return observed;
}

module.exports = { FILE_OPERATION_CHANNEL, createFileOperationHost };
