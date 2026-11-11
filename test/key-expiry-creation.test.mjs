import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin } from '../src/admin.mjs';
import { createRouter } from '../src/router.mjs';
import { ConfigStore, hashKey } from '../src/admin-store.mjs';

const FUTURE = '2099-01-02T10:00:00+08:00';
const UTC = '2099-01-02T02:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mr-create-expiry-'));
  const path = join(dir, 'config.json');
  const config = { groups: [{ id: 'source', apiKeys: ['synthetic-direct'], upstreamApiKey: 'synthetic-provider',
    routes: { chat: { baseURL: 'http://127.0.0.1:1/v1' } }, models: [{ id: 'model' }] }] };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const router = createRouter(config);
  const store = new ConfigStore({ configPath: path, backupDir: join(dir, 'backups'), reload: next => router.reload(next) });
  const admin = await createAdmin({ store, configPath: path, runDir: dir, projectRoot: dir, adminPort: 0 });
  const servers = [router, admin];
  t.after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); } await rm(dir, { recursive: true, force: true }); });
  for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + admin.address().port;
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-create-expiry-password' }) });
  assert.equal(setup.status, 200);
  const headers = { cookie: setup.headers.get('set-cookie').split(';')[0], 'x-csrf-token': (await setup.json()).csrfToken, 'content-type': 'application/json' };
  return { path, config, store,
    async request(path, body) { const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); return { status: res.status, body: await res.json() }; },
    async auth(key) { const res = await fetch('http://127.0.0.1:' + router.address().port + '/v1/models', { headers: { authorization: 'Bearer ' + key } }); await res.text(); return res.status; },
  };
}

test('creation persists expiry atomically for generated, custom, env and group/clone MR keys', async t => {
  const f = await fixture(t);
  const envName = 'MODGAZE_CREATION_EXPIRY_KEY';
  process.env[envName] = 'mr-synthetic-env-created'; t.after(() => delete process.env[envName]);
  const created = [];
  for (const key of [undefined, 'mr-synthetic-custom-created', { env: envName }]) {
    const revision = f.store.revision;
    const result = await f.request('/api/groups/source/virtual-keys', { key, label: 'timed', expiresAt: FUTURE });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const actual = typeof key === 'object' ? process.env[envName] : result.body.key;
    const metadata = result.body.group.virtualKeys.find(item => item.id === hashKey(actual));
    assert.equal(metadata.expiresAt, UTC);
    assert.equal(f.store.revision, revision + 1, 'key and expiry are committed in one transaction');
    assert.equal(await f.auth(actual), 200);
    created.push(actual);
  }
  const group = await f.request('/api/groups', { ...f.config.groups[0], id: 'created-group', apiKeys: [], expiresAt: FUTURE });
  assert.equal(group.status, 200);
  assert.equal(group.body.group.virtualKeys[0].expiresAt, UTC);
  created.push(group.body.generatedKey);
  const clone = await f.request('/api/groups/source/clone', { id: 'clone', expiresAt: FUTURE });
  assert.equal(clone.status, 200);
  assert.equal(clone.body.group.virtualKeys[0].expiresAt, UTC);
  created.push(clone.body.group.virtualKeys[0].value);
  const unlimited = await f.request('/api/groups/source/virtual-keys', {});
  assert.equal(unlimited.status, 200);
  assert.equal(unlimited.body.group.virtualKeys.at(-1).expiresAt, null);
  const raw = JSON.parse(await readFile(f.path, 'utf8'));
  for (const key of created) assert.ok(raw.groups.some(group => group.virtualKeyMeta?.[hashKey(key)]?.expiresAt === UTC));
  assert.ok(raw.groups[0].virtualApiKeys.some(key => key.env === envName), 'env reference is retained');
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse(UTC);
    for (const key of created) assert.equal(await f.auth(key), 401);
    assert.equal(await f.auth(unlimited.body.key), 200);
    assert.equal(await f.auth('synthetic-direct'), 200);
  } finally { Date.now = originalNow; }
  const cleanup = await f.store.removeExpiredMRKeys(Date.parse(UTC));
  assert.equal(cleanup.removed.length, created.length);
  assert.equal(await f.auth(unlimited.body.key), 200);
});

test('creation rejects past/invalid expiry and direct-key expiry without writes', async t => {
  const f = await fixture(t);
  const before = await readFile(f.path, 'utf8');
  for (const expiresAt of ['2000-01-01T00:00:00Z', '2099-01-01T00:00', 'bad', false]) {
    const result = await f.request('/api/groups/source/virtual-keys', { expiresAt });
    assert.equal(result.status, 400);
  }
  for (const [path, body] of [
    ['/api/groups/source/api-keys', { key: 'synthetic-another-direct', expiresAt: null }],
    ['/api/groups', { ...f.config.groups[0], id: 'direct-only', expiresAt: FUTURE }],
    ['/api/groups/source/clone', { id: 'direct-clone', apiKeys: ['synthetic-clone-direct'], expiresAt: FUTURE }],
    ['/api/groups/source/clone', { id: 'invalid-clone', expiresAt: 'bad' }],
  ]) assert.equal((await f.request(path, body)).status, 400);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal(f.store.revision, 0);
  assert.deepEqual(await f.store.listBackups(), []);
});

test('expiry is checked when queued creation executes, not before it waits', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  t.after(() => gate.resolve());
  const originalNow = Date.now, now = originalNow(), deadline = now + 60000;
  const update = f.store.update.bind(f.store);
  f.store.update = (...args) => { entered.resolve(); return update(...args); };
  const blocked = f.store.enqueue(() => gate.promise);
  const before = await readFile(f.path, 'utf8');
  const request = f.request('/api/groups/source/virtual-keys', { expiresAt: new Date(deadline).toISOString() });
  await entered.promise;
  try {
    Date.now = () => deadline;
    gate.resolve(); await blocked;
    const result = await request;
    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /晚于当前时间/);
    assert.equal(await readFile(f.path, 'utf8'), before);
    assert.equal(f.store.revision, 0);
  } finally { Date.now = originalNow; gate.resolve(); }
});
