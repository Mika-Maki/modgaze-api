import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, link, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTokenUsageStore, normalizeTokenLimits } from '../src/token-usage.mjs';

const keyId = createHash('sha256').update('synthetic-backup-client').digest('hex');
async function fixture(t, prefix = 'modgaze-token-backups-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let time = new Date(2026, 10, 11, 12).getTime(), errors = 0;
  const stores = [];
  function open() { const store = createTokenUsageStore({ directory, now: () => time, onBackupError: () => errors++ }); stores.push(store); return store; }
  const store = open();
  t.after(async () => { for (const instance of stores) await instance.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, open, now: () => time, errors: () => errors, advance: days => { time += days * 86400000; } };
}
const record = (store, requestId, tokens = 3) => store.record({ requestId, keyId, usage: { inputTokens: tokens, outputTokens: 2, cachedTokens: 1 } });

test('manual backup includes committed WAL data and restores balances and deduplication', async t => {
  const f = await fixture(t);
  await record(f.store, 'first'); await record(f.store, 'second', 10);
  const backup = await f.store.createBackup();
  assert.ok(backup.name.startsWith('manual-'));
  const source = await f.store.openBackup(backup.name);
  const chunks = []; for await (const chunk of source.stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, backup.size);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  const restoredDirectory = join(f.directory, 'restored'); await mkdir(restoredDirectory, { mode: 0o700 });
  await writeFile(join(restoredDirectory, 'usage.sqlite'), bytes, { mode: 0o600 });
  const restored = createTokenUsageStore({ directory: restoredDirectory });
  try {
    assert.equal((await restored.snapshot()).total.totalTokens, 17);
    assert.equal((await restored.snapshot({ keyId })).total.cachedTokens, 2);
    assert.equal((await record(restored, 'first')).recorded, false);
    await assert.rejects(restored.check(keyId, { totalTokens: 17 }), { status: 429 });
  } finally { await restored.close(); }
});

test('restored snapshot preserves all keys, daily totals and quota boundaries at the backup point', async t => {
  const f = await fixture(t);
  const other = createHash('sha256').update('second-backup-client').digest('hex');
  await record(f.store, 'yesterday');
  f.advance(1);
  // Queue the backup between writes to verify the snapshot's precise boundary.
  const writes = [record(f.store, 'today', 10), f.store.record({ requestId: 'other-key', keyId: other, usage: { totalTokens: 9 } })];
  const pendingBackup = f.store.createBackup();
  const later = record(f.store, 'after-snapshot', 100);
  await Promise.all(writes);
  const backup = await pendingBackup;
  await later;
  const restoredDirectory = join(f.directory, 'restored');
  await mkdir(restoredDirectory, { mode: 0o700 });
  await copyFile(join(f.directory, 'backups', backup.name), join(restoredDirectory, 'usage.sqlite'));
  assert.deepEqual(await readdir(restoredDirectory), ['usage.sqlite'], 'restore requires no WAL or SHM sidecar');
  const restored = createTokenUsageStore({ directory: restoredDirectory, now: f.now });
  try {
    const global = await restored.snapshot(), first = await restored.snapshot({ keyId }), second = await restored.snapshot({ keyId: other });
    assert.equal(global.total.totalTokens, 26);
    assert.equal(global.today.totalTokens, 21);
    assert.equal(global.total.requests, 3);
    assert.equal(global.today.requests, 2);
    assert.equal(first.total.totalTokens, 17);
    assert.equal(first.today.totalTokens, 12);
    assert.equal(first.total.inputTokens, 13);
    assert.equal(first.total.outputTokens, 4);
    assert.equal(first.total.cachedTokens, 2);
    assert.deepEqual(first.total.observed, { inputTokens: 2, outputTokens: 2, cachedTokens: 2, totalTokens: 0 });
    assert.equal(second.total.totalTokens, 9);
    assert.deepEqual(second.total, second.today);
    assert.deepEqual(second.total.observed, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 1 });
    for (const [field, value] of [['totalTokens', 17], ['inputTokens', 13], ['outputTokens', 4], ['cachedTokens', 2], ['dayTokens', 12]]) {
      await assert.rejects(restored.check(keyId, { [field]: value }), { status: 429, field });
      await restored.check(keyId, { [field]: value + 1 });
    }
    assert.equal((await record(restored, 'yesterday')).recorded, false);
    assert.equal((await record(restored, 'today')).recorded, false);
    assert.equal((await restored.record({ requestId: 'other-key', keyId: other, usage: { totalTokens: 9 } })).recorded, false);
    assert.deepEqual(await restored.snapshot(), global);
    assert.equal((await record(restored, 'after-snapshot', 100)).recorded, true);
    for (const options of [{}, { keyId }, { keyId: other }]) assert.deepEqual(await restored.snapshot(options), await f.store.snapshot(options));
    f.advance(1);
    assert.equal((await restored.check(keyId, { dayTokens: 1 })).today.totalTokens, 0);
    assert.equal((await restored.snapshot()).total.totalTokens, 128);
  } finally { await restored.close(); }
});

