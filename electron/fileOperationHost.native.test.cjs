'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createFileOperationHost } = require('./fileOperationHost.cjs');
const { fsDispatch } = require('./fsHost.cjs');
const helper = require('./nativeHelperManager.cjs');

test.after(() => helper.killNativeHelper('file-host-tests-finished'));

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.agent');
  const root = await fs.mkdtemp(path.join(parent, 'file-host-native-'));
  const file = path.join(root, 'entry.txt');
  await fs.writeFile(file, 'original');
  const sender = new EventEmitter();
  const app = { isPackaged: false, getAppPath: () => path.resolve(__dirname, '..'),
    getPath: () => root, once() {} };
  const dispatch = createFileOperationHost({ app, processorRoot: path.join(root, 'processors'),
    trashItem: async () => assert.fail('Trash is outside this fixture') });
  const sessions = [];
  t.after(async () => {
    const failures = [];
    const released = await Promise.allSettled(sessions.map(record => dispatch(record.sender, 'release', { session: record.session })));
    for (const result of released) if (result.status === 'rejected') failures.push(result.reason);
    const absolute = path.resolve(root);
    const relative = path.relative(parent, absolute);
    assert.ok(path.isAbsolute(absolute) && relative !== '' && relative !== '..'
      && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'Fixture cleanup must stay strictly inside the repository .agent directory');
    try { await fs.rm(absolute, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'File host fixture cleanup failed');
  });
  const target = purpose => ({ path: file, purpose, followFinalSymlink: true });
  async function open(purpose = 'read', owner = sender) {
    const opened = await dispatch(owner, 'open', { targets: [target(purpose)] });
    sessions.push({ session: opened.session, sender: owner });
    return opened.session;
  }
  return { root, file, sender, dispatch, sessions, target, open };
}

test('a real processor receives a retained input copy and its directory is cleaned after exit', async t => {
  const { root, file, sender, dispatch, target, open } = await fixture(t);
  const session = await open('read');
  const observed = await dispatch(sender, 'observe', { session, ...target('read') });
  const result = await dispatch(sender, 'processor', { session, reference: observed.reference,
    program: 'python', args: ['-c', 'import sys,json,pathlib; print(json.dumps([sys.argv[1],pathlib.Path(sys.argv[1]).read_text()]))', null] });
  assert.equal(result.code, 0, result.stderr);
  const [receivedPath, content] = JSON.parse(result.stdout);
  assert.notEqual(path.resolve(receivedPath), file);
  assert.equal(content, 'original');
  assert.deepEqual(await fs.readdir(path.join(root, 'processors')), []);
});

test('a cancelled processor cannot consume another call or reopen its source', async t => {
  const { sender, dispatch, target, open } = await fixture(t);
  const session = await open('read');
  const observed = await dispatch(sender, 'observe', { session, ...target('read') });
  await assert.rejects(dispatch(sender, 'processor', { session, reference: observed.reference,
    program: 'python', args: ['-c', 'print(1)'] }), /Invalid file processor/);
  await dispatch(sender, 'release', { session });
  await assert.rejects(dispatch(sender, 'processor', { session, reference: observed.reference,
    program: 'python', args: [null] }), /unavailable/);
});

