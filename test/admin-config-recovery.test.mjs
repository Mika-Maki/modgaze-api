import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/admin-store.mjs';
import { createAdmin } from '../src/admin.mjs';

async function fixture(t, reload = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mr-config-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'local.json'), backupDir = join(dir, 'backups');
  const config = { host: '127.0.0.1', port: 8787, groups: [{ id: 'g', apiKeys: ['synthetic-recovery-key'],
    routes: { chat: { baseURL: 'http://127.0.0.1:1/v1' } }, models: [{ id: 'original' }] }] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const store = new ConfigStore({ configPath, backupDir, reload });
  await store.read();
  return { dir, configPath, backupDir, config, store };
}

for (const corruption of ['{ invalid JSON', '{"groups":[]}']) {
  for (const operation of ['import', 'restore']) {
    test(operation + ' repairs invalid current configuration and backs up original bytes: ' + corruption, async t => {
      const applied = [];
      const f = await fixture(t, async next => applied.push(next));
      const backup = await f.store.createBackup('good');
      await writeFile(f.configPath, corruption);
      const result = operation === 'restore' ? await f.store.restoreBackup(backup) : await f.store.replace(f.config);
      assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), f.config);
      assert.equal(await readFile(join(f.backupDir, result.backup), 'utf8'), corruption);
      assert.equal((await stat(join(f.backupDir, result.backup))).mode & 0o777, 0o600);
      assert.equal(f.store.revision, 1);
      assert.equal(applied.length, 1);
      assert.equal(applied[0].groups[0].models[0].id, 'original');
    });
  }
}

test('failed recovery restores exact corrupt bytes and last applied runtime without advancing revision', async t => {
  let runtime, fail = false;
  const f = await fixture(t, async next => { runtime = structuredClone(next); if (fail) { fail = false; throw new Error('synthetic failure'); } });
  await f.store.reloadCurrent();
  const oldRuntime = structuredClone(runtime), revision = f.store.revision;
  const broken = Buffer.from([0x7b, 0xff, 0x00, 0x0a]);
  await writeFile(f.configPath, broken);
  const next = structuredClone(f.config); next.groups[0].models[0].id = 'replacement';
  fail = true;
  await assert.rejects(f.store.replace(next), /回滚/);
  assert.deepEqual(await readFile(f.configPath), broken);
  assert.deepEqual(runtime, oldRuntime);
  assert.equal(f.store.revision, revision);
  await f.store.replace(next);
  assert.equal(runtime.groups[0].models[0].id, 'replacement');
});

test('recovery still rejects invalid replacement, insecure permissions, symlinks and backup failures', async t => {
  const f = await fixture(t);
  await writeFile(f.configPath, '{ broken');
  await assert.rejects(f.store.replace({ groups: [] }));
  assert.equal(await readFile(f.configPath, 'utf8'), '{ broken');
  await chmod(f.configPath, 0o644);
  await assert.rejects(f.store.replace(f.config), /0600/);
  await chmod(f.configPath, 0o600);
  const blocker = join(f.dir, 'not-a-directory');
  await writeFile(blocker, 'blocked');
  f.store.backupDir = blocker;
  await assert.rejects(f.store.replace(f.config), /备份/);
  assert.equal(await readFile(f.configPath, 'utf8'), '{ broken');
  f.store.backupDir = f.backupDir;
  const target = join(f.dir, 'outside.json');
  await writeFile(target, '{ outside', { mode: 0o600 });
  await rm(f.configPath);
  await symlink(target, f.configPath);
  await assert.rejects(f.store.replace(f.config), error => error.code === 'ELOOP');
  assert.equal(await readFile(target, 'utf8'), '{ outside');
  assert.equal(f.store.revision, 0);
});

test('failed update/import restores the applied runtime rather than an unapplied valid disk edit', async t => {
  for (const operation of ['update', 'replace']) {
    let runtime, fail = false;
    const f = await fixture(t, async next => { runtime = structuredClone(next); if (fail) { fail = false; throw new Error('synthetic failure'); } });
    await f.store.reloadCurrent();
    const applied = structuredClone(runtime), revision = f.store.revision;
    const external = structuredClone(f.config); external.groups[0].models[0].id = 'unapplied-external';
    await writeFile(f.configPath, JSON.stringify(external));
    const replacement = structuredClone(external); replacement.groups[0].models[0].id = 'failed-edit';
    fail = true;
    await assert.rejects(operation === 'replace' ? f.store.replace(replacement) : f.store.update(raw => { raw.groups[0].models[0].id = 'failed-edit'; }), /回滚/);
    assert.deepEqual(runtime, applied, operation);
    assert.deepEqual(f.store.lastApplied.resolved, applied);
    assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), external);
    assert.equal(f.store.revision, revision);
  }
});

test('authenticated import and backup restore recover bad disk config through the HTTP API', async t => {
  const f = await fixture(t);
  const backup = await f.store.createBackup('good');
  const admin = await createAdmin({ store: f.store, configPath: f.configPath, runDir: f.dir, projectRoot: f.dir, adminPort: 0, routerPort: () => 8787 });
  await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
  t.after(async () => { admin.closeAllConnections(); await new Promise(resolve => admin.close(resolve)); });
  const base = 'http://127.0.0.1:' + admin.address().port;
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-recovery-password' }) });
  assert.equal(setup.status, 200);
  const headers = { cookie: setup.headers.get('set-cookie').split(';')[0], 'x-csrf-token': (await setup.json()).csrfToken, 'content-type': 'application/json' };
  for (const [path, body] of [['/api/config/import', { config: f.config }], ['/api/backups/' + backup + '/restore', {}]]) {
    await writeFile(f.configPath, '{ bad');
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(await readFile(join(f.backupDir, result.backup), 'utf8'), '{ bad');
    const state = await fetch(base + '/api/state', { headers });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).groups[0].models[0].id, 'original');
  }
});
