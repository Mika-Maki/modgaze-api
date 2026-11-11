import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from '../src/router.mjs';

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}
function configuration(baseURL, extra = {}) {
  return { ...extra, groups: [{ id: 'test', apiKeys: ['test-key'], routes: { responses: { baseURL } }, models: [{ id: 'model' }] }] };
}

test('body upload and upstream response share one total deadline', async t => {
  let hits = 0;
  const baseURL = await serve(t, http.createServer((req, res) => {
    hits++;
    req.resume();
    const timer = setTimeout(() => res.end('{}'), 250);
    res.on('close', () => clearTimeout(timer));
  }));
  const router = await serve(t, createRouter(configuration(baseURL, { requestTimeoutMs: 400, upstreamTimeoutMs: 1000 })));
  const body = JSON.stringify({ model: 'model', input: 'hello' });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(router + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer test-key', 'content-length': Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.flushHeaders();
    request.write(body.slice(0, 4));
    const timer = setTimeout(() => request.end(body.slice(4)), 250);
    request.on('close', () => clearTimeout(timer));
  });
  assert.equal(result, 504);
  assert.equal(hits, 1);
});

test('disabled groups keep config but cannot authenticate', async t => {
  const config = configuration('http://127.0.0.1:1/v1');
  config.groups[0].enabled = false;
  const router = await serve(t, createRouter(config));
  const response = await fetch(router + '/v1/models', { headers: { authorization: 'Bearer test-key' } });
  assert.equal(response.status, 401);
});

test('router reload swaps models for new requests', async t => {
  const config = configuration('http://127.0.0.1:1/v1');
  const server = createRouter(config);
  const router = await serve(t, server);
  let response = await fetch(router + '/v1/models', { headers: { authorization: 'Bearer test-key' } });
  assert.deepEqual((await response.json()).data.map(model => model.id), ['model']);
  const next = structuredClone(config);
  next.groups[0].models.push({ id: 'model-2' });
  server.reload(next);
  response = await fetch(router + '/v1/models', { headers: { authorization: 'Bearer test-key' } });
  assert.deepEqual((await response.json()).data.map(model => model.id), ['model', 'model-2']);
});
