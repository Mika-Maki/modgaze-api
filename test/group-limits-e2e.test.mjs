import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouter } from '../src/router.mjs';
import { createAdmin } from '../src/admin.mjs';
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return 'http://127.0.0.1:' + server.address().port; }
test('management group limits hot-reload into the router, share keys, isolate groups and support zero unlimited', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-limits-e2e-'));
  const group = (id, keys) => ({ id, virtualApiKeys: keys, upstreamApiKey: 'synthetic-upstream-' + id, routes: { chat: { baseURL: 'http://127.0.0.1:1/v1' } }, models: [{ id: 'synthetic-model', maxOutputTokens: null }] });
  const config = { host: '127.0.0.1', port: 0, groups: [group('a', ['synthetic-a1', 'synthetic-a2']), group('b', ['synthetic-b'])] };
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const router = createRouter(config);
  const admin = await createAdmin({ configPath, runDir: join(dir, 'run'), projectRoot: dir, adminPort: 0, reload: next => router.reload(next) });
  t.after(async () => { for (const server of [router, admin]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const api = await listen(router), management = await listen(admin);
  const setup = await fetch(management + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-test-password-2026' }) });
  assert.equal(setup.status, 200);
  const csrf = (await setup.json()).csrfToken, cookie = setup.headers.get('set-cookie').split(';')[0];
  const patch = rateLimits => fetch(management + '/api/groups/a', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ rateLimits }) });
  const request = key => fetch(api + '/v1/models', { headers: { authorization: 'Bearer ' + key } });
  assert.equal((await patch({ maxConcurrent: 1, rpm: 2 })).status, 200);
  for (const key of ['synthetic-a1', 'synthetic-a2']) { const response = await request(key); assert.equal(response.status, 200); await response.text(); }
  const denied = await request('synthetic-a1');
  assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('retry-after')) > 0);
  assert.equal((await request('synthetic-b')).status, 200);
  const unlimited = await patch({ maxConcurrent: 0, rpm: 0 });
  assert.equal(unlimited.status, 200); assert.deepEqual((await unlimited.json()).group.rateLimits, { maxConcurrent: 0, rpm: 0 });
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => request(i % 2 ? 'synthetic-a1' : 'synthetic-a2')));
  assert.ok(burst.every(response => response.status === 200));
  for (const response of burst) await response.text();
  const state = await fetch(management + '/api/state', { headers: { cookie } });
  assert.deepEqual((await state.json()).groups.find(g => g.id === 'a').rateLimits, { maxConcurrent: 0, rpm: 0 });
});
