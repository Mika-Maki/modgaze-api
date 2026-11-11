import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createTokenUsageStore, normalizeTokenLimits } from '../src/token-usage.mjs';

const run = promisify(execFile);
const keyA = createHash('sha256').update('actual-key-a').digest('hex');
const keyB = createHash('sha256').update('actual-key-b').digest('hex');
const moduleURL = new URL('../src/token-usage.mjs', import.meta.url).href;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'modgaze-tokens-'));
  const store = createTokenUsageStore({ directory, ...options });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test('token limits reject invalid values and unknown fields; zero is unlimited', () => {
  assert.deepEqual(normalizeTokenLimits(), { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, dayTokens: 0 });
  assert.equal(normalizeTokenLimits({ dayTokens: 7 }).dayTokens, 7);
  for (const raw of [null, [], { typo: 1 }, { inputTokens: -1 }, { totalTokens: '1' }, { cachedTokens: null }, { dayTokens: 1.5 }, { outputTokens: Infinity }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => normalizeTokenLimits(raw), TypeError);
  }
});

test('request transactions aggregate globally, per key and per local day, and deduplicate', async t => {
  const time = new Date(2026, 10, 11, 12).getTime();
  const { store } = await fixture(t, { now: () => time });
  const record = { requestId: 'request-a', keyId: keyA, group: 'api', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40, totalTokens: 120 } };
  assert.equal((await store.record(record)).recorded, true);
  assert.equal((await store.record(record)).recorded, false);
  await store.record({ requestId: 'request-b', keyId: keyB, usage: { inputTokens: 5, outputTokens: 2 } });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.day, '2026-11-11');
  assert.equal(snapshot.total.totalTokens, 127);
  assert.equal(snapshot.total.inputTokens, 105);
  assert.equal(snapshot.total.outputTokens, 22);
  assert.equal(snapshot.total.cachedTokens, 40);
  assert.equal(snapshot.total.requests, 2);
  assert.deepEqual(snapshot.total, snapshot.today);
  assert.equal((await store.snapshot({ keyId: keyA })).total.totalTokens, 120);
  assert.equal((await store.snapshot({ keyId: keyB })).total.totalTokens, 7);
});

test('partial usage tracks observed components and empty usage creates no record', async t => {
  const { store } = await fixture(t);
  assert.equal((await store.record({ requestId: 'empty', keyId: keyA, usage: {} })).recorded, false);
  await store.record({ requestId: 'input-only', keyId: keyA, usage: { inputTokens: 4 } });
  await store.record({ requestId: 'provider-total', keyId: keyA, usage: { totalTokens: 8 } });
  await store.record({ requestId: 'zero-output', keyId: keyA, usage: { outputTokens: 0 } });
  const { total } = await store.snapshot();
  assert.equal(total.totalTokens, 12);
  assert.equal(total.requests, 3);
  assert.deepEqual(total.observed, { inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 1 });
});

test('queued writes finish before admission checks and multiple instances share disk state', async t => {
  const { directory, store } = await fixture(t);
  const second = createTokenUsageStore({ directory });
  t.after(() => second.close());
  const writes = Array.from({ length: 100 }, (_, i) => (i % 2 ? store : second).record({ requestId: `parallel-${i}`, keyId: keyA, usage: { inputTokens: 1, outputTokens: 2 } }));
  const check = second.check(keyA, { totalTokens: 300 });
  await assert.rejects(check, error => error.status === 429 && error.field === 'totalTokens');
  await Promise.all(writes);
  assert.equal((await store.snapshot()).total.totalTokens, 300);
  assert.equal((await second.snapshot()).total.requests, 100);
});

test('all historical limits reject at the boundary; in-flight completion may exceed a limit', async t => {
  const { store } = await fixture(t);
  await store.check(keyA, { totalTokens: 1 });
  await store.record({ requestId: 'over-limit', keyId: keyA, usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 4 } });
  for (const [field, limit] of [['inputTokens', 10], ['outputTokens', 5], ['cachedTokens', 4], ['totalTokens', 15], ['dayTokens', 15]]) {
    await assert.rejects(store.check(keyA, { [field]: limit }), error => error.status === 429 && error.type === 'token_quota_exceeded' && error.field === field && (field !== 'dayTokens' || error.retryAfter >= 1));
  }
  await store.check(keyA, {});
  await store.check(keyB, { totalTokens: 1 });
});

