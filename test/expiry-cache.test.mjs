import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod, symlink, stat, utimes, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, hashKey } from '../src/admin-store.mjs';
const NOW = Date.parse('2030-01-01T00:00:00Z');
const KEY = 'mr-synthetic-cache-key';
async function fixture(t, edit = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mr-expiry-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  const raw = { groups: [{ id: 'g', apiKeys: ['synthetic-cache-direct'], virtualApiKeys: [KEY], upstreamApiKey: 'synthetic-cache-upstream',
    routes: { chat: { baseURL: 'http://127.0.0.1:1/v1' } }, models: [{ id: 'model' }],
    virtualKeyMeta: { [hashKey(KEY)]: { expiresAt: new Date(NOW + 1000).toISOString() } } }] };
  edit(raw);
  await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
  let reloads = 0;
  const store = new ConfigStore({ configPath: path, backupDir: join(directory, 'backups'), reload: async () => { reloads++; } });
  return { directory, path, raw, store, reloads: () => reloads };
}

test('warm expiry cache preserves detached snapshots and clears at the exact deadline', async t => {
  const f = await fixture(t);
  const result = await f.store.removeExpiredMRKeys(NOW);
  result.before.raw.groups[0].virtualKeyMeta[hashKey(KEY)].expiresAt = null;
  result.before.resolved.groups[0].virtualApiKeys.length = 0;
  assert.equal((await f.store.removeExpiredMRKeys(NOW + 999)).removed.length, 0);
  assert.equal(f.store.revision, 0);
  assert.equal(f.reloads(), 0);
  assert.deepEqual(await f.store.listBackups(), []);
  assert.equal((await f.store.removeExpiredMRKeys(NOW + 1000)).removed.length, 1);
  assert.equal(f.store.revision, 1);
  assert.equal(f.reloads(), 1);
  assert.equal((await f.store.removeExpiredMRKeys(NOW + 1001)).unchanged, true);
});

test('warm expiry cache detects in-place and atomic external edits and rejects unsafe files', async t => {
  const f = await fixture(t);
  await f.store.removeExpiredMRKeys(NOW);
  const info = await stat(f.path);
  const edited = structuredClone(f.raw);
  edited.groups[0].virtualKeyMeta[hashKey(KEY)].expiresAt = new Date(NOW - 1000).toISOString();
  await writeFile(f.path, JSON.stringify(edited));
  await utimes(f.path, info.atime, info.mtime);
  assert.equal((await f.store.removeExpiredMRKeys(NOW)).removed.length, 1, 'same-length edit with restored mtime is detected');
  await f.store.removeExpiredMRKeys(NOW);
  const replacement = join(f.directory, 'replacement.json');
  await writeFile(replacement, JSON.stringify(edited), { mode: 0o600 });
  await rename(replacement, f.path);
  assert.equal((await f.store.removeExpiredMRKeys(NOW)).removed.length, 1);
  await f.store.removeExpiredMRKeys(NOW);
  await chmod(f.path, 0o644);
  await assert.rejects(f.store.removeExpiredMRKeys(NOW), /0600/);
  await chmod(f.path, 0o600);
  const valid = await readFile(f.path);
  await writeFile(f.path, '{ bad');
  await assert.rejects(f.store.removeExpiredMRKeys(NOW), SyntaxError);
  await writeFile(f.path, valid);
  assert.equal((await f.store.removeExpiredMRKeys(NOW)).unchanged, true);
  const outside = join(f.directory, 'outside.json');
  await writeFile(outside, valid, { mode: 0o600 });
  await rm(f.path); await symlink(outside, f.path);
  await assert.rejects(f.store.removeExpiredMRKeys(NOW), { code: 'ELOOP' });
});

test('warm expiry cache observes credential env changes and missing model-route credentials', async t => {
  const names = ['MR_CACHE_CLIENT', 'MR_CACHE_PROVIDER'];
  const previous = names.map(name => process.env[name]);
  process.env[names[0]] = KEY; process.env[names[1]] = 'synthetic-env-upstream';
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  const other = 'mr-synthetic-cache-other';
  const f = await fixture(t, raw => {
    raw.groups[0].virtualApiKeys = [{ env: names[0] }];
    raw.groups[0].virtualKeyMeta[hashKey(other)] = { expiresAt: new Date(NOW - 1).toISOString() };
    raw.groups[0].models[0].routes = { chat: { baseURL: 'http://127.0.0.1:1/v1', upstreamApiKey: { env: names[1] } } };
  });
  await f.store.removeExpiredMRKeys(NOW);
  delete process.env[names[1]];
  await assert.rejects(f.store.removeExpiredMRKeys(NOW), /environment variable/);
  process.env[names[1]] = 'synthetic-env-upstream';
  await f.store.removeExpiredMRKeys(NOW);
  process.env[names[0]] = other;
  const result = await f.store.removeExpiredMRKeys(NOW);
  assert.equal(result.removed[0].keyId, hashKey(other));
});

test('queued renewal invalidates warm expiry cache and failed cleanup retries', async t => {
  const f = await fixture(t);
  await f.store.removeExpiredMRKeys(NOW);
  const renewal = f.store.update(raw => { raw.groups[0].virtualKeyMeta[hashKey(KEY)].expiresAt = new Date(NOW + 2000).toISOString(); });
  const sweep = f.store.removeExpiredMRKeys(NOW + 1000);
  await renewal;
  assert.equal((await sweep).removed.length, 0);
  const before = await readFile(f.path, 'utf8'), revision = f.store.revision;
  const reload = f.store.reload; let fail = true;
  f.store.reload = async next => { if (fail) { fail = false; throw new Error('synthetic reload failure'); } return reload(next); };
  await assert.rejects(f.store.removeExpiredMRKeys(NOW + 2000), /回滚/);
  assert.equal(f.store.revision, revision);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), JSON.parse(before));
  assert.equal((await f.store.removeExpiredMRKeys(NOW + 2000)).removed.length, 1);
});
