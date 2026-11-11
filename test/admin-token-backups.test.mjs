import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin } from '../src/admin.mjs';
import { AdminAuth } from '../src/admin-auth.mjs';
import { createTokenUsageStore } from '../src/token-usage.mjs';

const PASSWORD = 'synthetic-backup-admin-password';
const keyId = createHash('sha256').update('synthetic-backup-client').digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'modgaze-admin-token-backups-'));
  const configPath = join(directory, 'config.json'), authPath = join(directory, 'auth.json');
  const tokenDirectory = join(directory, 'tokens');
  const store = createTokenUsageStore({ directory: tokenDirectory });
  let admin;
  t.after(async () => {
    if (admin) { admin.closeAllConnections(); await new Promise(done => admin.close(done)); }
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(configPath, JSON.stringify({ groups: [{ id: 'backup', apiKeys: ['synthetic-backup-client'], routes: { chat: { baseURL: 'http://127.0.0.1:1' } }, models: [{ id: 'model' }] }] }), { mode: 0o600 });
  await new AdminAuth(authPath).setPassword(PASSWORD);
  await store.record({ requestId: 'before-backup', keyId, usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 2 } });
  admin = await createAdmin({ configPath, authPath, runDir: join(directory, 'run'), adminPort: 0, tokenUsageStore: store, publicOrigin: 'https://web.example' });
  await new Promise(done => admin.listen(0, '127.0.0.1', done));
  const request = (path, { method = 'GET', body, headers = {}, session, peer = '127.0.0.1' } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: admin.address().port, localAddress: peer, path, method, agent: false, headers: {
      ...(session ? { ...session } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks), text = bytes.toString();
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, text, json });
      });
    });
    req.on('error', reject); req.end(payload);
  });
  async function login(headers = {}) {
    const result = await request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, headers });
    assert.equal(result.status, 200, result.text);
    return { cookie: result.headers['set-cookie'][0].split(';')[0], 'x-csrf-token': result.json.csrfToken };
  }
  return { store, tokenDirectory, request, login };
}

test('token backup APIs require a session, creation requires CSRF, and local download preserves bytes', async t => {
  const f = await fixture(t), backup = await f.store.createBackup();
  const path = '/api/token-backups/' + backup.name + '/download';
  for (const [url, options] of [['/api/token-backups', {}], ['/api/token-backups', { method: 'POST', body: {} }], [path, {}]]) {
    assert.equal((await f.request(url, options)).status, 401);
  }
  const session = await f.login(), before = await f.store.listBackups();
  for (const csrf of ['', 'incorrect-csrf']) {
    assert.equal((await f.request('/api/token-backups', { session, method: 'POST', body: {}, headers: { 'x-csrf-token': csrf } })).status, 403);
  }
  assert.deepEqual(await f.store.listBackups(), before);
  const created = await f.request('/api/token-backups', { session, method: 'POST', body: {} });
  assert.equal(created.status, 200, created.text);
  const listed = await f.request('/api/token-backups', { session });
  assert.equal(listed.status, 200, listed.text);
  assert.ok(listed.json.backups.some(item => item.name === created.json.backup.name));
  const download = await f.request(path, { session });
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'application/vnd.sqlite3');
  assert.equal(download.headers['content-length'], String(backup.size));
  assert.equal(download.headers['content-disposition'], 'attachment; filename="' + backup.name + '"');
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(download.bytes, await readFile(join(f.tokenDirectory, 'backups', backup.name)));
  assert.equal((await f.request('/api/auth/logout', { session, method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request(path, { session })).status, 401);
});

test('authenticated proxy and non-console requests cannot download token databases', async t => {
  const f = await fixture(t), backup = await f.store.createBackup(), session = await f.login();
  const path = '/api/token-backups/' + backup.name + '/download';
  for (const headers of [
    { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }, { 'x-real-ip': '127.0.0.1' },
    { 'cf-connecting-ip': '127.0.0.1' }, { 'cf-ray': 'synthetic' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' },
  ]) {
    const response = await f.request(path, { session, headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers['content-disposition'], undefined);
  }
  assert.equal((await f.request(path, { session, peer: '127.0.0.2' })).status, 403);
  const headers = { host: 'web.example', origin: 'https://web.example' };
  const proxySession = await f.login(headers);
  assert.equal((await f.request('/api/token-backups', { session: proxySession, headers })).status, 200);
  const response = await f.request(path, { session: proxySession, headers });
  assert.equal(response.status, 403, response.text);
  assert.match(response.json.error.message, /服务器本机/);
});

test('backup HTTP inputs cannot inject SQL, choose paths or expose unsafe files', async t => {
  const f = await fixture(t), session = await f.login(), before = await f.store.snapshot();
  const backups = await f.store.listBackups();
  for (const body of [{ path: '../outside.sqlite' }, { sql: 'DROP TABLE usage_totals' }, { name: "x'; DROP TABLE measured_requests;--" }, [], null]) {
    const response = await f.request('/api/token-backups', { session, method: 'POST', body });
    assert.equal(response.status, 400, response.text);
  }
  assert.deepEqual(await f.store.listBackups(), backups);
  for (const name of ['../usage.sqlite', '/etc/passwd', '%2e%2e/usage.sqlite', "x'; DROP TABLE usage_totals;--", backups[0].name + '\r\nX-Injected: yes']) {
    const response = await f.request('/api/token-backups/' + encodeURIComponent(name) + '/download', { session });
    assert.equal(response.status, 400, name + ': ' + response.text);
    assert.equal(response.headers['x-injected'], undefined);
    assert.equal(response.headers['content-disposition'], undefined);
  }
  const backup = backups[0], path = join(f.tokenDirectory, 'backups', backup.name);
  await chmod(path, 0o644);
  assert.equal((await f.request('/api/token-backups/' + backup.name + '/download', { session })).status, 400);
  await chmod(path, 0o600);
  assert.deepEqual(await f.store.snapshot(), before);
  assert.equal((await f.store.record({ requestId: 'after-invalid-downloads', keyId, usage: { totalTokens: 1 } })).recorded, true);
  assert.equal((await f.store.snapshot()).total.totalTokens, 11);
});