test('day allowance resets at local midnight while lifetime counters survive', async t => {
  let time = new Date(2026, 10, 11, 23, 59, 59, 500).getTime();
  const { store } = await fixture(t, { now: () => time });
  await store.record({ requestId: 'last-night', keyId: keyA, usage: { totalTokens: 9 } });
  await assert.rejects(store.check(keyA, { dayTokens: 9 }), error => error.retryAfter === 1);
  time = new Date(2026, 10, 12, 0, 0, 0).getTime();
  const next = await store.check(keyA, { dayTokens: 9 });
  assert.equal(next.today.totalTokens, 0);
  assert.equal(next.total.totalTokens, 9);
  assert.equal(next.day, '2026-11-12');
  await store.record({ requestId: 'late-old-day', keyId: keyA, usage: { totalTokens: 3 }, time: new Date(2026, 10, 11, 23).getTime() });
  assert.equal((await store.snapshot()).today.totalTokens, 0);
  assert.equal((await store.snapshot()).total.totalTokens, 12);
});

test('every snapshot queries disk instead of cached balances', async t => {
  const { directory, store } = await fixture(t);
  assert.equal((await store.snapshot()).total.totalTokens, 0);
  const writer = new DatabaseSync(join(directory, 'usage.sqlite'));
  t.after(() => writer.close());
  await store.record({ requestId: 'disk-read', keyId: keyA, usage: { totalTokens: 7 } });
  writer.prepare("UPDATE usage_totals SET total_tokens=13 WHERE identity='' AND period=''").run();
  assert.equal((await store.snapshot()).total.totalTokens, 13);
});

test('restart preserves committed requests, deduplication, and discards crashed transactions', async t => {
  const { directory, store } = await fixture(t);
  const child = `
    import { createTokenUsageStore } from ${JSON.stringify(moduleURL)};
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    const directory = process.argv[1];
    const store = createTokenUsageStore({ directory });
    await store.record({ requestId: 'committed', keyId: ${JSON.stringify(keyA)}, usage: { inputTokens: 20, outputTokens: 3 } });
    const db = new DatabaseSync(join(directory, 'usage.sqlite'));
    db.exec('BEGIN IMMEDIATE');
    db.exec("UPDATE usage_totals SET total_tokens=999");
    process.exit(0);
  `;
  await run(process.execPath, ['--input-type=module', '-e', child, directory]);
  assert.equal((await store.snapshot()).total.totalTokens, 23);
  assert.equal((await store.record({ requestId: 'committed', keyId: keyA, usage: { totalTokens: 23 } })).recorded, false);
  await store.close();
  const reopened = createTokenUsageStore({ directory });
  t.after(() => reopened.close());
  assert.equal((await reopened.snapshot({ keyId: keyA })).total.totalTokens, 23);
});

test('separate processes commit concurrent requests without lost updates', async t => {
  const { directory, store } = await fixture(t);
  await store.snapshot();
  const child = `
    import { createTokenUsageStore } from ${JSON.stringify(moduleURL)};
    const store = createTokenUsageStore({ directory: process.argv[1] });
    for (let i = 0; i < 50; i++) await store.record({ requestId: process.argv[2] + i, keyId: ${JSON.stringify(keyA)}, usage: { inputTokens: 1, outputTokens: 2 } });
    await store.close();
  `;
  await Promise.all(['left-', 'right-'].map(prefix => run(process.execPath, ['--input-type=module', '-e', child, directory, prefix])));
  const { total } = await store.snapshot({ keyId: keyA });
  assert.equal(total.requests, 100);
  assert.equal(total.totalTokens, 300);
});

