import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createResponseObserver } from '../src/response-scope.mjs';
import { createRouter } from '../src/router.mjs';

for (const newline of ['\n', '\r', '\r\n']) {
  test('SSE ownership handles byte-fragmented ' + JSON.stringify(newline) + ' and multiple events', async () => {
    const ids = [], forwarded = [];
    const observer = createResponseObserver('text/event-stream ; charset=utf-8', id => ids.push(id));
    observer.on('data', chunk => forwarded.push(chunk));
    const bytes = Buffer.from([': comment', 'event: response.created', 'data: {"response":', 'data: {"id":"resp_first","text":"你好"}}', '',
      'data', 'data: {"item":{"id":"foreign"},"response_id":"resp_second"}', '', 'data: [DONE]', '', ''].join(newline));
    for (const byte of bytes) observer.write(Buffer.from([byte]));
    observer.end(); await once(observer, 'end');
    assert.deepEqual(ids, ['resp_first', 'resp_second']);
    assert.deepEqual(Buffer.concat(forwarded), bytes);
  });
}

test('large SSE data lines pass through before EOF and the next CR-only event is observed', async () => {
  const ids = []; let bytes = 0;
  const observer = createResponseObserver('text/event-stream', id => ids.push(id));
  observer.on('data', chunk => { bytes += chunk.length; });
  observer.write('data: {"response":{"text":"');
  for (let i = 0; i < 256; i++) observer.write('x'.repeat(8192));
  assert.ok(bytes >= 2 * 1024 * 1024, 'forward without retaining the full event');
  observer.write('","id":"resp_large"}}\r\revent: response.completed\rdata: {"response":{"id":"resp_next"}}\r\r');
  assert.deepEqual(ids, ['resp_large', 'resp_next']);
  observer.end(); await once(observer, 'end');
});

const cases = [
  ['application/json ; charset=utf-8', '{"id":"resp_owned"}'],
  ['application/problem+json\t; charset=utf-8', '{"id":"resp_owned"}'],
  ...['\n', '\r', '\r\n'].map(nl => ['text/event-stream ; charset=utf-8', ['event: response.created', 'data: {"response":{"id":"resp_owned"}}', '', ''].join(nl)]),
];
for (const [index, [contentType, responseBody]] of cases.entries()) {
  test('same-key lifecycle accepts compatible response format ' + index, async t => {
    const servers = []; let hits = 0;
    t.after(async () => { for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
    const serve = async server => { servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; };
    const upstream = await serve(http.createServer((req, res) => { hits++; req.resume(); res.writeHead(200, { 'content-type': contentType }); res.end(responseBody); }));
    const base = await serve(createRouter({ groups: [{ id: 'g', apiKeys: ['synthetic-owner', 'synthetic-foreign'],
      routes: { responses: { baseURL: upstream } }, models: [{ id: 'm' }] }] }));
    async function request(path, method = 'GET', body, key = 'synthetic-owner') {
      const response = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      await response.text(); return response.status;
    }
    assert.equal(await request('/v1/responses', 'POST', { model: 'm', input: 'hello' }), 200);
    assert.equal(await request('/v1/responses/resp_owned', 'GET', undefined, 'synthetic-foreign'), 404);
    assert.equal(hits, 1, 'foreign key is rejected locally');
    assert.equal(await request('/v1/responses/resp_owned'), 200);
    assert.equal(await request('/v1/responses', 'POST', { model: 'm', previous_response_id: 'resp_owned' }), 200);
    assert.equal(await request('/v1/responses/resp_owned/cancel', 'POST', {}), 200);
    assert.equal(await request('/v1/responses/resp_owned', 'DELETE'), 200);
    assert.equal(await request('/v1/responses/resp_owned'), 404);
    assert.equal(hits, 5);
  });
}