test('backup destination with SQL metacharacters is bound as a filename', async t => {
  const f = await fixture(t, "modgaze-'; DROP TABLE usage_totals;--");
  await record(f.store, 'quoted-path');
  const backup = await f.store.createBackup();
  const db = new DatabaseSync(join(f.directory, 'backups', backup.name), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM measured_requests').get().count, 1);
    assert.equal(db.prepare('SELECT total_tokens FROM usage_totals WHERE identity=? AND period=?').get(keyId, '').total_tokens, 5);
  } finally { db.close(); }
  assert.equal((await f.store.snapshot()).total.totalTokens, 5);
});

test('automatic backups run once per active local day across restart and retain seven plus ten manual', async t => {
  const f = await fixture(t);
  await record(f.store, 'day-zero');
  await record(f.store, 'same-day');
  assert.equal((await f.store.listBackups()).length, 1);
  await f.store.close();
  const reopened = f.open(); await record(reopened, 'restart-same-day');
  assert.equal((await reopened.listBackups()).length, 1);
  for (let day = 1; day <= 9; day++) { f.advance(1); await record(reopened, 'day-' + day); }
  for (let index = 0; index < 12; index++) await reopened.createBackup();
  const backups = await reopened.listBackups();
  assert.equal(backups.filter(item => item.name.startsWith('auto-')).length, 7);
  assert.equal(backups.filter(item => item.name.startsWith('manual-')).length, 10);
  assert.equal((await stat(join(f.directory, 'backups'))).mode & 0o777, 0o700);
  for (const backup of backups) assert.equal((await stat(join(f.directory, 'backups', backup.name))).mode & 0o777, 0o600);
  assert.ok((await readdir(join(f.directory, 'backups'))).every(name => !name.startsWith('.pending-')));
});

test('failed automatic backups preserve committed usage and retry on the next write', async t => {
  const f = await fixture(t); await f.store.snapshot();
  await writeFile(join(f.directory, 'backups'), 'blocked', { mode: 0o600 });
  assert.equal((await record(f.store, 'while-blocked')).recorded, true);
  assert.equal(f.errors(), 1);
  assert.equal((await f.store.snapshot()).total.totalTokens, 5);
  await assert.rejects(f.store.createBackup());
  await f.store.check(keyId, { totalTokens: 100 });
  await rm(join(f.directory, 'backups'));
  await record(f.store, 'after-repair');
  assert.equal((await f.store.listBackups()).length, 1);
  assert.equal((await f.store.snapshot()).total.totalTokens, 10);
});

test('backup reads reject traversal, symlinks, hardlinks, public permissions and invalid data', async t => {
  const f = await fixture(t); await record(f.store, 'safe');
  const backup = await f.store.createBackup(), path = join(f.directory, 'backups', backup.name);
  for (const name of ['../usage.sqlite', '/etc/passwd', '%2e%2e/usage.sqlite', "x'; DROP TABLE usage_totals;--", backup.name + '\r\nX-Test: yes']) await assert.rejects(f.store.openBackup(name));
  await chmod(path, 0o644); await assert.rejects(f.store.openBackup(backup.name));
  assert.ok(!(await f.store.listBackups()).some(item => item.name === backup.name));
  await chmod(path, 0o600);
  const saved = join(f.directory, 'saved.sqlite'); await copyFile(path, saved);
  await rm(path); await symlink(saved, path); await assert.rejects(f.store.openBackup(backup.name));
  await rm(path); await link(saved, path); await assert.rejects(f.store.openBackup(backup.name));
  await rm(path); await writeFile(path, 'not a database', { mode: 0o600 }); await assert.rejects(f.store.openBackup(backup.name));
  assert.equal((await f.store.snapshot()).total.totalTokens, 5, 'bad downloads cannot poison the live ledger');
});

test('SQL injection strings remain data and cannot alter schema or read another key', async t => {
  const f = await fixture(t);
  const malicious = "x'); DROP TABLE usage_totals; --";
  await record(f.store, malicious);
  assert.equal((await record(f.store, malicious)).recorded, false);
  for (const operation of [() => f.store.snapshot({ keyId: "' OR 1=1 --" }), () => f.store.check(malicious, {}), () => f.store.record({ requestId: 'bad', keyId: malicious, usage: { totalTokens: 99 } })]) await assert.rejects(operation(), TypeError);
  assert.throws(() => normalizeTokenLimits({ [malicious]: 1 }), TypeError);
  const other = createHash('sha256').update('another-client').digest('hex');
  assert.equal((await f.store.snapshot({ keyId: other })).total.totalTokens, 0);
  assert.equal((await f.store.snapshot()).total.totalTokens, 5);
  const db = new DatabaseSync(join(f.directory, 'usage.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM measured_requests').get().count, 1); } finally { db.close(); }
});
