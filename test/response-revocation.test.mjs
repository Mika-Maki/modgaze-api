import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from '../src/router.mjs';
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; }
test('removing a model revokes both lifecycle and previous_response_id authority', async t => {
  let calls = 0;
  const upstream = http.createServer((req, res) => { calls++; req.resume(); res.setHeader('content-type', 'application/json'); res.end('{"id":"resp_revoked","object":"response"}'); });
  const origin = await listen(upstream);
  const config = { groups: [{ id: 'scope', virtualApiKeys: ['synthetic-client'], upstreamApiKey: 'synthetic-upstream', routes: { responses: { baseURL: origin + '/v1' } }, models: [{ id: 'old-model' }, { id: 'remaining-model' }] }] };
  const router = createRouter(config), base = await listen(router);
  t.after(async () => { for (const server of [router, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const headers = { authorization: 'Bearer synthetic-client', 'content-type': 'application/json' };
  const created = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'old-model', input: 'synthetic' }) });
  assert.equal(created.status, 200); await created.text();
  config.groups[0].models = [{ id: 'remaining-model' }]; router.reload(config);
  assert.equal((await fetch(base + '/v1/responses/resp_revoked', { headers })).status, 404);
  const reference = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'remaining-model', previous_response_id: 'resp_revoked', input: 'synthetic' }) });
  assert.equal(reference.status, 404); assert.equal(calls, 1);
});