test('local day and retry interval honor server timezone including daylight saving', async t => {
  const { directory } = await fixture(t);
  const child = `
    import { createTokenUsageStore } from ${JSON.stringify(moduleURL)};
    const store = createTokenUsageStore({ directory: process.argv[1], now: () => new Date('2026-03-08T05:00:00Z').getTime() });
    await store.record({ requestId: 'dst', keyId: ${JSON.stringify(keyA)}, usage: { totalTokens: 1 } });
    try { await store.check(${JSON.stringify(keyA)}, { dayTokens: 1 }); } catch (error) { console.log(JSON.stringify({ retryAfter: error.retryAfter, snapshot: await store.snapshot() })); }
    await store.close();
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', child, directory], { env: { ...process.env, TZ: 'America/New_York' } });
  const result = JSON.parse(stdout);
  assert.equal(result.snapshot.day, '2026-03-08');
  assert.equal(result.snapshot.timeZone, 'America/New_York');
  assert.equal(result.retryAfter, 23 * 3600);
});

test('directory and ledger files are private and contain no raw credentials or prompts', async t => {
  const { directory, store } = await fixture(t);
  await chmod(directory, 0o755);
  await store.record({ requestId: 'sensitive-request-id', keyId: keyA, usage: { inputTokens: 3 }, prompt: 'private-prompt', rawKey: 'actual-key-a' });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  async function checkPrivateTree(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      assert.equal(info.mode & 0o777, 0o700);
      for (const child of await readdir(path)) await checkPrivateTree(join(path, child));
      return;
    }
    assert.ok(info.isFile());
    assert.equal(info.mode & 0o777, 0o600);
    const contents = await readFile(path);
    for (const secret of ['sensitive-request-id', 'actual-key-a', 'private-prompt']) assert.equal(contents.includes(Buffer.from(secret)), false);
  }
  await checkPrivateTree(directory);
});

test('corrupt databases and symlink paths fail closed without resetting data', async t => {
  const { directory, store } = await fixture(t);
  const filename = join(directory, 'usage.sqlite');
  await writeFile(filename, 'corrupt-token-ledger');
  await assert.rejects(store.snapshot(), { status: 503, type: 'token_usage_unavailable' });
  await assert.rejects(store.check(keyA, {}), { status: 503 });
  assert.equal(await readFile(filename, 'utf8'), 'corrupt-token-ledger');
  const target = await mkdtemp(join(tmpdir(), 'modgaze-token-target-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const symlinkPath = join(target, 'ledger-link');
  await symlink(directory, symlinkPath);
  const linked = createTokenUsageStore({ directory: symlinkPath });
  t.after(() => linked.close());
  await assert.rejects(linked.snapshot(), { status: 503 });
  const clean = join(target, 'clean');
  const cleanStore = createTokenUsageStore({ directory: clean });
  t.after(() => cleanStore.close());
  await cleanStore.snapshot();
  await symlink(filename, join(clean, 'usage.sqlite-journal'));
  await assert.rejects(cleanStore.record({ requestId: 'unsafe-journal', keyId: keyA, usage: { totalTokens: 1 } }), { status: 503 });
});

test('integer overflow rolls back the whole request and fails later admission closed', async t => {
  const { directory, store } = await fixture(t);
  await store.record({ requestId: 'max', keyId: keyA, usage: { totalTokens: Number.MAX_SAFE_INTEGER } });
  await assert.rejects(store.record({ requestId: 'overflow', keyId: keyA, usage: { totalTokens: 1 } }), { status: 503 });
  await assert.rejects(store.check(keyA, {}), { status: 503 });
  const db = new DatabaseSync(join(directory, 'usage.sqlite'));
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM measured_requests').get().count, 1);
    assert.equal(db.prepare("SELECT total_tokens FROM usage_totals WHERE identity='' AND period=''").get().total_tokens, Number.MAX_SAFE_INTEGER);
  } finally { db.close(); }
});

test('an unlinked or replaced live database and changed permissions fail closed', async t => {
  for (const change of ['unlink', 'replace', 'file-permissions', 'directory-permissions']) {
    const { directory, store } = await fixture(t);
    await store.record({ requestId: change, keyId: keyA, usage: { totalTokens: 1 } });
    const filename = join(directory, 'usage.sqlite');
    if (change === 'unlink') await rm(filename);
    if (change === 'replace') { await rename(filename, `${filename}.old`); await writeFile(filename, 'replacement', { mode: 0o600 }); }
    if (change === 'file-permissions') await chmod(filename, 0o644);
    if (change === 'directory-permissions') await chmod(directory, 0o755);
    await assert.rejects(store.snapshot(), { status: 503 });
    await assert.rejects(store.check(keyA, {}), { status: 503 });
  }
});

test('last close releases directory failure state while concurrent stores retain it', async t => {
  const { directory, store } = await fixture(t);
  await writeFile(join(directory, 'usage.sqlite'), 'corrupt');
  const second = createTokenUsageStore({ directory });
  await assert.rejects(store.snapshot(), { status: 503 });
  await store.close();
  await assert.rejects(second.snapshot(), { status: 503 });
  await second.close();
  await rm(join(directory, 'usage.sqlite'));
  const reopened = createTokenUsageStore({ directory });
  t.after(() => reopened.close());
  assert.equal((await reopened.snapshot()).total.totalTokens, 0);
});