for (const interruption of ['release', 'navigation', 'helper restart']) {
  test(`${interruption} terminates an active processor before releasing its input copy`, async t => {
    const { root, sender, dispatch, target, open } = await fixture(t);
    const ready = path.join(root, 'consumer-ready.json');
    const finish = path.join(root, 'consumer-finish');
    const session = await open('read');
    const observed = await dispatch(sender, 'observe', { session, ...target('read') });
    const script = [
      'import sys,json,pathlib,time,os',
      'source=pathlib.Path(sys.argv[1])',
      'pathlib.Path(sys.argv[2]).write_text(json.dumps({"pid":os.getpid(),"source":str(source)}))',
      'while not pathlib.Path(sys.argv[3]).exists():',
      ' time.sleep(0.01)',
      'print(source.read_text())',
    ].join('\n');
    const execution = dispatch(sender, 'processor', { session, reference: observed.reference,
      program: 'python', args: ['-c', script, null, ready, finish], sandboxEnabled: false });
    const settled = execution.then(result => ({ result }), error => ({ error }));
    let timer;
    try {
      let consumer;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try { consumer = JSON.parse(await fs.readFile(ready, 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(consumer && Number.isSafeInteger(consumer.pid), 'The real consumer must reach its input-read boundary');
      assert.ok((await fs.stat(consumer.source)).isFile(), 'The active consumer retains its input copy');
      if (interruption === 'release') await dispatch(sender, 'release', { session });
      else if (interruption === 'navigation') sender.emit('did-start-navigation', {}, 'about:blank', false, true);
      else helper.killNativeHelper('processor-cancellation-test');
      const outcome = await Promise.race([settled, new Promise(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), 2000);
      })]);
      assert.equal(outcome.timedOut, undefined, 'Cancellation must finish without waiting for the processor timeout');
      assert.ok(outcome.error, 'The cancelled consumer must not publish a result');
      assert.throws(() => process.kill(consumer.pid, 0), { code: 'ESRCH' }, 'Cleanup follows the actual consumer exit');
      assert.deepEqual(await fs.readdir(path.join(root, 'processors')), []);
    } finally {
      clearTimeout(timer);
      await fs.writeFile(finish, 'finish');
      await settled;
    }
  });
}

test('the file session IPC preserves the filesystem host root capability gate', async t => {
  const { file, sender, dispatch, sessions, target } = await fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  let opened;
  // Only the OS capability selection is substituted. Both dispatchers and all
  // subsequent file requests use their real implementations and the real helper.
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
  try {
    assert.throws(() => fsDispatch({}, 'plugin:fs|read_text_file', { args: { path: file } }), /outside the allowed scope/);
    opened = dispatch(sender, 'open', { targets: [target('read')] });
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
  await assert.rejects(opened.then(async result => {
    sessions.push({ session: result.session, sender });
    const observed = await dispatch(sender, 'observe', { session: result.session, ...target('read') });
    return dispatch(sender, 'read', { session: result.session, reference: observed.reference });
  }), /outside the allowed scope/);
});

for (const [name, event, args] of [
  ['renderer crash', 'render-process-gone', [{}, { reason: 'crashed' }]],
  ['main document navigation', 'did-start-navigation', [{}, 'about:blank', false, true]],
  ['sender destruction', 'destroyed', []],
]) {
  test(`${name} cancels queued I/O and releases retained handles`, async t => {
    const { file, sender, dispatch, target, open } = await fixture(t);
    const session = await open('write');
    const observed = await dispatch(sender, 'observe', { session, ...target('write') });
    const pending = dispatch(sender, 'write', { session, reference: observed.reference, bytes: [...Buffer.from('changed')] });
    sender.emit(event, ...args);
    await assert.rejects(pending, /no longer active|unavailable/);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    await dispatch(sender, 'release', { session });
    const currentSender = event === 'destroyed' ? new EventEmitter() : sender;
    const current = await open('read', currentSender);
    const next = await dispatch(currentSender, 'observe', { session: current, ...target('read') });
    const result = await dispatch(currentSender, 'read', { session: current, reference: next.reference });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), 'original');
  });
}

test('child navigation and same-document navigation preserve the active page session', async t => {
  const { sender, dispatch, target, open } = await fixture(t);
  const session = await open();
  const observed = await dispatch(sender, 'observe', { session, ...target('read') });
  sender.emit('did-start-navigation', {}, 'about:blank', false, false);
  sender.emit('did-start-navigation', {}, 'about:blank#section', true, true);
  const result = await dispatch(sender, 'read', { session, reference: observed.reference });
  assert.equal(Buffer.from(result.bytes).toString('utf8'), 'original');
});
