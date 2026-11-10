import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin } from '../src/admin.mjs';
import { AdminAuth } from '../src/admin-auth.mjs';

async function fixture(t, configured = true) {
  const directory = await mkdtemp(join(tmpdir(), 'modgaze-admin-proxy-'));
  let admin;
  t.after(async () => {
    if (admin) { admin.closeAllConnections(); await new Promise(resolve => admin.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, 'local.json');
  const authPath = join(directory, 'auth.private.json');
  await writeFile(configPath, JSON.stringify({ groups: [{ id: 'proxy-test', apiKeys: ['test-key'], routes: { responses: { baseURL: 'http://127.0.0.1:1' } }, models: [{ id: 'model' }] }] }), { mode: 0o600 });
  const password = 'proxy-test-password-123';
  if (configured) await new AdminAuth(authPath).setPassword(password);
  admin = await createAdmin({ configPath, authPath, runDir: join(directory, 'run'), adminPort: 0, publicOrigin: 'https://web.example' });
  // Model an untrusted network peer without relying on external interfaces.
  admin.prependListener('request', req => {
    if (req.headers['x-test-remote'] === 'untrusted') Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.5', configurable: true });
  });
  await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
  const port = admin.address().port;
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers: {
      host: 'web.example', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers,
    } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('error', reject);
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.end(payload);
  });
  return { request, password, port };
}

test('explicit public HTTPS origin accepts local proxy without weakening host/origin checks', async t => {
  const { request, password, port } = await fixture(t);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/auth/status')).status, 200);
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/auth/status', { headers: { origin: 'https://web.example' } })).status, 200);
  for (const headers of [
    { host: 'evil.example' },
    { host: 'web.example:443' },
    { origin: 'https://evil.example' },
    { origin: 'http://web.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'x-test-remote': 'untrusted', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' },
    { host: 'evil.example', 'x-forwarded-host': 'web.example', 'x-forwarded-proto': 'https' },
  ]) assert.equal((await request('/api/auth/status', { headers })).status, 403, JSON.stringify(headers));
  assert.equal((await request('/api/auth/status', { headers: { host: '127.0.0.1:' + port, origin: 'https://127.0.0.1:' + port, 'x-forwarded-proto': 'https' } })).status, 403);
  const login = await request('/api/auth/login', { method: 'POST', headers: { origin: 'https://web.example' }, body: { password } });
  assert.equal(login.status, 200, login.text);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /^mr_admin_session_tls=/);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(setCookie.includes('; ' + flag));
  const cookie = setCookie.split(';')[0];
  const headers = { cookie, origin: 'https://web.example' };
  assert.equal((await request('/api/state', { headers })).status, 200);
  assert.equal((await request('/api/state', { headers: { host: '127.0.0.1:' + port, cookie: cookie.replace('mr_admin_session_tls=', 'mr_admin_session=') } })).status, 401);
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers, body: {} })).status, 403);
  const logout = await request('/api/auth/logout', { method: 'POST', headers: { ...headers, 'x-csrf-token': login.json.csrfToken }, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0; Secure/);
  assert.equal((await request('/api/state', { headers })).status, 401);
});

test('public proxy cannot perform localhost-only password setup', async t => {
  const { request, password } = await fixture(t, false);
  const response = await request('/api/auth/setup', { method: 'POST', headers: { origin: 'https://web.example' }, body: { password } });
  assert.equal(response.status, 403);
  assert.match(response.json.error.message, /服务器本机/);
  assert.equal((await request('/api/auth/status')).json.configured, false);
});

test('public origin requires an explicit HTTPS origin, not a wildcard or URL path', async () => {
  for (const publicOrigin of [null, '', '*', 'http://web.example', 'https://user:pass@web.example', 'https://web.example/path', 'https://web.example?x=1', 'https://web.example#fragment']) {
    await assert.rejects(createAdmin({ publicOrigin }), /Invalid adminPublicOrigin/);
  }
});

test('HTTP public document entry redirects to its configured HTTPS origin before modules load', async t => {
  const { request } = await fixture(t);
  for (const path of ['/', '/index.html?next=%2Fgroups']) {
    const response = await request(path, { headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(response.status, 308);
    assert.equal(response.headers.location, 'https://web.example' + path);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal((await request('/', { headers: { 'x-forwarded-proto': 'https' } })).status, 200);
  assert.equal((await request('/')).status, 200, 'a local proxy with no forwarded scheme remains supported');
  const insecureModule = await request('/assets/app.js', { headers: { origin: 'http://web.example', 'x-forwarded-proto': 'http' } });
  assert.equal(insecureModule.status, 403, 'do not weaken HTTPS Origin validation to make HTTP modules work');
  assert.equal((await request('/api/auth/status', { headers: { origin: 'http://web.example', 'x-forwarded-proto': 'http' } })).status, 403);
  assert.equal((await request('/', { headers: { host: 'evil.example', 'x-forwarded-proto': 'http' } })).status, 403);
});
