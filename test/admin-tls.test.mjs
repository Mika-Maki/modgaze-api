import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAdmin } from '../src/admin.mjs';
import { AdminAuth } from '../src/admin-auth.mjs';
import { createTLSListener, loadTLS } from '../src/tls.mjs';

test('WebUI TLS serves assets, validates origin, logs in and protects secure sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'modgaze-admin-tls-'));
  const configPath = join(directory, 'local.json');
  const authPath = join(directory, 'auth.private.json');
  const keyFile = join(directory, 'server.key');
  const certFile = join(directory, 'server.crt');
  const password = 'test-admin-tls-password';
  let admin, secure;
  t.after(async () => {
    for (const listener of [secure, admin].filter(Boolean)) {
      listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(configPath, JSON.stringify({ groups: [{ id: 'tls-test', virtualApiKeys: ['mr-test-tls'], upstreamApiKey: 'sk-test-provider', routes: { responses: { baseURL: 'http://127.0.0.1:1' } }, models: [{ id: 'model' }] }] }), { mode: 0o600 });
  await new AdminAuth(authPath).setPassword(password);
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',keyFile,'-out',certFile,'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  await chmod(keyFile, 0o600);
  const ca = await readFile(certFile);
  const tls = await loadTLS({ port: 0, keyFile, certFile }, configPath);
  admin = await createAdmin({ configPath, authPath, runDir: join(directory, 'run'), adminPort: 0, tlsAllowedHosts: ['ui.example'] });
  await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
  secure = createTLSListener(admin, tls);
  await new Promise(resolve => secure.listen(0, '127.0.0.1', resolve));
  const port = secure.address().port;
  const origin = 'https://127.0.0.1:' + port;
  const request = (path, { method = 'GET', headers = {}, body, plain = false } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = (plain ? http : https).request({ hostname: '127.0.0.1', port: plain ? admin.address().port : port, ca, servername: 'localhost', path, method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
      res.on('error', reject);
    });
    client.on('error', reject); client.end(payload);
  });
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/assets/app.js')).status, 200);
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/auth/status', { headers: { host: 'ui.example:' + port, origin: 'https://ui.example:' + port } })).status, 200);
  assert.equal((await request('/api/auth/status', { headers: { host: 'evil.example:' + port } })).status, 403);
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { origin: origin.replace('https:', 'http:') }, body: { password } })).status, 403);
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: { password } })).status, 403);
  const login = await request('/api/auth/login', { method: 'POST', headers: { origin }, body: { password } });
  assert.equal(login.status, 200);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /^mr_admin_session_tls=/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const headers = { cookie, origin };
  const state = await request('/api/state', { headers });
  assert.equal(state.status, 200);
  assert.ok(!state.text.includes('sk-test-provider'));
  assert.equal((await request('/api/state', { plain: true, headers: { cookie: cookie.replace('mr_admin_session_tls=', 'mr_admin_session=') } })).status, 401);
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers, body: {} })).status, 403);
  const logout = await request('/api/auth/logout', { method: 'POST', headers: { ...headers, 'x-csrf-token': login.json.csrfToken }, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0; Secure/);
  assert.equal((await request('/api/state', { headers })).status, 401);
});
