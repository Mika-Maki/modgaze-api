import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin } from '../src/admin.mjs';
import { AdminAuth } from '../src/admin-auth.mjs';
import { ConfigStore } from '../src/admin-store.mjs';
import { createSystemRoutes } from '../src/admin-routes-system.mjs';
import { normalizeRateLimits } from '../src/rate-limit.mjs';

const PASSWORD = 'admin-admission-test-password';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Control only the admission timeout; HTTP/auth timers keep their real semantics.
function refreshClock(t) {
  const pending = new Set();
  const timeout = globalThis.setTimeout, clear = globalThis.clearTimeout;
  let scheduled = 0, unrefs = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (callback.name !== 'refreshRateLimits') return timeout(callback, ms, ...args);
    assert.equal(ms, 5000, 'production default refresh is low frequency');
    const timer = { callback, unref() { unrefs++; } };
    pending.add(timer); scheduled++;
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => {
    if (!pending.delete(timer)) clear(timer);
  });
  return {
    get pending() { return pending.size; },
    get scheduled() { return scheduled; },
    get unrefs() { return unrefs; },
    async tick() {
      assert.equal(pending.size, 1, 'exactly one independent refresh is scheduled');
      const [timer] = pending;
      pending.delete(timer);
      await timer.callback();
    },
  };
}

