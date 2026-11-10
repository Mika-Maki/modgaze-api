import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin } from '../src/admin.mjs';
import { AdminAuth } from '../src/admin-auth.mjs';
import { friendlyError } from '../src/admin-store.mjs';
import { normalizeRateLimits } from '../src/rate-limit.mjs';
import { createTLSListener, loadTLS } from '../src/tls.mjs';

const PASSWORD = 'admin-security-test-password';
const SECRET = 'sk-security-provider-secret-123456';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { limits, optionLimits, configure, publicDir, reload } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amerge-admin-security-'));
  const configPath = join(dir, 'local.json');
  const authPath = join(dir, 'auth.json');
  const config = { rateLimits: normalizeRateLimits(limits), groups: [{ id: 'security', virtualApiKeys: ['mr-security-client'], upstreamApiKey: SECRET, routes: { chat: { baseURL: 'http://127.0.0.1:1' } }, models: [{ id: 'model' }] }] };
  if (configure) configure(config);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await new AdminAuth(authPath).setPassword(PASSWORD);
  let refreshLimits;
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (callback.name === 'refreshRateLimits') {
      refreshLimits = callback;
      return { unref() {} };
    }
    return originalTimeout(callback, ms, ...args);
  });
  const admin = await createAdmin({ configPath, authPath, adminPort: 0, runDir: join(dir, 'run'), ...(publicDir ? { publicDir } : {}), ...(optionLimits ? { rateLimits: optionLimits } : {}), reload });
  await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
  const listeners = [admin];
  t.after(async () => {
    for (const server of listeners.reverse()) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    await rm(dir, { recursive: true, force: true });
  });
  let cookie = '', csrf = '';
  const request = (path, { method = 'GET', body, headers = {}, peer = '127.0.0.1', listener = admin, tls = false } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = (tls ? https : http).request({ hostname: '127.0.0.1', port: listener.address().port, localAddress: peer, path, method, agent: false, ...(tls ? { rejectUnauthorized: false } : {}), headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
      res.on('error', reject);
    });
    client.on('error', reject); client.end(payload);
  });
  async function login(peer = '127.0.0.1') {
    const result = await request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, peer });
    assert.equal(result.status, 200, result.text);
    cookie = result.headers['set-cookie'][0].split(';')[0]; csrf = result.json.csrfToken;
    return result;
  }
  return { dir, configPath, authPath, config, admin, listeners, request, login, refreshLimits: () => refreshLimits() };
}

function assertLimited(response) {
  assert.equal(response.status, 429, response.text);
  assert.match(response.headers['retry-after'], /^[1-9][0-9]*$/);
  assert.equal(response.json.error.type, 'rate_limit_error');
}

test('failed logins and login RPM are scoped to socket peer, not spoofed XFF', async t => {
  const f = await fixture(t, { limits: { admin: { loginRpm: 2 } } });
  for (let i = 0; i < 2; i++) assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { password: 'incorrect-password' }, peer: '127.0.0.2', headers: { 'x-forwarded-for': '203.0.113.' + i } })).status, 401);
  assertLimited(await f.request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, peer: '127.0.0.2', headers: { 'x-forwarded-for': '127.0.0.3' } }));
  await f.login('127.0.0.3');
  assertLimited(await f.request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, peer: '127.0.0.2' }));
});

test('global login slot is reserved before asynchronous KDF and denied attempts consume no peer RPM', async t => {
  const f = await fixture(t, { limits: { admin: { loginMaxConcurrent: 1, loginRpm: 1 } } });
  const entered = deferred(), finish = deferred(); let calls = 0;
  t.mock.method(AdminAuth.prototype, 'verify', async () => { calls++; if (calls === 1) { entered.resolve(); await finish.promise; return false; } return true; });
  const pending = f.request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, peer: '127.0.0.2' });
  await entered.promise;
  try { assertLimited(await f.request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, peer: '127.0.0.3' })); assert.equal(calls, 1); }
  finally { finish.resolve(); }
  assert.equal((await pending).status, 401);
  await f.login('127.0.0.3');
  assert.equal(calls, 2);
});

