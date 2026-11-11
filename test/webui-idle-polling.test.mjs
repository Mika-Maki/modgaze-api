import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness() {
  const source = await readFile(new URL('../public/assets/js/data.js', import.meta.url), 'utf8');
  const script = source.replace(/^import .*$/gm, '').replace(/export \{[^}]+\};/g, '');
  const app = { authenticated: true, csrf: 'first', polling: null, stats: { requests: 10 }, data: { configRevision: 1 }, route: { name: 'keys' } };
  let now = 100000, next = 0;
  const timers = new Map(), listeners = new Map(), calls = [], replies = [];
  const document = { hidden: false, body: { dataset: {} }, addEventListener: (name, handler) => listeners.set(name, handler) };
  const data = vm.runInNewContext(script + '\n;({startPolling,stopPolling,pollStats});', {
    app, document, Date: { now: () => now },
    setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; }, clearTimeout(id) { timers.delete(id); },
    api: async path => { calls.push(path); const response = replies.length ? replies.shift() : { stats: { requests: app.stats.requests }, configRevision: 1 }; if (response instanceof Error) throw response; return response; },
    hideOffline() {}, showOffline() {}, updateLiveStats() {}, updateChrome() {},
  });
  return { ...data, app, document, timers, calls, replies,
    get delay() { assert.equal(timers.size, 1); return [...timers.values()][0].delay; },
    async tick() { const [id, timer] = [...timers.entries()][0]; timers.delete(id); now += timer.delay; timer.fn(); await new Promise(setImmediate); },
    async visibility(hidden) { document.hidden = hidden; listeners.get('visibilitychange')(); await new Promise(setImmediate); },
    advance(ms) { now += ms; },
  };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('serial stats timers back off idle traffic from 4 to 8 to 16 to 30 seconds and reset on traffic', async () => {
  const h = await harness();
  h.startPolling();
  assert.equal(h.delay, 4000);
  assert.equal(h.calls.length, 0);
  for (const delay of [8000, 16000, 30000, 30000]) { await h.tick(); assert.equal(h.delay, delay); }
  h.replies.push({ stats: { requests: 11 }, configRevision: 1 });
  await h.tick();
  assert.equal(h.delay, 4000);
  assert.ok(h.calls.every(path => path === '/api/stats'), 'polling never reads the persistent token ledger');
});

test('an in-flight request owns the lock and schedules only after it finishes', async () => {
  const h = await harness(), pending = deferred();
  h.startPolling();
  h.replies.push(pending.promise);
  await h.tick();
  assert.equal(h.timers.size, 0);
  await h.pollStats();
  assert.equal(h.calls.length, 1);
  pending.resolve({ stats: { requests: 12 }, configRevision: 1 });
  await new Promise(setImmediate);
  assert.equal(h.app.pollStatsInFlight, false);
  assert.equal(h.delay, 4000);
});

test('starting a polling lifecycle preserves an existing server cooldown', async () => {
  const h = await harness();
  h.app.adminRetryAt = 150000;
  h.startPolling();
  assert.equal(h.delay, 50000);
  await h.visibility(true); await h.visibility(false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.delay, 50000);
  await h.tick();
  assert.equal(h.calls.length, 1);
});

test('hidden pages cancel timers, visible pages refresh immediately, and Retry-After remains authoritative', async () => {
  const h = await harness();
  h.startPolling();
  await h.visibility(true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.document.body.dataset.pageHidden, 'true');
  await h.visibility(false);
  assert.equal(h.calls.length, 1);
  h.replies.push(Object.assign(new Error('busy'), { status: 429, retryAfter: 60 }));
  await h.tick();
  assert.equal(h.delay, 60000);
  await h.visibility(true);
  await h.visibility(false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.delay, 60000);
  await h.tick();
  assert.equal(h.calls.length, 3);
});

test('old session completions cannot release a new session lock, overwrite its stats or restart stopped polling', async () => {
  const h = await harness(), old = deferred(), current = deferred();
  h.startPolling(); h.replies.push(old.promise); await h.tick();
  h.stopPolling(); h.app.csrf = 'second'; h.startPolling(); h.replies.push(current.promise); await h.tick();
  old.resolve({ stats: { requests: 999 }, configRevision: 1 });
  await new Promise(setImmediate);
  assert.equal(h.app.pollStatsInFlight, true);
  assert.equal(h.app.stats.requests, 10);
  assert.equal(h.timers.size, 0);
  h.stopPolling(); h.app.authenticated = false;
  current.resolve({ stats: { requests: 1000 }, configRevision: 1 });
  await new Promise(setImmediate);
  assert.equal(h.timers.size, 0);
  assert.equal(h.app.stats.requests, 10);
});

test('hiding during a request prevents rescheduling and returning visible refreshes again', async () => {
  const h = await harness(), pending = deferred();
  h.startPolling(); h.replies.push(pending.promise); await h.tick();
  await h.visibility(true); pending.resolve({ stats: { requests: 10 }, configRevision: 1 });
  await new Promise(setImmediate);
  assert.equal(h.timers.size, 0);
  await h.visibility(false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.delay, 16000);
});
