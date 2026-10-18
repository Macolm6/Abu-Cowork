'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helper = require('./nativeHelperManager.cjs');
const { inspectPathNameComparison } = require('./fsHost.cjs');

function fixture(t) {
  const root = path.resolve(__dirname, '../.agent');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'name-comparison-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modes = new Map();
  let intercept = async () => {};
  t.mock.method(helper, 'readDirectoryNameComparison', async parent => {
    // Only the native property query is substituted. Host resolution and the
    // changing filesystem are real; identity follows the actual directory.
    const stat = fs.statSync(parent, { bigint: true });
    const facts = { caseMode: modes.get(parent) ?? 'insensitive', directoryIdentity: `${stat.dev}:${stat.ino}`, platform: 'windows', filesystem: 'NTFS' };
    await intercept(parent);
    return facts;
  });
  return { dir, modes, intercept(fn) { intercept = fn; } };
}

test('returns per-parent facts and marks missing parents as unknown', async t => {
  const { dir, modes } = fixture(t);
  const sensitive = path.join(dir, 'sensitive');
  fs.mkdirSync(sensitive);
  modes.set(sensitive, 'sensitive');
  const result = await inspectPathNameComparison(path.join(sensitive, 'future.txt'));
  assert.equal(result.lexical.components.at(-1).caseMode, 'sensitive');
  assert.equal(result.lexical.components.find(component => component.name === 'sensitive').caseMode, 'insensitive');
  const missing = await inspectPathNameComparison(path.join(dir, 'missing/new.txt'));
  assert.equal(missing.lexical.components.at(-1).caseMode, 'unknown');
  assert.equal(missing.lexical.components.at(-1).directoryIdentity, null);
});

test('refuses replaced parents even when their canonical path string stays unchanged', async t => {
  const state = fixture(t);
  const parent = path.join(state.dir, 'parent');
  const child = path.join(parent, 'child');
  fs.mkdirSync(child, { recursive: true });
  let reached;
  let release;
  const waiting = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  state.intercept(async directory => { if (directory === child) { reached(); await resume; } });
  const pending = inspectPathNameComparison(path.join(child, 'future.txt'));
  await waiting;
  fs.renameSync(parent, path.join(state.dir, 'previous-parent'));
  fs.mkdirSync(child, { recursive: true });
  release();
  await assert.rejects(pending, /directory changed while reading name comparison/);
});

test('refuses a changed case mode while another parent query is waiting', async t => {
  const state = fixture(t);
  const parent = path.join(state.dir, 'parent');
  const child = path.join(parent, 'child');
  fs.mkdirSync(child, { recursive: true });
  let reached;
  let release;
  const waiting = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  state.intercept(async directory => { if (directory === child) { reached(); await resume; } });
  const pending = inspectPathNameComparison(path.join(child, 'future.txt'));
  await waiting;
  state.modes.set(parent, 'sensitive');
  release();
  await assert.rejects(pending, /directory changed while reading name comparison/);
});

test('refuses a parent that appears during verification of a missing write tail', async t => {
  const state = fixture(t);
  const missing = path.join(state.dir, 'missing');
  const counts = new Map();
  state.intercept(async directory => {
    const count = (counts.get(directory) ?? 0) + 1;
    counts.set(directory, count);
    if (directory === path.parse(state.dir).root && count === 2) fs.mkdirSync(missing);
  });
  await assert.rejects(inspectPathNameComparison(path.join(missing, 'future.txt')), /directory appeared while reading name comparison/);
});