test('zero login budgets impose no hidden failure lock or concurrency cap', async t => {
  const f = await fixture(t, { limits: { admin: { maxConcurrent: 0, rpm: 0, perIpMaxConcurrent: 0, perIpRpm: 0, loginMaxConcurrent: 0, loginRpm: 0 } } });
  let calls = 0;
  t.mock.method(AdminAuth.prototype, 'verify', async password => { calls++; await new Promise(resolve => setImmediate(resolve)); return password === PASSWORD; });
  const failed = await Promise.all(Array.from({ length: 12 }, () => f.request('/api/auth/login', { method: 'POST', body: { password: 'incorrect-password' } })));
  assert.ok(failed.every(result => result.status === 401));
  await f.login(); assert.equal(calls, 13);
});

test('default admin budgets accept a thirty-request static first-paint burst', async t => {
  const f = await fixture(t);
  const assets = ['/', '/assets/app.js', '/assets/js/core.js', '/assets/js/auth.js', '/assets/js/router.js', '/assets/js/data.js', '/assets/js/forms.js', '/assets/js/dialogs.js', '/assets/js/views/groups.js', '/assets/js/views/system.js'];
  const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => f.request(assets[index % assets.length])));
  for (let index = 0; index < responses.length; index++) assert.equal(responses[index].status, 200, assets[index % assets.length] + ': ' + responses[index].text.slice(0, 100));
});

test('admin static and API share per-peer RPM while healthz is exempt', async t => {
  const f = await fixture(t, { limits: { admin: { rpm: 0, perIpRpm: 2 } } });
  assert.equal((await f.request('/assets/app.js', { peer: '127.0.0.2' })).status, 200);
  assert.equal((await f.request('/api/auth/status', { peer: '127.0.0.2' })).status, 200);
  assertLimited(await f.request('/', { peer: '127.0.0.2', headers: { 'x-forwarded-for': '127.0.0.3' } }));
  assert.equal((await f.request('/healthz', { peer: '127.0.0.2' })).status, 200);
  assert.equal((await f.request('/', { peer: '127.0.0.3' })).status, 200);
});

test('request concurrent slots release on abort and finish without double release', async t => {
  const f = await fixture(t, { limits: { admin: { maxConcurrent: 1, perIpMaxConcurrent: 1, rpm: 0, perIpRpm: 0 } } });
  const entered = deferred(), finish = deferred();
  const original = AdminAuth.prototype.status;
  let hold = true;
  t.mock.method(AdminAuth.prototype, 'status', async function () { if (hold) { entered.resolve(); await finish.promise; } return await original.call(this); });
  let serverSocket;
  f.admin.once('request', req => { serverSocket = req.socket; });
  const client = http.request({ hostname: '127.0.0.1', port: f.admin.address().port, path: '/api/auth/status', agent: false });
  client.on('error', () => {}); client.end();
  await entered.promise;
  assertLimited(await f.request('/', { peer: '127.0.0.2' }));
  const closed = once(serverSocket, 'close'); client.destroy(); await closed;
  hold = false; finish.resolve();
  for (let i = 0; i < 4; i++) assert.equal((await f.request('/api/auth/status')).status, 200);
  const again = deferred(), release = deferred();
  t.mock.method(AdminAuth.prototype, 'status', async function () { again.resolve(); await release.promise; return await original.call(this); });
  const pending = f.request('/api/auth/status'); await again.promise;
  try { assertLimited(await f.request('/', { peer: '127.0.0.2' })); } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
});

