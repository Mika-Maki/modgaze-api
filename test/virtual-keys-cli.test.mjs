import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const ENV = 'MODGAZE_TEST_CLI_UPSTREAM';
const KEY = 'synthetic-cli-provider-key';
async function fixture(t, config) {
  const root = await mkdtemp(join(tmpdir(), 'mr-vkeys-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../src', import.meta.url), join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'config'));
  await cp(new URL('../scripts/virtual-keys.mjs', import.meta.url), join(root, 'scripts/virtual-keys.mjs'));
  const path = join(root, 'config/local.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return { root, path, run: env => run(process.execPath, [join(root, 'scripts/virtual-keys.mjs')], { env: { ...process.env, ...env } }) };
}
const config = () => ({ groups: [{ id: 'cli', apiKeys: [{ env: ENV }],
  routes: { chat: { baseURL: 'http://127.0.0.1:1/v1' } }, models: [{ id: 'model' }] }] });

test('CLI creates virtual keys with env credentials, preserves references, and is idempotent', async t => {
  const f = await fixture(t, config());
  const first = await f.run({ [ENV]: KEY });
  const rawText = await readFile(f.path, 'utf8'), raw = JSON.parse(rawText);
  assert.deepEqual(raw.groups[0].apiKeys, [{ env: ENV }]);
  assert.deepEqual(raw.groups[0].upstreamApiKey, { env: ENV });
  assert.match(raw.groups[0].virtualApiKeys[0], /^mr-[a-f0-9]{64}$/);
  assert.ok(!rawText.includes(KEY));
  assert.ok(!(first.stdout + first.stderr).includes(KEY));
  assert.ok(!(first.stdout + first.stderr).includes(raw.groups[0].virtualApiKeys[0]));
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const exported = JSON.parse(await readFile(join(f.root, 'config/virtual-keys.private.json'), 'utf8'));
  assert.deepEqual(exported[0].virtualApiKeys, raw.groups[0].virtualApiKeys);
  await f.run({ [ENV]: KEY });
  assert.equal(await readFile(f.path, 'utf8'), rawText, 'second run must not rotate existing credentials');
});

test('CLI preserves existing virtual env references and route credentials', async t => {
  const raw = config();
  raw.groups[0].upstreamApiKey = { env: ENV };
  raw.groups[0].virtualApiKeys = [{ env: 'MODGAZE_TEST_CLI_CLIENT' }];
  raw.groups[0].routes.chat.upstreamApiKey = { env: ENV };
  const f = await fixture(t, raw);
  const result = await f.run({ [ENV]: KEY, MODGAZE_TEST_CLI_CLIENT: 'mr-synthetic-env-client' });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), raw);
  const exported = await readFile(join(f.root, 'config/virtual-keys.private.json'), 'utf8');
  assert.ok(exported.includes('MODGAZE_TEST_CLI_CLIENT'));
  assert.ok(!exported.includes('mr-synthetic-env-client'));
  assert.ok(!(result.stdout + result.stderr).includes(KEY));
});

test('CLI missing environment credentials fails before writing any configuration', async t => {
  const f = await fixture(t, config());
  const before = await readFile(f.path);
  await assert.rejects(f.run({ [ENV]: '' }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Virtual key setup failed/);
    return true;
  });
  assert.deepEqual(await readFile(f.path), before);
  await assert.rejects(stat(join(f.root, 'config/virtual-keys.private.json')), { code: 'ENOENT' });
});
