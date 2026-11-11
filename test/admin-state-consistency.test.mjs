import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin } from '../src/admin.mjs';
import { AdminAuth } from '../src/admin-auth.mjs';
import { ConfigStore } from '../src/admin-store.mjs';

const PASSWORD = 'synthetic-consistency-password';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { reload = async () => {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amerge-admin-consistency-'));
  const configPath = join(dir, 'config.json'), authPath = join(dir, 'auth.json');
  const config = {
    host: '127.0.0.1', port: 8787,
    groups: [{ id: 'source', name: 'Before',
      virtualApiKeys: ['mr-synthetic-consistency-client'],
      upstreamApiKey: 'sk-synthetic-consistency-upstream',
      routes: { chat: { baseURL: 'http://127.0.0.1:1/v1' } },
      models: [{ id: 'model' }],
    }],
  };
  const releases = [];
  let admin, store;
  t.after(async () => {
    for (const release of releases) release();
    if (admin) {
      admin.closeAllConnections();
      await new Promise(resolve => admin.close(resolve));
    }
    await store?.chain;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await new AdminAuth(authPath).setPassword(PASSWORD);
  store = new ConfigStore({ configPath, backupDir: join(dir, 'run', 'backups'), reload });
  admin = await createAdmin({ configPath, authPath, store, runDir: join(dir, 'run'),
    projectRoot: join(dir, 'project'), adminPort: 0, routerPort: () => 8787,
    rateLimitsRefreshMs: 2147483647,
  });
  await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + admin.address().port;
  let cookie = '', csrf = '';
  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch(base + path, { method,
      headers: { cookie, 'x-csrf-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  const login = await request('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = login.json.csrfToken;
  function latch() {
    const gate = deferred();
    releases.push(gate.resolve);
    return gate;
  }
  return { admin, store, config, request, latch, releaseOnCleanup: release => releases.push(release) };
}

test('an in-flight state keeps the revision of its configuration snapshot', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const entered = f.latch(), finish = f.latch();
  const listBackups = f.store.listBackups.bind(f.store);
  let block = true;
  f.store.listBackups = async () => {
    if (block) { block = false; entered.resolve(); await finish.promise; }
    return listBackups();
  };
  const pending = f.request('/api/state');
  await entered.promise;
  const clone = await f.request('/api/groups/source/clone', { method: 'POST', body: { id: 'copy' } });
  assert.equal(clone.status, 200);
  assert.equal(clone.json.group.id, 'copy');
  finish.resolve();
  const old = await pending;
  assert.equal(old.status, 200);
  assert.deepEqual(old.json.groups.map(group => group.id), ['source']);
  assert.equal(old.json.configRevision, 0, 'later writes must not relabel an old snapshot');
  assert.ok(old.json.stats);
  const fresh = await f.request('/api/state');
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.json.groups.map(group => group.id), ['source', 'copy']);
  assert.equal(fresh.json.configRevision, 1);
});

test('versioned and public configuration reads wait for failed writes to roll back', { timeout: 15000 }, async t => {
  const entered = deferred(), finish = deferred();
  let fail = true;
  const f = await fixture(t, { reload: async () => {
    if (fail) { fail = false; entered.resolve(); await finish.promise; throw new Error('synthetic reload failure'); }
  } });
  f.releaseOnCleanup(finish.resolve);
  const update = f.store.update(raw => {
    raw.port = 9876; raw.groups[0].name = 'Uncommitted'; return true;
  }).then(() => null, error => error);
  await entered.promise;
  const allQueued = f.latch();
  const readVersioned = f.store.readVersioned.bind(f.store);
  let queued = 0, completed = 0;
  f.store.readVersioned = () => {
    if (++queued === 4) allQueued.resolve();
    return readVersioned().then(value => { completed++; return value; });
  };
  const versioned = f.store.readVersioned();
  const settings = f.request('/api/settings');
  const groups = f.request('/api/groups');
  const exported = f.request('/api/config/export');
  await allQueued.promise;
  assert.equal(completed, 0, 'no public read may see configuration awaiting reload');
  finish.resolve();
  const error = await update;
  assert.equal(error.status, 500);
  const [snapshot, settingsResult, groupsResult, exportResult] = await Promise.all([versioned, settings, groups, exported]);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.raw.port, 8787);
  assert.equal(snapshot.raw.groups[0].name, 'Before');
  assert.equal(settingsResult.status, 200);
  assert.equal(settingsResult.json.settings.port, 8787);
  assert.equal(groupsResult.status, 200);
  assert.equal(groupsResult.json.groups[0].name, 'Before');
  assert.equal(exportResult.status, 200);
  assert.equal(exportResult.json.config.port, 8787);
  assert.equal(exportResult.json.config.groups[0].name, 'Before');
});

test('config reload and updates share one queue and advance the revision', { timeout: 15000 }, async t => {
  const entered = deferred(), finish = deferred();
  const events = [];
  let runtimeName = 'Before', first = true;
  const f = await fixture(t, { reload: async resolved => {
    const name = resolved.groups[0].name;
    events.push('reload:' + name);
    if (first) { first = false; entered.resolve(); await finish.promise; }
    runtimeName = name;
    events.push('loaded:' + name);
  } });
  f.releaseOnCleanup(finish.resolve);
  const reload = f.request('/api/config/reload', { method: 'POST', body: {} });
  await entered.promise;
  const update = f.store.update(raw => { events.push('mutate'); raw.groups[0].name = 'After'; return true; });
  finish.resolve();
  assert.equal((await reload).status, 200);
  await update;
  const snapshot = await f.store.readVersioned();
  assert.deepEqual(events, ['reload:Before', 'loaded:Before', 'mutate', 'reload:After', 'loaded:After']);
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.raw.groups[0].name, 'After');
  assert.equal(runtimeName, 'After');
  assert.equal((await f.request('/api/stats')).json.configRevision, 2);
});

test('snapshots and manual backups wait for failed writes to roll back', { timeout: 15000 }, async t => {
  const entered = deferred(), finish = deferred();
  let fail = true;
  const f = await fixture(t, { reload: async () => {
    if (fail) { fail = false; entered.resolve(); await finish.promise; throw new Error('synthetic reload failure'); }
  } });
  f.releaseOnCleanup(finish.resolve);
  const update = f.store.update(raw => { raw.groups[0].name = 'Uncommitted'; return true; }).catch(error => error);
  await entered.promise;
  const snapshot = f.store.snapshot();
  const backup = f.store.createBackup('manual-test');
  finish.resolve();
  assert.equal((await update).status, 500);
  assert.equal((await snapshot).raw.groups[0].name, 'Before');
  assert.equal((await f.store.readBackup(await backup)).raw.groups[0].name, 'Before');
});

test('an error after end preserves the complete response and never destroys buffered output', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const injected = f.latch();
  let response, destroys = 0;
  f.admin.prependOnceListener('request', (req, res) => {
    response = res;
    const end = res.end, destroy = res.destroy;
    res.destroy = function (...args) {
      destroys++;
      return destroy.apply(this, args);
    };
    res.end = function (...args) {
      const result = end.apply(this, args);
      injected.resolve();
      throw new Error('synthetic error after end');
    };
  });
  const result = await f.request('/api/state');
  await injected.promise;
  assert.equal(result.status, 200);
  assert.ok(result.json.stats);
  assert.equal(response.writableEnded, true);
  assert.equal(destroys, 0, 'an ended response must be allowed to flush even when end throws');
});

test('an error after headers but before end destroys the incomplete response', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const destroyed = f.latch();
  let sawPartialResponse = false;
  f.admin.prependOnceListener('request', (req, res) => {
    const writeHead = res.writeHead, destroy = res.destroy;
    res.destroy = function (...args) {
      sawPartialResponse = this.headersSent && !this.writableEnded;
      destroyed.resolve();
      return destroy.apply(this, args);
    };
    res.writeHead = function (...args) {
      writeHead.apply(this, args);
      throw new Error('synthetic error after headers');
    };
  });
  await assert.rejects(f.request('/api/state'));
  await destroyed.promise;
  assert.equal(sawPartialResponse, true);
});