test('low settings save succeeds, local edit recovers admission, and counters survive changes', async t => {
  const f = await fixture(t, { limits: { admin: { rpm: 100, perIpRpm: 0 } } });
  await f.login();
  const saved = await f.request('/api/settings', { method: 'PATCH', body: { rateLimits: { admin: { rpm: 1 } } } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.settings.rateLimits.admin.rpm, 1);
  assertLimited(await f.request('/api/settings'));
  const raw = JSON.parse(await readFile(f.configPath, 'utf8'));
  raw.rateLimits.admin.rpm = 100;
  await writeFile(f.configPath, JSON.stringify(raw));
  await f.refreshLimits();
  assert.equal((await f.request('/api/settings')).status, 200);
  raw.rateLimits.admin.rpm = 1;
  await writeFile(f.configPath, JSON.stringify(raw));
  await f.refreshLimits();
  assertLimited(await f.request('/api/settings'));
  raw.rateLimits.admin.rpm = 0;
  await writeFile(f.configPath, JSON.stringify(raw));
  await f.refreshLimits();
  assert.equal((await f.request('/api/settings')).status, 200);
});

test('settings nested merge preserves other limits and rejects invalid saves before disk writes', async t => {
  const f = await fixture(t, { limits: { api: { rpm: 37 }, admin: { perIpRpm: 270 } } });
  await f.login();
  let response = await f.request('/api/settings');
  assert.equal(response.json.settings.maxResponseBytes, 256 * 1024 * 1024);
  response = await f.request('/api/settings', { method: 'PATCH', body: { rateLimits: { admin: { loginRpm: 0 } }, maxResponseBytes: 4096 } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.settings.rateLimits.api.rpm, 37);
  assert.equal(response.json.settings.rateLimits.admin.perIpRpm, 270);
  assert.equal(response.json.settings.rateLimits.admin.loginRpm, 0);
  assert.equal(response.json.settings.maxResponseBytes, 4096);
  const before = await readFile(f.configPath, 'utf8');
  for (const body of [{ rateLimits: null }, { rateLimits: { admin: null } }, { rateLimits: { admin: { bogus: 1 } } }, { rateLimits: { admin: { rpm: -1 } } }, { rateLimits: { admin: { rpm: 1.5 } } }, { maxResponseBytes: 0 }, { maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    response = await f.request('/api/settings', { method: 'PATCH', body });
    assert.equal(response.status, 400, response.text);
    assert.equal(await readFile(f.configPath, 'utf8'), before);
  }
});

test('group creation, partial update, clone and sanitization preserve group budgets', async t => {
  const f = await fixture(t); await f.login();
  let response = await f.request('/api/groups/security', { method: 'PATCH', body: { rateLimits: { maxConcurrent: 2, rpm: 12 } } });
  assert.deepEqual(response.json.group.rateLimits, { maxConcurrent: 2, rpm: 12 });
  response = await f.request('/api/groups/security', { method: 'PATCH', body: { rateLimits: { rpm: 0 } } });
  assert.deepEqual(response.json.group.rateLimits, { maxConcurrent: 2, rpm: 0 });
  response = await f.request('/api/groups/security/clone', { method: 'POST', body: { id: 'copy', rateLimits: { rpm: 7 } } });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json.group.rateLimits, { maxConcurrent: 2, rpm: 7 });
  response = await f.request('/api/groups', { method: 'POST', body: { id: 'created', upstreamApiKey: SECRET, routes: { chat: { baseURL: 'http://127.0.0.1:1' } }, models: ['new-model'], rateLimits: { maxConcurrent: 3 } } });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json.group.rateLimits, { maxConcurrent: 3, rpm: 0 });
  const before = await readFile(f.configPath, 'utf8');
  for (const rateLimits of [null, { rpm: -1 }, { rpm: '1' }, { unknown: 2 }]) assert.equal((await f.request('/api/groups/security', { method: 'PATCH', body: { rateLimits } })).status, 400);
  assert.equal(await readFile(f.configPath, 'utf8'), before);
});

test('non-ASCII CSRF with equal string length returns 403 instead of timingSafeEqual exception', async t => {
  const f = await fixture(t); await f.login();
  const response = await f.request('/api/stats/reset', { method: 'POST', body: {}, headers: { 'x-csrf-token': 'é'.repeat(64) } });
  assert.equal(response.status, 403, response.text);
  assert.equal(response.json.error.detail, null);
});

test('static realpaths reject external file and directory symlinks including fixed aliases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'amerge-static-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pub = join(root, 'public'), outside = join(root, 'outside');
  await mkdir(join(pub, 'assets'), { recursive: true }); await mkdir(outside);
  await writeFile(join(outside, 'secret.js'), SECRET);
  await writeFile(join(pub, 'assets', 'ok.js'), 'export const ok = true;');
  for (const name of ['index.html', 'styles.css', 'assets/app.js', 'assets/external.js']) await symlink(join(outside, 'secret.js'), join(pub, name));
  await symlink(outside, join(pub, 'assets', 'external'));
  const f = await fixture(t, { publicDir: pub });
  assert.equal((await f.request('/assets/ok.js')).status, 200);
  for (const path of ['/', '/index.html', '/assets/app.js', '/assets/styles.css', '/assets/external.js', '/assets/external/secret.js']) {
    const response = await f.request(path); assert.equal(response.status, 404, path); assert.ok(!response.text.includes(SECRET));
  }
});

test('group tests redact every resolved environment route credential', async t => {
  const values = ['sk-env-group-route-secret', 'sk-env-model-route-secret', 'sk-other-resolved-route-secret'];
  const names = ['AMERGE_TEST_GROUP_ROUTE', 'AMERGE_TEST_MODEL_ROUTE', 'AMERGE_TEST_OTHER_ROUTE'];
  for (let i = 0; i < names.length; i++) { const previous = process.env[names[i]]; process.env[names[i]] = values[i]; t.after(() => { if (previous === undefined) delete process.env[names[i]]; else process.env[names[i]] = previous; }); }
  const upstream = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ echoed: values })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const f = await fixture(t, { configure(config) {
    const group = config.groups[0]; group.routes.chat = { baseURL: 'http://127.0.0.1:' + upstream.address().port, upstreamApiKey: { env: names[0] } };
    group.models[0].routes = { chat: { baseURL: group.routes.chat.baseURL, upstreamApiKey: { env: names[1] } } };
    config.groups.push({ id: 'other', virtualApiKeys: ['mr-other-client'], routes: { chat: { baseURL: group.routes.chat.baseURL, upstreamApiKey: { env: names[2] } } }, models: [{ id: 'other-model' }] });
  } });
  await f.login();
  const response = await f.request('/api/groups/security/test', { method: 'POST', body: { mode: 'models', model: 'model', protocol: 'chat' } });
  assert.equal(response.status, 200, response.text);
  for (const value of values) assert.ok(!response.text.includes(value), value);
  assert.match(response.text, /REDACTED/);
});