async function fixture(t, { limits, reload = async () => {}, listen = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amerge-admin-admission-'));
  const configPath = join(dir, 'local.json'), authPath = join(dir, 'auth.json');
  const config = {
    rateLimits: normalizeRateLimits(limits),
    groups: [{ id: 'admission', virtualApiKeys: ['mr-test-admission-key'], upstreamApiKey: 'sk-test-admission-key',
      routes: { chat: { baseURL: 'http://127.0.0.1:1' } }, models: [{ id: 'model' }] }],
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await new AdminAuth(authPath).setPassword(PASSWORD);
  const clock = refreshClock(t);
  const store = new ConfigStore({ configPath, backupDir: join(dir, 'run', 'backups'), reload });
  const read = store.read.bind(store);
  let reads = 0, compiles = 0;
  store.read = async () => {
    reads++;
    const result = await read(); // ConfigStore.read performs validateConfig/compileConfig.
    compiles++;
    return result;
  };
  const readLimits = store.readRateLimits.bind(store);
  store.readRateLimits = async () => { reads++; return readLimits(); };
  const admin = await createAdmin({ configPath, authPath, store, runDir: join(dir, 'run'), projectRoot: join(dir, 'no-service-scripts'), adminPort: 0 });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    admin.closeAllConnections();
    await new Promise(resolve => admin.close(resolve));
  }
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  if (listen) await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
  let cookie = '', csrf = '';
  async function request(path, { method = 'GET', body, authenticated = true } = {}) {
    const response = await fetch('http://127.0.0.1:' + admin.address().port + path, {
      method, headers: { ...(authenticated && cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function login() {
    const result = await request('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(result.status, 200);
    cookie = result.headers.get('set-cookie').split(';')[0]; csrf = result.json.csrfToken;
  }
  return { dir, configPath, config, admin, store, clock, request, login, close, reads: () => reads, compiles: () => compiles };
}

test('401 request bursts never read or compile full configuration', async t => {
  const f = await fixture(t);
  assert.equal(f.reads(), 1);
  const results = await Promise.all(Array.from({ length: 24 }, () => f.request('/api/state', { authenticated: false })));
  assert.ok(results.every(result => result.status === 401));
  assert.equal(f.reads(), 1);
  assert.equal(f.compiles(), 1);
  assert.equal(f.clock.scheduled, 1, 'requests do not arm refreshes');
  await f.clock.tick();
  assert.equal(f.compiles(), 1, 'maintenance reads do not request a full configuration snapshot');
  assert.equal(f.reads(), 2, 'the independent timer still securely reads limits');
  assert.equal(f.clock.unrefs, f.clock.scheduled);
});

test('429 bursts do not compile; settings save updates admission immediately', async t => {
  const f = await fixture(t);
  await f.login();
  assert.equal((await f.request('/api/settings', { method: 'PATCH', body: { rateLimits: { admin: { rpm: 1 } } } })).status, 200);
  const reads = f.reads(), compiles = f.compiles();
  const results = await Promise.all(Array.from({ length: 24 }, () => f.request('/api/settings')));
  assert.ok(results.every(result => result.status === 429));
  assert.equal(f.reads(), reads);
  assert.equal(f.compiles(), compiles);
  assert.equal(f.clock.scheduled, 1, 'save and rejected traffic need no timer tick');
});

test('idle timer recovers local limits, retries invalid files and preserves budgets', async t => {
  const f = await fixture(t, { limits: { admin: { rpm: 1, perIpRpm: 0 } } });
  assert.equal((await f.request('/api/auth/status')).status, 200);
  assert.equal((await f.request('/api/auth/status')).status, 429);
  await writeFile(f.configPath, '{broken JSON');
  await f.clock.tick();
  assert.equal((await f.request('/api/auth/status')).status, 429, 'invalid JSON retains good limits');
  f.config.rateLimits.admin.rpm = -1;
  await writeFile(f.configPath, JSON.stringify(f.config));
  await f.clock.tick();
  assert.equal((await f.request('/api/auth/status')).status, 429, 'invalid limits retain good limits');
  f.config.rateLimits.admin.rpm = 100;
  await writeFile(f.configPath, JSON.stringify(f.config));
  await f.clock.tick(); // No incoming request is needed for recovery.
  assert.equal((await f.request('/api/auth/status')).status, 200);
  f.config.rateLimits.admin.rpm = 1;
  await writeFile(f.configPath, JSON.stringify(f.config));
  await f.clock.tick();
  assert.equal((await f.request('/api/auth/status')).status, 429, 'lowering limits retains old request counts');
});

test('refreshes do not overlap and stale reads cannot overwrite a newer reload', async t => {
  const f = await fixture(t);
  await f.login();
  const entered = deferred(), finish = deferred();
  const read = f.store.readRateLimits;
  f.store.readRateLimits = async () => { const limits = await read(); entered.resolve(); await finish.promise; return limits; };
  const pending = f.clock.tick();
  await entered.promise;
  try {
    assert.equal(f.clock.pending, 0, 'no next timer until current read settles');
    await f.store.reload({ rateLimits: normalizeRateLimits({ admin: { rpm: 1 } }) });
    assert.equal((await f.request('/api/auth/status')).status, 429);
  } finally { finish.resolve(); await pending; }
  assert.equal(f.clock.pending, 1);
  assert.equal((await f.request('/api/auth/status')).status, 429, 'late stale snapshot is discarded');
});

test('refresh serializes with saves and never applies a failed uncommitted change', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { reload: async resolved => {
    if (resolved.rateLimits.admin.rpm === 1) { entered.resolve(); await finish.promise; throw new Error('simulated reload failure'); }
  } });
  await f.login();
  const save = f.request('/api/settings', { method: 'PATCH', body: { rateLimits: { admin: { rpm: 1 } } } });
  await entered.promise;
  const reads = f.reads();
  const pending = f.clock.tick();
  try {
    assert.equal((await f.request('/api/auth/status')).status, 200, 'uncommitted limit is not active');
    assert.equal(f.reads(), reads, 'refresh waits on the store transaction queue');
  } finally { finish.resolve(); }
  assert.equal((await save).status, 500);
  await pending;
  assert.equal((await f.request('/api/auth/status')).status, 200);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).rateLimits.admin.rpm, 600);
});

test('close clears scheduled refresh and late in-flight completion cannot rearm it', async t => {
  const f = await fixture(t);
  const entered = deferred(), finish = deferred();
  const read = f.store.readRateLimits;
  f.store.readRateLimits = async () => { const limits = await read(); entered.resolve(); await finish.promise; return limits; };
  const pending = f.clock.tick();
  await entered.promise;
  await f.close();
  const reads = f.reads(), scheduled = f.clock.scheduled;
  finish.resolve(); await pending;
  assert.equal(f.clock.pending, 0);
  assert.equal(f.clock.scheduled, scheduled);
  assert.equal(f.reads(), reads);
});

test('close cancels a refresh waiting behind a store transaction', async t => {
  const f = await fixture(t);
  const entered = deferred(), finish = deferred();
  const transaction = f.store.enqueue(async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  const reads = f.reads();
  const pending = f.clock.tick();
  await f.close();
  finish.resolve();
  await transaction; await pending;
  assert.equal(f.reads(), reads, 'queued refresh checks close before starting IO');
  assert.equal(f.clock.pending, 0);
});

test('closing an unlistened admin clears its unref timer', async t => {
  const f = await fixture(t, { listen: false });
  assert.equal(f.clock.pending, 1);
  assert.equal(f.clock.unrefs, 1);
  await f.close();
  assert.equal(f.clock.pending, 0);
});

test('a secondary listener shares cache without owning its timer lifecycle', async t => {
  const f = await fixture(t);
  // TLS listeners use these same request callbacks; closing one must not close admin.
  const secondary = http.createServer();
  for (const listener of f.admin.listeners('request')) secondary.on('request', listener);
  await new Promise(resolve => secondary.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => secondary.close(resolve));
  assert.equal(f.clock.pending, 1);
  await f.clock.tick();
  assert.equal(f.compiles(), 1);
  assert.equal((await f.request('/api/auth/status')).status, 200);
});

test('audit is injected and unmanaged restart returns 409 without spawning services', async t => {
  const f = await fixture(t);
  await f.login();
  const audit = await f.request('/api/audit');
  assert.equal(audit.status, 200);
  assert.ok(audit.json.audit.some(event => event.action === 'auth.login'));
  const restart = await f.request('/api/service/restart', { method: 'POST', body: {} });
  assert.equal(restart.status, 409);
  assert.match(restart.json.error.message, /service.mjs/);
  assert.equal((await f.request('/api/auth/status')).status, 200);
});

test('system handled successes explicitly return true instead of falling through', async t => {
  const f = await fixture(t);
  const system = createSystemRoutes({
    store: f.store, audit: [], metrics: { snapshot: () => ({ recent: [] }) },
    requestAudit: { snapshot: () => ({}) }, statePayload: async () => ({ ok: true }),
    runtimeInfo: () => ({}), currentAdminPort: () => 8788,
    incomingConfig: value => value, configWarnings: () => [],
  });
  for (const path of ['/api/state', '/api/stats', '/api/audit', '/api/backups', '/api/requests', '/api/request-audit', '/api/settings', '/api/config/import']) {
    const body = path === '/api/config/import' ? { config: f.config, dryRun: true } : undefined;
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? 'GET' : 'POST'; req.headers = { 'content-type': 'application/json' };
    let responses = 0;
    const res = { writeHead(status) { assert.equal(status, 200); }, end() { responses++; } };
    const url = new URL(path, 'http://localhost');
    assert.equal(await system.handle(req, res, url, path.split('/').filter(Boolean)), true, path);
    assert.equal(responses, 1, path);
  }
  assert.equal(await system.handle({ method: 'GET' }, {}, new URL('http://localhost/api/unknown'), ['api', 'unknown']), false);
});
