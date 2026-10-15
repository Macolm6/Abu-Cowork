'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, beforeEach, after } = require('node:test');
const calls = [];
const electronId = require.resolve('electron');
const previous = require.cache[electronId];
require.cache[electronId] = {
  id: electronId, filename: electronId, loaded: true,
  exports: { shell: { trashItem: async target => { calls.push(target); } } },
};
const { desktopDispatch } = require('./desktopHost.cjs');
beforeEach(() => { calls.length = 0; });
after(() => {
  if (previous) require.cache[electronId] = previous;
  else delete require.cache[electronId];
});

test('OS Trash receives the native absolute spelling of a normalized renderer path', async () => {
  const native = path.resolve(__dirname, '../.agent/trash-target.txt');
  await desktopDispatch({}, 'move_to_trash', { args: { path: native.replaceAll('\\', '/') } });
  assert.deepEqual(calls, [native]);
});

for (const target of ['.', '../file.txt', '', undefined, null, 123]) {
  test(`OS Trash rejects an invalid or relative target ${String(target)} before invoking Electron`, async () => {
    await assert.rejects(desktopDispatch({}, 'move_to_trash', { args: { path: target } }), /absolute path/);
    assert.deepEqual(calls, []);
  });
}
