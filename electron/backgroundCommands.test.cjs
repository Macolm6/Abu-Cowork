'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const {
  createBackgroundCommands,
  createOutputBuffer,
  OUTPUT_BUFFER_MAX_CHARS,
  OUTPUT_SEGMENT_MAX_CHARS,
} = require('./backgroundCommands.cjs');

// 「错误」 as a Chinese Windows console writes it under code page 936.
const GBK_ERROR = Buffer.from([0xb4, 0xed, 0xce, 0xf3]);

function fixture({ legacyEncoding = 'gbk' } = {}) {
  const events = [];
  let clock = 1_000;
  let nextId = 0;
  const table = createBackgroundCommands({
    emit: (name, payload) => events.push({ name, payload }),
    now: () => clock,
    randomId: (size) => {
      const bytes = Buffer.alloc(size);
      bytes.writeUInt32BE(nextId++);
      return bytes;
    },
    legacyEncoding,
  });
  return { table, events, tick: (ms = 1) => { clock += ms; } };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function start(table, conversationId = 'conv-a', command = 'npm run dev') {
  const child = fakeChild();
  const stops = [];
  const { id, attach } = table.register({ conversationId, command, cwd: '/work' });
  attach({ child, stop: () => stops.push(id) });
  return { id, child, stops };
}

function rowOf(table, conversationId, id) {
  return table.list(conversationId).find((row) => row.id === id);
}

test('records completed, failed and stopped exits', () => {
  const { table, tick } = fixture();
  const ok = start(table);
  const bad = start(table);
  const stopped = start(table);

  assert.match(ok.id, /^bg-[0-9a-f]{8}$/);
  assert.equal(rowOf(table, 'conv-a', ok.id).status, 'running');

  tick(5);
  ok.child.emit('close', 0);
  bad.child.emit('close', 2);
  assert.equal(table.requestStop('conv-a', stopped.id), 'requested');
  assert.equal(rowOf(table, 'conv-a', stopped.id).status, 'stopping');
  assert.deepEqual(stopped.stops, [stopped.id]);
  stopped.child.emit('close', 137);

  assert.deepEqual(rowOf(table, 'conv-a', ok.id), {
    id: ok.id,
    command: 'npm run dev',
    cwd: '/work',
    status: 'completed',
    exitCode: 0,
    startedAt: 1_000,
    finishedAt: 1_005,
  });
  const failed = rowOf(table, 'conv-a', bad.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 2);
  assert.equal(rowOf(table, 'conv-a', stopped.id).status, 'stopped');

  const viaAbort = start(table);
  table.markStopRequested(viaAbort.id);
  viaAbort.child.emit('close', 0);
  assert.equal(rowOf(table, 'conv-a', viaAbort.id).status, 'stopped');
  assert.equal(table.runningCount('conv-a'), 0);
});

test('keeps the last 1 MB and reports a gap', () => {
  const { table } = fixture();
  const { id, child } = start(table);
  const piece = 'x'.repeat(64 * 1024);
  const total = 3 * 1024 * 1024;
  for (let written = 0; written < total - piece.length; written += piece.length) {
    child.stdout.emit('data', Buffer.from(piece, 'utf8'));
  }
  child.stderr.emit('data', Buffer.from(`${'y'.repeat(piece.length - 4)}last`, 'utf8'));

  const first = table.read('conv-a', id, 0);
  assert.equal(first.gap, true);
  assert.ok(first.text.length <= OUTPUT_BUFFER_MAX_CHARS);
  assert.equal(OUTPUT_BUFFER_MAX_CHARS, 1024 * 1024);
  assert.ok(first.text.endsWith('last'));
  assert.equal(first.next, total);
  assert.equal(first.status, 'running');
  assert.equal(first.exitCode, null);

  const after = table.read('conv-a', id, first.next);
  assert.equal(after.text, '');
  assert.equal(after.gap, false);
  assert.equal(after.next, first.next);

  child.stdout.emit('data', Buffer.from('more', 'utf8'));
  assert.equal(table.read('conv-a', id, first.next).text, 'more');
});

test('keeps a bounded number of segments under many small writes', () => {
  const buffer = createOutputBuffer();
  const limit = 2 * Math.ceil(OUTPUT_BUFFER_MAX_CHARS / OUTPUT_SEGMENT_MAX_CHARS) + 3;
  const writes = 400_000;
  let largest = 0;
  for (let index = 0; index < writes; index += 1) {
    buffer.append(`${String(index).padStart(10, '0')}\n`);
    largest = Math.max(largest, buffer.segmentCount());
  }

  assert.ok(largest <= limit, `${largest} segments, limit ${limit}`);
  const { text, next, gap } = buffer.read(0);
  assert.equal(next, writes * 11);
  assert.equal(gap, true);
  assert.equal(text.length, OUTPUT_BUFFER_MAX_CHARS);
  assert.ok(text.endsWith(`${String(writes - 1).padStart(10, '0')}\n`));
  assert.equal(buffer.read(next - 11).text, `${String(writes - 1).padStart(10, '0')}\n`);
});

test('drops a leading BOM once and keeps it out of a code page switch', () => {
  const { table } = fixture({ legacyEncoding: null });
  const { id, child } = start(table);

  child.stdout.emit('data', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abcdef')]));
  child.stdout.emit('data', Buffer.from([0xff]));

  assert.equal(table.read('conv-a', id, 0).text, 'abcdef�');
});

test('decodes a multibyte character split across chunks', () => {
  const { table } = fixture();
  const { id, child } = start(table);
  const bytes = Buffer.from('完成', 'utf8');

  child.stdout.emit('data', bytes.subarray(0, 4));
  child.stdout.emit('data', bytes.subarray(4));

  assert.equal(table.read('conv-a', id, 0).text, '完成');
});

test('switches a stream to the console code page after invalid UTF-8', () => {
  const { table } = fixture({ legacyEncoding: 'gbk' });
  const { id, child } = start(table);

  child.stdout.emit('data', Buffer.from('ok\n', 'utf8'));
  child.stderr.emit('data', GBK_ERROR.subarray(0, 1));
  child.stderr.emit('data', GBK_ERROR.subarray(1));
  child.stdout.emit('data', Buffer.from('完成', 'utf8'));

  assert.equal(table.read('conv-a', id, 0).text, 'ok\n错误完成');
});

test('answers already-finished when stop races the exit', () => {
  const { table, events } = fixture();
  const { id, child, stops } = start(table);
  child.emit('close', 0);
  const emittedBeforeStop = events.length;

  assert.equal(table.requestStop('conv-a', id), 'already-finished');
  assert.equal(events.length, emittedBeforeStop);
  assert.equal(rowOf(table, 'conv-a', id).status, 'completed');
  assert.deepEqual(stops, []);
  assert.deepEqual(events.map((event) => event.name), [
    'background-commands://changed',
    'background-commands://changed',
  ]);
  assert.deepEqual(events[1].payload, { conversationId: 'conv-a' });

  const racing = start(table);
  assert.equal(table.requestStop('conv-a', racing.id), 'requested');
  assert.equal(table.requestStop('conv-a', racing.id), 'requested');
  assert.deepEqual(racing.stops, [racing.id]);
  racing.child.emit('close', 0);
  assert.equal(rowOf(table, 'conv-a', racing.id).status, 'stopped');
});

test('drops the oldest settled rows beyond the limits', () => {
  const { table, tick } = fixture();
  const running = start(table, 'conv-a', 'long');
  const finished = [];
  for (let index = 0; index < 21; index += 1) {
    const run = start(table, 'conv-a', `job ${index}`);
    tick();
    run.child.emit('close', 0);
    finished.push(run.id);
  }

  const rows = table.list('conv-a');
  assert.equal(rows.length, 21);
  assert.ok(rows.some((row) => row.id === running.id && row.status === 'running'));
  assert.ok(!rows.some((row) => row.id === finished[0]));
  assert.ok(finished.slice(1).every((id) => rows.some((row) => row.id === id)));

  for (let conversation = 0; conversation < 5; conversation += 1) {
    for (let index = 0; index < 20; index += 1) {
      const run = start(table, `conv-${conversation}`, `job ${index}`);
      tick();
      run.child.emit('close', 0);
    }
  }

  const settled = ['conv-a', 'conv-0', 'conv-1', 'conv-2', 'conv-3', 'conv-4']
    .flatMap((conversationId) => table.list(conversationId))
    .filter((row) => row.status !== 'running');
  assert.equal(settled.length, 100);
  assert.equal(table.list('conv-a').filter((row) => row.status !== 'running').length, 0);
  assert.equal(table.list('conv-0').length, 20);
  assert.ok(rowOf(table, 'conv-a', running.id));
  assert.equal(table.runningCount(), 1);
});

test('throws when the conversation does not own the command', () => {
  const { table } = fixture();
  const { id } = start(table, 'conv-a');

  assert.throws(() => table.read('conv-b', id, 0), /conv-b/);
  assert.throws(() => table.requestStop('conv-b', id), /conv-b/);
  assert.throws(() => table.read('conv-a', 'bg-ffffffff', 0), /bg-ffffffff/);
  assert.throws(() => table.requestStop('conv-a', 'bg-ffffffff'), /bg-ffffffff/);
  assert.equal(rowOf(table, 'conv-a', id).status, 'running');
});

test('clears settled rows, stops a conversation and discards a failed start', () => {
  const { table, events } = fixture();
  const done = start(table, 'conv-a');
  const live = start(table, 'conv-a');
  const other = start(table, 'conv-b');
  done.child.emit('close', 0);

  table.clear('conv-a');
  assert.deepEqual(table.list('conv-a').map((row) => row.id), [live.id]);

  table.stopConversation('conv-a');
  assert.deepEqual(live.stops, [live.id]);
  assert.deepEqual(table.list('conv-a'), []);
  live.child.emit('close', 137);
  assert.deepEqual(table.list('conv-a'), []);
  assert.equal(table.runningCount('conv-b'), 1);

  const emittedBeforeDiscard = events.length;
  table.discard(other.id);
  assert.deepEqual(table.list('conv-b'), []);
  assert.equal(events.length, emittedBeforeDiscard + 1);
  assert.deepEqual(events.at(-1).payload, { conversationId: 'conv-b' });
  assert.equal(table.runningCount(), 0);
});

test('keeps the rows of a conversation when one stop throws', () => {
  const { table } = fixture();
  const first = table.register({ conversationId: 'conv-a', command: 'one' });
  first.attach({ child: fakeChild(), stop: () => { throw new Error('kill failed'); } });
  const second = start(table, 'conv-a', 'two');

  assert.throws(() => table.stopConversation('conv-a'), /kill failed/);
  assert.deepEqual(table.list('conv-a').map((row) => row.id), [first.id, second.id]);
});

test('requires every dependency', () => {
  const deps = {
    emit: () => {},
    now: () => 0,
    randomId: (size) => Buffer.alloc(size),
    legacyEncoding: null,
  };
  for (const name of Object.keys(deps)) {
    assert.throws(() => createBackgroundCommands({ ...deps, [name]: undefined }), new RegExp(name));
  }
  assert.throws(() => createBackgroundCommands({ ...deps, legacyEncoding: 'no-such-code-page' }));
});
