import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin } from '../src/admin.mjs';
import { createMetrics } from '../src/metrics.mjs';

const CLIENT_KEY = 'mr-client-test-key-123456';
const UPSTREAM_KEY = 'sk-upstream-secret-123456';
const ROTATED_KEY = 'sk-upstream-rotated-654321';

async function setup(t, configure = null) {
  const dir = await mkdtemp(join(tmpdir(), 'mr-admin-test-'));
  const configPath = join(dir, 'local.json');
  const config = {
    host: '127.0.0.1',
    port: 0,
    upstreamTimeoutMs: 120000,
    requestTimeoutMs: 600000,
    groups: [{
      id: 'smoke',
      name: 'Smoke',
      virtualApiKeys: [CLIENT_KEY],
      upstreamApiKey: UPSTREAM_KEY,
      routes: { chat: { baseURL: 'http://127.0.0.1:1/v1', auth: 'bearer' } },
      models: [{ id: 'smoke-model', contextWindow: 128000, maxOutputTokens: 8192 }],
    }],
  };
  if (configure) configure(config);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await chmod(configPath, 0o600);
  let reloads = 0;
  const admin = await createAdmin({
    configPath,
    runDir: join(dir, 'run'),
    projectRoot: join(dir, 'project'),
    authPath: join(dir, 'admin-auth.private.json'),
    adminPort: 0,
    routerPort: () => 0,
    metrics: createMetrics(),
    reload: async () => { reloads += 1; },
  });
  await new Promise((resolve, reject) => {
    admin.once('error', reject);
    admin.listen(0, '127.0.0.1', () => { admin.off('error', reject); resolve(); });
  });
  const base = 'http://127.0.0.1:' + admin.address().port;
  const session = { cookie: '', csrf: '' };
  t.after(async () => {
    admin.closeAllConnections?.();
    await new Promise(resolve => admin.close(resolve));
  });
  async function request(path, { method = 'GET', body, csrf = true, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (session.cookie) requestHeaders.cookie = session.cookie;
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';
    if (csrf && session.csrf) requestHeaders['x-csrf-token'] = session.csrf;
    const response = await fetch(base + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) session.cookie = cookies[0].split(';')[0];
    let json = null;
    try { json = await response.json(); } catch {}
    return { status: response.status, json, headers: response.headers, text: JSON.stringify(json) };
  }
  return { dir, configPath, admin, base, session, request, reloads: () => reloads, config };
}

test('admin UI requires a password setup, rejects unauthenticated API access and protects mutations with CSRF', async t => {
  const f = await setup(t);
  let response = await f.request('/api/auth/status');
  assert.equal(response.status, 200);
  assert.equal(response.json.configured, false);
  assert.equal((await f.request('/api/state')).status, 409);
  response = await f.request('/api/auth/setup', { method: 'POST', body: { password: 'admin-test-password-123' }, csrf: false });
  assert.equal(response.status, 200);
  assert.ok(response.json.csrfToken);
  f.session.csrf = response.json.csrfToken;
  assert.equal((await f.request('/assets/app.js')).status, 200);
  assert.equal((await f.request('/')).status, 200);
  const indexResponse = await fetch(f.base + '/');
  assert.equal(indexResponse.status, 200);
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /Modgaze/);
  assert.match(indexHtml, /\/assets\/abyss\.css/);
  assert.match(indexHtml, /data-theme="dark"/);
  assert.doesNotMatch(indexHtml, /ModelRouter/);
  assert.doesNotMatch(indexHtml, /data-action="theme"/);
  const abyssCss = await fetch(f.base + '/assets/abyss.css');
  assert.equal(abyssCss.status, 200);
  assert.match(abyssCss.headers.get('content-type') || '', /text\/css/i);
  const abyssCssText = await abyssCss.text();
  assert.match(abyssCssText, /\.hub-stage/);
  assert.doesNotMatch(abyssCssText, /data-theme="light"/);
  const eyeScript = await fetch(f.base + '/assets/js/eye.js');
  assert.equal(eyeScript.status, 200);
  assert.match(await eyeScript.text(), /Math\.atan2/);
  const state = await f.request('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.groups.length, 1);
  assert.equal(state.text.includes(UPSTREAM_KEY), false, 'upstream key must never be returned to the UI');
  assert.equal(state.text.includes('sk-upstream'), false);
  assert.equal(state.json.groups[0].upstreamKey.set, true);
  assert.equal(state.json.groups[0].virtualKeys[0].value, CLIENT_KEY);
  const withoutCsrf = await f.request('/api/groups/smoke', { method: 'PATCH', body: { note: 'x' }, csrf: false });
  assert.equal(withoutCsrf.status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: f.admin.address().port, path: '/api/state', headers: { host: 'evil.example:18888', cookie: f.session.cookie } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(wrongHost, 403);
});

test('admin CRUD covers groups, upstream keys, routes, models, virtual keys and api keys', async t => {
  const f = await setup(t);
  const setupResponse = await f.request('/api/auth/setup', { method: 'POST', body: { password: 'admin-test-password-123' }, csrf: false });
  f.session.csrf = setupResponse.json.csrfToken;

  let response = await f.request('/api/groups', { method: 'POST', body: {
    id: 'second', name: 'Second group',
    upstreamApiKey: 'sk-second-upstream',
    routes: { responses: { baseURL: 'https://api.example.com/v1', auth: 'bearer' } },
    models: [{ id: 'second-model' }],
    label: 'Client key',
  } });
  assert.equal(response.status, 200, response.text);
  assert.ok(response.json.generatedKey.startsWith('mr-'));
  assert.equal((await f.request('/api/state')).json.groups.length, 2);

  response = await f.request('/api/groups/second', { method: 'PATCH', body: { name: 'Second renamed', upstreamApiKey: ROTATED_KEY } });
  assert.equal(response.status, 200);
  let raw = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(raw.groups.find(group => group.id === 'second').upstreamApiKey, ROTATED_KEY);
  const state = await f.request('/api/state');
  assert.equal(state.text.includes(ROTATED_KEY), false);

  response = await f.request('/api/groups/second/models', { method: 'POST', body: { model: { id: 'second-model-2', contextWindow: 2000000 } } });
  assert.equal(response.status, 200);
  assert.equal(response.json.group.models.length, 2);
  response = await f.request('/api/groups/second/models/second-model-2', { method: 'PATCH', body: { maxOutputTokens: 384000, input: ['text', 'image'] } });
  assert.equal(response.status, 200);
  assert.equal(response.json.group.models.find(model => model.id === 'second-model-2').contextWindow, 2000000);
  response = await f.request('/api/groups/second/models/second-model-2', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(response.json.group.models.length, 1);
  response = await f.request('/api/groups/second/models/second-model', { method: 'DELETE' });
  assert.equal(response.status, 409, 'the last model cannot be deleted');

  response = await f.request('/api/groups/second/routes/chat', { method: 'PUT', body: { baseURL: 'https://chat.example.com/v1', auth: 'bearer' } });
  assert.equal(response.status, 200);
  assert.equal(response.json.group.routes.chat.baseURL, 'https://chat.example.com/v1');
  response = await f.request('/api/groups/second/routes/messages', { method: 'PUT', body: { baseURL: 'https://messages.example.com', auth: 'x-api-key' } });
  assert.equal(response.status, 200);
  response = await f.request('/api/groups/second/routes/messages', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(response.json.group.routes.messages, undefined);

  response = await f.request('/api/groups/second/virtual-keys', { method: 'POST', body: { key: 'mr-custom-key-123456', label: 'custom' } });
  assert.equal(response.status, 200);
  const customId = response.json.group.virtualKeys.find(key => key.value === 'mr-custom-key-123456').id;
  response = await f.request('/api/groups/second/virtual-keys/' + customId + '/rotate', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.ok(response.json.key.startsWith('mr-'));
  assert.equal(response.json.group.virtualKeys.some(key => key.value === 'mr-custom-key-123456'), false, 'old key is gone');
  const rotatedId = response.json.group.virtualKeys.find(key => key.value === response.json.key).id;
  response = await f.request('/api/groups/second/virtual-keys/' + rotatedId, { method: 'PATCH', body: { label: 'renamed' } });
  assert.equal(response.status, 200);
  assert.equal(response.json.group.virtualKeys.find(key => key.id === rotatedId).label, 'renamed');
  response = await f.request('/api/groups/second/virtual-keys/' + rotatedId, { method: 'DELETE' });
  assert.equal(response.status, 200);

  response = await f.request('/api/groups/second/api-keys', { method: 'POST', body: { key: 'sk-passthrough-client', label: 'legacy' } });
  assert.equal(response.status, 200);
  const apiKey = response.json.group.apiKeys[0];
  assert.equal(apiKey.value, null, 'passthrough keys are never echoed');
  response = await f.request('/api/groups/second/api-keys/' + apiKey.id, { method: 'DELETE' });
  assert.equal(response.status, 200);

  response = await f.request('/api/groups/second/clone', { method: 'POST', body: { id: 'third', name: 'Clone' } });
  assert.equal(response.status, 200);
  assert.equal(response.json.group.id, 'third');
  assert.ok(response.json.group.virtualKeys.length >= 1);
  response = await f.request('/api/groups/third', { method: 'DELETE' });
  assert.equal(response.status, 200);
  response = await f.request('/api/groups/second', { method: 'DELETE' });
  assert.equal(response.status, 200);
  response = await f.request('/api/groups/smoke', { method: 'DELETE' });
  assert.equal(response.status, 409, 'at least one group must remain');

  raw = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.deepEqual(raw.groups.map(group => group.id), ['smoke']);
});

test('admin settings, validation, backups, password rotation and logout work', async t => {
  const f = await setup(t);
  const setupResponse = await f.request('/api/auth/setup', { method: 'POST', body: { password: 'admin-test-password-123' }, csrf: false });
  f.session.csrf = setupResponse.json.csrfToken;

  let response = await f.request('/api/settings', { method: 'PATCH', body: { upstreamTimeoutMs: 130000, accessLog: true } });
  assert.equal(response.status, 200);
  assert.equal(response.json.settings.upstreamTimeoutMs, 130000);
  assert.equal(response.json.settings.accessLog, true);

  const raw = JSON.parse(await readFile(f.configPath, 'utf8'));
  response = await f.request('/api/config/validate', { method: 'POST', body: { config: raw } });
  assert.equal(response.status, 200);
  assert.equal(response.json.summary.groups, 1);
  response = await f.request('/api/config/import', { method: 'POST', body: { config: raw, dryRun: true } });
  assert.equal(response.status, 200);
  assert.equal(response.json.dryRun, true);

  response = await f.request('/api/backups', { method: 'POST', body: { label: 'unit' } });
  assert.equal(response.status, 200);
  assert.ok(response.json.name.startsWith('backup-'));
  const backupName = response.json.name;
  response = await f.request('/api/backups');
  assert.ok(response.json.backups.some(backup => backup.name === backupName));

  response = await f.request('/api/settings', { method: 'PATCH', body: { upstreamTimeoutMs: 140000 } });
  assert.equal(response.status, 200);
  response = await f.request('/api/backups/' + encodeURIComponent(backupName) + '/restore', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  response = await f.request('/api/settings');
  assert.equal(response.json.settings.upstreamTimeoutMs, 130000, 'restore must bring back the backed-up settings');

  response = await f.request('/api/auth/password', { method: 'POST', body: { currentPassword: 'admin-test-password-123', newPassword: 'admin-test-password-456' } });
  assert.equal(response.status, 200);
  assert.ok(response.json.csrfToken);
  f.session.csrf = response.json.csrfToken;
  assert.equal((await f.request('/api/state')).status, 200);

  response = await f.request('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.equal((await f.request('/api/state')).status, 401);
  response = await f.request('/api/auth/login', { method: 'POST', body: { password: 'wrong-password-000' }, csrf: false });
  assert.equal(response.status, 401);
  response = await f.request('/api/auth/login', { method: 'POST', body: { password: 'admin-test-password-456' }, csrf: false });
  assert.equal(response.status, 200);
  f.session.csrf = response.json.csrfToken;
  assert.equal((await f.request('/api/state')).status, 200);
});

test('upstream connectivity uses resolved credentials and never returns them', async t => {
  const calls = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-model' }] }));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => { upstream.off('error', reject); resolve(); });
  });
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const upstreamPort = upstream.address().port;
  process.env.MR_ADMIN_TEST_UPSTREAM = 'sk-env-resolved-secret-123';
  t.after(() => { delete process.env.MR_ADMIN_TEST_UPSTREAM; });
  const f = await setup(t, config => {
    config.groups[0].upstreamApiKey = { env: 'MR_ADMIN_TEST_UPSTREAM' };
    config.groups[0].routes.chat.baseURL = 'http://127.0.0.1:' + upstreamPort + '/v1';
  });
  const setupResponse = await f.request('/api/auth/setup', { method: 'POST', body: { password: 'admin-test-password-123' }, csrf: false });
  f.session.csrf = setupResponse.json.csrfToken;

  let response = await f.request('/api/groups/smoke/test', { method: 'POST', body: { mode: 'models', protocol: 'chat' } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.result.ok, true);
  assert.equal(response.json.result.status, 200);
  assert.equal(calls[0].url, '/v1/models');
  assert.equal(calls[0].authorization, 'Bearer sk-env-resolved-secret-123');

  response = await f.request('/api/groups/smoke/test', { method: 'POST', body: { mode: 'generate', protocol: 'chat', model: 'smoke-model', prompt: 'hello' } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.result.ok, true);
  assert.equal(calls[1].url, '/v1/chat/completions');
  assert.match(calls[1].body, /"model":"smoke-model"/);
  assert.equal(response.text.includes('sk-env-resolved-secret-123'), false, 'test result must be redacted');
  const state = await f.request('/api/state');
  assert.equal(state.text.includes('sk-env-resolved-secret-123'), false);
});
