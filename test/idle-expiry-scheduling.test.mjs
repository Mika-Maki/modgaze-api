import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMRExpiryCleaner } from '../src/key-expiry-cleaner.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// A clock local to the cleaner: no HTTP or filesystem timing is involved.
function clockFor(t) {
  let time = 1000000, unrefs = 0;
  const pending = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    assert.ok(Number.isFinite(delay) && delay >= 1 && delay <= 2147483647, 'bounded positive delay');
    const timer = { unref() { unrefs++; return this; } };
    pending.set(timer, { at: time + delay, callback: () => callback(...args) });
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { pending.delete(timer); });
  return {
    now: () => time,
    get pending() { return pending.size; },
    get unrefs() { return unrefs; },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        pending.delete(next[0]); time = next[1].at;
        next[1].callback(); await flush();
      }
      time = target; await flush();
    },
  };
}

function watcherFor() {
  let listener, closes = 0, unrefs = 0;
  const watcher = new EventEmitter();
  watcher.unref = () => { unrefs++; return watcher; };
  watcher.close = () => { closes++; watcher.emit('close'); };
  return {
    watcher,
    watch(path, ...args) {
      assert.equal(path, '/synthetic/config');
      listener = args.at(-1);
      assert.equal(typeof listener, 'function');
      return watcher;
    },
    change(type = 'change', name = 'local.json') { listener(type, name); },
    get closes() { return closes; },
    get unrefs() { return unrefs; },
  };
}

function fixture(t, { remove, watchFails = false } = {}) {
  const clock = clockFor(t), events = watcherFor();
  let calls = 0;
  const store = {
    configPath: '/synthetic/config/local.json',
    async removeExpiredMRKeys(time) {
      calls++;
      return remove ? remove(time, calls) : { removed: [], nextExpiry: Infinity };
    },
  };
  const cleaner = createMRExpiryCleaner(store, {
    now: clock.now,
    watch: watchFails ? () => { throw new Error('synthetic watcher failure'); } : events.watch,
  });
  t.after(() => cleaner.close());
  return { clock, events, cleaner, calls: () => calls };
}

test('idle expiry cleanup waits for its fallback rescan instead of polling every second', async t => {
  const f = fixture(t);
  await f.cleaner.run();
  assert.equal(f.calls(), 1);
  assert.equal(f.clock.pending, 1);
  assert.ok(f.clock.unrefs > 0);
  await f.clock.advance(59999);
  assert.equal(f.calls(), 1);
  await f.clock.advance(1);
  assert.equal(f.calls(), 2);
  assert.equal(f.clock.pending, 1);
});

test('known expiry is checked exactly at its deadline', async t => {
  const deadline = 1001500;
  const f = fixture(t, { remove: (time, calls) => ({ removed: [], nextExpiry: calls === 1 ? deadline : Infinity }) });
  await f.cleaner.run();
  await f.clock.advance(1499);
  assert.equal(f.calls(), 1);
  await f.clock.advance(1);
  assert.equal(f.calls(), 2);
  assert.equal(f.clock.pending, 1);
});

test('a watched external edit rechecks an earlier expiry without waiting for rescan', async t => {
  let deadline = Infinity;
  const f = fixture(t, { remove: () => ({ removed: [], nextExpiry: deadline }) });
  await f.cleaner.run();
  deadline = f.clock.now() + 500;
  f.events.change('rename', Buffer.from('local.json'));
  await flush();
  assert.equal(f.calls(), 2);
  await f.clock.advance(499);
  assert.equal(f.calls(), 2);
  deadline = Infinity;
  await f.clock.advance(1);
  assert.equal(f.calls(), 3);
});

test('unknown watcher filenames trigger a secure reread', async t => {
  const f = fixture(t);
  await f.cleaner.run();
  f.events.change('change', null);
  await flush();
  assert.equal(f.calls(), 2);
});

test('watch changes during pending cleanup cause one serialized recheck', async t => {
  const entered = deferred(), finish = deferred();
  let active = 0, maximum = 0;
  const f = fixture(t, { remove: async (time, calls) => {
    maximum = Math.max(maximum, ++active);
    if (calls === 1) { entered.resolve(); await finish.promise; }
    active--;
    return { removed: [], nextExpiry: Infinity };
  } });
  const first = f.cleaner.run();
  assert.equal(first, f.cleaner.run(), 'manual calls share the pending work');
  await entered.promise;
  f.events.change(); f.events.change('rename');
  await flush();
  assert.equal(f.calls(), 1);
  finish.resolve(); await first; await flush();
  assert.equal(f.calls(), 2, 'events were not swallowed by pending-work deduplication');
  assert.equal(maximum, 1);
  assert.equal(f.clock.pending, 1);
});

test('watch construction failure falls back to the original one-second scan', async t => {
  const f = fixture(t, { watchFails: true });
  await f.cleaner.run();
  await f.clock.advance(999);
  assert.equal(f.calls(), 1);
  await f.clock.advance(1);
  assert.equal(f.calls(), 2);
});

for (const event of ['error', 'close']) {
  test('unexpected watcher ' + event + ' restores one-second polling', async t => {
    const f = fixture(t);
    await f.cleaner.run();
    f.events.watcher.emit(event, new Error('synthetic watcher failure'));
    await flush();
    const calls = f.calls();
    await f.clock.advance(1000);
    assert.ok(f.calls() > calls, 'fallback does not wait for the old 60-second timer');
    assert.equal(f.clock.pending, 1);
  });
}

test('failed cleanup retries after one second without an already-expired busy loop', async t => {
  const f = fixture(t, { remove: (time, calls) => {
    if (calls === 1) throw new Error('synthetic secure read failure');
    return { removed: [], nextExpiry: Infinity };
  } });
  await assert.rejects(f.cleaner.run(), /secure read failure/);
  assert.equal(f.clock.pending, 1);
  await f.clock.advance(999);
  assert.equal(f.calls(), 1);
  await f.clock.advance(1);
  assert.equal(f.calls(), 2);
});

test('closing pending cleanup cancels watches and prevents late results from rearming', async t => {
  const entered = deferred(), finish = deferred();
  const f = fixture(t, { remove: async () => {
    entered.resolve(); await finish.promise;
    return { removed: [], nextExpiry: Infinity };
  } });
  const run = f.cleaner.run();
  await entered.promise;
  f.events.change();
  const close = f.cleaner.close();
  finish.resolve();
  await Promise.all([run, close]); await flush();
  assert.equal(f.clock.pending, 0);
  assert.equal(f.events.closes, 1);
  f.events.change('rename'); await flush();
  await f.clock.advance(120000);
  assert.equal(f.calls(), 1);
  assert.deepEqual(await f.cleaner.run(), { removed: [] });
});
