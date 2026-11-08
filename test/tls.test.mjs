import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRouter } from '../src/router.mjs';
import { createTLSListener, loadTLS } from '../src/tls.mjs';

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
function request(port, ca, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path, ca, ...options }, res => {
      const chunks = [];
      const authorized = res.socket.authorized;
      res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), authorized }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
test('HTTPS verifies certificate, preserves auth, SSE and shared hot reload', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'modgaze-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, 'server.key');
  const cert = join(directory, 'server.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  await chmod(key, 0o600);
  const ca = await readFile(cert);
  const tls = await loadTLS({ port: 0, keyFile: 'server.key', certFile: 'server.crt' }, join(directory, 'config.json'));
  assert.equal(tls.options.minVersion, 'TLSv1.2');
  let upstreamCredential;
  const upstreamPort = await serve(t, http.createServer((req, res) => {
    upstreamCredential = req.headers.authorization;
    req.resume(); res.setHeader('content-type', 'text/event-stream'); res.end('data: {"ok":true}\n\ndata: [DONE]\n\n');
  }));
  const config = { groups: [{ id: 'test', virtualApiKeys: ['tls-client-key'], upstreamApiKey: 'tls-provider-key', routes: { responses: { baseURL: 'http://127.0.0.1:' + upstreamPort } }, models: [{ id: 'test-model' }] }] };
  const router = createRouter(config);
  await serve(t, router);
  const secure = createTLSListener(router, tls);
  const port = await serve(t, secure);
  assert.equal((await request(port, ca, '/healthz')).status, 200);
  await assert.rejects(request(port, undefined, '/healthz'));
  await assert.rejects(request(port, ca, '/healthz', { servername: 'wrong.example' }));
  assert.equal((await request(port, ca, '/v1/models')).status, 401);
  const headers = { authorization: 'Bearer tls-client-key' };
  assert.equal((await request(port, ca, '/v1/models', { headers })).status, 200);
  const stream = await request(port, ca, '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'test-model', input: 'hi', stream: true }) });
  assert.equal(stream.status, 200);
  assert.equal(stream.body, 'data: {"ok":true}\n\ndata: [DONE]\n\n');
  assert.equal(upstreamCredential, 'Bearer tls-provider-key');
  config.groups[0].virtualApiKeys = ['tls-rotated-key'];
  router.reload(config);
  assert.equal((await request(port, ca, '/v1/models', { headers })).status, 401);
  assert.equal((await request(port, ca, '/v1/models', { headers: { authorization: 'Bearer tls-rotated-key' } })).status, 200);
  await chmod(key, 0o644);
  await assert.rejects(loadTLS({ keyFile: key, certFile: cert }, join(directory, 'config.json')), /0600/);
});
test('HTTPS disabled and invalid configuration are explicit', async () => {
  assert.equal(await loadTLS(undefined, '/tmp/config.json'), null);
  assert.equal(await loadTLS(false, '/tmp/config.json'), null);
  assert.equal(await loadTLS({ enabled: false }, '/tmp/config.json'), null);
  await assert.rejects(loadTLS({ port: -1 }, '/tmp/config.json'), /listener/);
  await assert.rejects(loadTLS({}, '/tmp/config.json'), /keyFile/);
});