test('management errors never return raw exception secrets, including reload rollback', async t => {
  assert.equal(JSON.stringify(friendlyError(new Error('Invalid API key: ' + SECRET))).includes(SECRET), false);
  assert.equal(JSON.stringify(friendlyError(new Error(SECRET))).includes(SECRET), false);
  const f = await fixture(t, { reload: async () => { throw new Error('upstream response credential: ' + SECRET); } });
  await f.login();
  const before = await readFile(f.configPath, 'utf8');
  const response = await f.request('/api/settings', { method: 'PATCH', body: { accessLog: true } });
  assert.equal(response.status, 500, response.text);
  assert.equal(response.json.error.detail, null);
  assert.ok(!response.text.includes(SECRET));
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), JSON.parse(before));
});

test('initial options stay active until reload, and reload preserves request counters', async t => {
  const f = await fixture(t, { optionLimits: normalizeRateLimits({ admin: { perIpRpm: 2 } }) });
  await f.login();
  assert.equal((await f.request('/api/config/reload', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/settings')).status, 200, 'reload replaces initial option limits with config limits');
  const raw = JSON.parse(await readFile(f.configPath, 'utf8'));
  raw.rateLimits.admin.perIpRpm = 2;
  await writeFile(f.configPath, JSON.stringify(raw));
  await f.refreshLimits();
  assertLimited(await f.request('/api/auth/status'));
});

test('config import and backup restore hot-update limits without resetting live budgets', async t => {
  const f = await fixture(t); await f.login();
  const backup = await f.request('/api/backups', { method: 'POST', body: { label: 'before-limits' } });
  assert.equal(backup.status, 200, backup.text);
  const imported = structuredClone(f.config);
  imported.rateLimits.admin.rpm = 1;
  const response = await f.request('/api/config/import', { method: 'POST', body: { config: imported } });
  assert.equal(response.status, 200, response.text);
  assertLimited(await f.request('/api/auth/status'));
  const raw = JSON.parse(await readFile(f.configPath, 'utf8'));
  raw.rateLimits.admin.rpm = 0;
  raw.rateLimits.admin.perIpRpm = 1;
  await writeFile(f.configPath, JSON.stringify(raw));
  // Run the independent timer without spending any peer's request budget.
  await f.refreshLimits();
  const restored = await f.request('/api/backups/' + encodeURIComponent(backup.json.name) + '/restore', { method: 'POST', body: {}, peer: '127.0.0.2' });
  assert.equal(restored.status, 200, restored.text);
  assert.equal((await f.request('/api/auth/status', { peer: '127.0.0.2' })).status, 200, 'restore reinstates default per-source budget');
  const before = await readFile(f.configPath, 'utf8');
  const invalid = structuredClone(imported); invalid.rateLimits.admin.rpm = -1;
  for (const action of ['validate', 'import']) assert.equal((await f.request('/api/config/' + action, { method: 'POST', body: { config: invalid } })).status, 400);
  assert.equal(await readFile(f.configPath, 'utf8'), before);
});

test('per-peer concurrent admission is independent across real socket sources', async t => {
  const f = await fixture(t, { limits: { admin: { maxConcurrent: 0, perIpMaxConcurrent: 1 } } });
  const entered = deferred(), finish = deferred();
  const original = AdminAuth.prototype.status;
  let first = true;
  t.mock.method(AdminAuth.prototype, 'status', async function () { if (first) { first = false; entered.resolve(); await finish.promise; } return await original.call(this); });
  const pending = f.request('/api/auth/status', { peer: '127.0.0.2' }); await entered.promise;
  try {
    assertLimited(await f.request('/api/auth/status', { peer: '127.0.0.2', headers: { 'x-forwarded-for': '127.0.0.3' } }));
    assert.equal((await f.request('/api/auth/status', { peer: '127.0.0.3' })).status, 200);
  } finally { finish.resolve(); }
  assert.equal((await pending).status, 200);
});

test('client abort does not free a login slot while asynchronous KDF still runs', async t => {
  const f = await fixture(t, { limits: { admin: { loginMaxConcurrent: 1 } } });
  const entered = deferred(), finish = deferred();
  t.mock.method(AdminAuth.prototype, 'verify', async () => { entered.resolve(); await finish.promise; return false; });
  let serverSocket;
  f.admin.once('request', req => { serverSocket = req.socket; });
  const client = http.request({ hostname: '127.0.0.1', port: f.admin.address().port, path: '/api/auth/login', method: 'POST', agent: false, headers: { 'content-type': 'application/json' } });
  client.on('error', () => {}); client.end(JSON.stringify({ password: PASSWORD })); await entered.promise;
  const closed = once(serverSocket, 'close'); client.destroy(); await closed;
  try { assertLimited(await f.request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, peer: '127.0.0.2' })); }
  finally { finish.resolve(); }
});

test('HTTP and HTTPS share admin RPM and login peer budgets', async t => {
  const f = await fixture(t, { limits: { admin: { rpm: 5, perIpRpm: 0, loginRpm: 1 } } });
  const keyFile = join(f.dir, 'server.key'), certFile = join(f.dir, 'server.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost'], { stdio: 'ignore' });
  await chmod(keyFile, 0o600);
  const tls = await loadTLS({ port: 0, keyFile, certFile }, f.configPath);
  const secure = createTLSListener(f.admin, tls); f.listeners.push(secure);
  await new Promise(resolve => secure.listen(0, '127.0.0.1', resolve));
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { password: 'wrong-password' } })).status, 401);
  assertLimited(await f.request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, listener: secure, tls: true }));
  assert.equal((await f.request('/', { listener: secure, tls: true })).status, 200);
  assert.equal((await f.request('/api/auth/status')).status, 200);
  assert.equal((await f.request('/assets/app.js', { listener: secure, tls: true })).status, 200);
  assertLimited(await f.request('/'));
  assert.equal((await f.request('/healthz', { listener: secure, tls: true })).status, 200);
});
