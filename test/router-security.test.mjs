import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { createRouter, compileConfig } from '../src/router.mjs';
import { createResponseScope, createResponseObserver } from '../src/response-scope.mjs';

// Every network target in this file is an ephemeral localhost mock. Fake keys only.
const A = 'security-client-a', B = 'security-client-b', V = 'security-virtual', C = 'security-client-c';
const model = 'security-model';
const check = (name, fn) => test(name, { timeout: 6000 }, fn);
const payload = extra => ({ model, input: 'hello', ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; }
function cleanup(t, server) { t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }); }
function request(origin, path = '/v1/responses', { method = 'POST', key = A, body, headers = {}, allowAbort = false, onData } = {}) {
  const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, origin), { method, agent: false, headers: { authorization: 'Bearer ' + key, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
      const chunks = [];
      let settled = false;
      const done = aborted => { if (settled) return; settled = true; const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, text: bytes.toString(), bytes, aborted }); };
      res.on('data', chunk => { chunks.push(chunk); onData?.(chunk); });
      res.once('end', () => done(false));
      res.once('error', error => { if (allowAbort) done(true); else reject(error); });
    });
    req.setTimeout(4000, () => req.destroy(new Error('mock request timeout')));
    req.once('error', reject);
    req.end(data);
  });
}
async function fixture(t, configure = () => {}, handler = (req, res, call) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: req.method === 'POST' && req.url.endsWith('/responses') ? 'resp_owned' : 'ignored_lifecycle_id', object: 'response' }));
}) {
  const calls = [], logs = [], metrics = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const call = { method: req.method, url: req.url, headers: req.headers, body: body.length ? JSON.parse(body) : undefined };
      calls.push(call); await handler(req, res, call);
    } catch (error) { res.destroy(error); }
  });
  cleanup(t, upstream);
  const upstreamOrigin = await listen(upstream);
  const config = { host: '127.0.0.1', port: 0, requestTimeoutMs: 3000, upstreamTimeoutMs: 2500, groups: [{ id: 'security-a', apiKeys: [A, B], virtualApiKeys: [V], upstreamApiKey: 'security-upstream', routes: { responses: { baseURL: upstreamOrigin + '/v1' }, chat: { baseURL: upstreamOrigin + '/v1' }, messages: { baseURL: upstreamOrigin + '/v1' } }, models: [{ id: model, maxOutputTokens: 100 }] }] };
  configure(config, upstreamOrigin);
  const router = createRouter(config, { logger: event => logs.push(event), onRequest: event => metrics.push(event) });
  cleanup(t, router);
  const origin = await listen(router);
  return { config, calls, logs, metrics, router, origin, upstreamOrigin };
}
function addGroup(config) { config.groups.push({ ...structuredClone(config.groups[0]), id: 'security-c', apiKeys: [C], virtualApiKeys: [], rateLimits: { maxConcurrent: 0, rpm: 0 } }); }

check('Responses lifecycle and previous_response_id require the exact calling key, not just its group', async t => {
  const f = await fixture(t, addGroup);
  assert.equal((await request(f.origin, undefined, { body: payload() })).status, 200);
  for (const key of [B, V, C]) {
    for (const [method, path, body] of [['GET', '/v1/responses/resp_owned'], ['GET', '/v1/responses/resp_owned/input_items?limit=2'], ['POST', '/v1/responses/resp_owned/cancel', {}], ['DELETE', '/v1/responses/resp_owned'], ['POST', '/v1/responses', payload({ previous_response_id: 'resp_owned' })]]) {
      assert.equal((await request(f.origin, path, { method, key, body })).status, 404);
    }
  }
  assert.equal(f.calls.length, 1, 'all foreign references stop before upstream');
  assert.equal((await request(f.origin, undefined, { body: payload({ previous_response_id: 'resp_owned' }) })).status, 200);
  for (const [method, path, body] of [['GET', '/v1/responses/resp_owned'], ['GET', '/v1/responses/resp_owned/input_items?limit=2&after=item_1'], ['POST', '/v1/responses/resp_owned/cancel', {}], ['DELETE', '/v1/responses/resp_owned']]) assert.equal((await request(f.origin, path, { method, body })).status, 200);
  await tick();
  assert.equal((await request(f.origin, '/v1/responses/resp_owned', { method: 'GET' })).status, 404);
  assert.equal((await request(f.origin, '/v1/responses/ignored_lifecycle_id', { method: 'GET' })).status, 404, 'read/cancel never mint ownership');
});

check('unknown and restart-era Responses fail closed without upstream access', async t => {
  const f = await fixture(t);
  for (const [method, path, body] of [['GET', '/v1/responses/pre_restart'], ['DELETE', '/v1/responses/pre_restart'], ['POST', '/v1/responses/pre_restart/cancel', {}], ['POST', '/v1/responses', payload({ previous_response_id: 'pre_restart' })]]) assert.equal((await request(f.origin, path, { method, body })).status, 404);
  assert.equal(f.calls.length, 0);
  await request(f.origin, undefined, { body: payload() });
  const fresh = createRouter(f.config); cleanup(t, fresh);
  const freshOrigin = await listen(fresh);
  assert.equal((await request(freshOrigin, '/v1/responses/resp_owned', { method: 'GET' })).status, 404);
  assert.equal(f.calls.length, 1);
});

check('lifecycle pins model-level routes and effective credentials rather than group defaults', async t => {
  const f = await fixture(t, (config, upstream) => {
    config.groups[0].models[0].routes = { responses: { baseURL: upstream + '/model-one/v1', upstreamApiKey: 'model-route-key' } };
    config.groups[0].models.push({ id: 'model-two', routes: { responses: { baseURL: upstream + '/model-two/v1', upstreamApiKey: 'second-route-key' } } });
  });
  await request(f.origin, undefined, { body: payload() });
  assert.equal((await request(f.origin, '/v1/responses/resp_owned', { method: 'GET' })).status, 200);
  assert.equal(f.calls[1].url, '/model-one/v1/responses/resp_owned');
  assert.equal(f.calls[1].headers.authorization, 'Bearer model-route-key');
  assert.equal((await request(f.origin, undefined, { body: payload({ model: 'model-two', previous_response_id: 'resp_owned' }) })).status, 404);
  assert.equal(f.calls.length, 2);
  f.router.reload(f.config);
  assert.equal((await request(f.origin, '/v1/responses/resp_owned', { method: 'GET' })).status, 200, 'unchanged reload retains ownership');
  for (const field of ['baseURL', 'upstreamApiKey', 'project', 'organization', 'auth']) {
    const changed = structuredClone(f.config);
    changed.groups[0].models[0].routes.responses[field] = ({ baseURL: f.upstreamOrigin + '/other/v1', upstreamApiKey: 'rotated-route-key', project: 'proj_new', organization: 'org_new', auth: 'x-api-key' })[field];
    f.router.reload(changed);
    assert.equal((await request(f.origin, '/v1/responses/resp_owned', { method: 'GET' })).status, 404, field + ' mutation invalidates old binding');
  }
  assert.equal(f.calls.length, 3);
});

for (const suffix of ['previous_response_id=resp_owned', 'previous_response_id=resp_owned&previous_response_id=other', 'conversation=conv_other', 'conversation%5Bid%5D=conv_other', 'Previous_Response_Id=other', 'response_id=other']) {
  check('query object reference cannot bypass ownership: ' + suffix, async t => {
    const f = await fixture(t);
    assert.equal((await request(f.origin, '/v1/responses?' + suffix, { body: payload() })).status, 400);
    assert.equal(f.calls.length, 0);
  });
}
for (const extra of [{ conversation: 'conv_foreign' }, { conversation: { id: 'conv_foreign' } }, { conversation_id: 'conv_foreign' }, { previous_response_id: {} }, { input: [{ type: 'item_reference', id: 'msg_foreign' }] }, { Previous_Response_Id: 'resp_foreign' }, { response_id: 'resp_foreign' }]) {
  check('untracked body reference fails closed: ' + JSON.stringify(extra), async t => {
    const f = await fixture(t);
    assert.ok([400, 404].includes((await request(f.origin, undefined, { body: payload(extra) })).status));
    assert.equal(f.calls.length, 0);
  });
}

check('large chunked JSON records only the top-level response ID without buffering the body', async t => {
  const f = await fixture(t, () => {}, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method !== 'POST') { res.end('{}'); return; }
    res.write('{"output":[{"id":"nested_foreign","text":"');
    res.write('x'.repeat(2 * 1024 * 1024));
    res.write('"}],"id":"resp_'); res.end('large"}');
  });
  assert.equal((await request(f.origin, undefined, { body: payload() })).status, 200);
  assert.equal((await request(f.origin, '/v1/responses/resp_large', { method: 'GET' })).status, 200);
  assert.equal((await request(f.origin, '/v1/responses/nested_foreign', { method: 'GET' })).status, 404);
});

check('SSE incrementally records split response.created ID before the stream ends', async t => {
  const streamed = deferred(); let upstreamStream;
  const f = await fixture(t, () => {}, (req, res) => {
    if (req.method === 'GET') { res.end('{}'); return; }
    upstreamStream = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ping\r\nevent: response.created\r\nda');
    res.write('ta: {"type":"response.created","response":{"id":"resp_str');
    res.write('eam","object":"response"}}\r\n\r\n');
  });
  const pending = request(f.origin, undefined, { body: payload({ stream: true }), onData: streamed.resolve });
  await streamed.promise;
  const owned = await request(f.origin, '/v1/responses/resp_stream', { method: 'GET' });
  assert.equal(owned.status, 200);
  upstreamStream.end('data: [DONE]\n\n');
  assert.equal((await pending).status, 200);
});

check('observer handles UTF-8, JSON escapes, data-line splits and never trusts nested item IDs', async () => {
  const ids = [];
  const observer = createResponseObserver('text/event-stream; charset=utf-8', id => ids.push(id));
  observer.resume();
  const raw = Buffer.from('event: response.created\r\ndata: {"response":\r\ndata: {"id":"resp_esc\\u0061ped","text":"你好"}}\r\n\r\ndata: {"item":{"id":"foreign"},"response_id":"resp_second"}\n\n');
  for (const byte of raw) observer.write(Buffer.from([byte]));
  observer.end(); await once(observer, 'end');
  assert.deepEqual(ids, ['resp_escaped', 'resp_second']);
});

check('non-success upstream bodies cannot establish response ownership', async t => {
  const f = await fixture(t, () => {}, (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"id":"resp_error"}'); });
  assert.equal((await request(f.origin, undefined, { body: payload() })).status, 400);
  assert.equal((await request(f.origin, '/v1/responses/resp_error', { method: 'GET' })).status, 404);
  assert.equal(f.calls.length, 1);
});

check('redaction survives metadata reloads and isolates rotated credentials from in-flight snapshots', async t => {
  const started = deferred(), release = deferred();
  t.after(release.resolve);
  const oldKey = 'security-upstream', newKey = 'security-replacement-upstream';
  const f = await fixture(t, () => {}, async (req, res, call) => {
    if (call.body.hold) { started.resolve(); await release.promise; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: [oldKey, newKey, A].join('|') }));
  });
  const pending = request(f.origin, undefined, { body: payload({ hold: true }) });
  await started.promise;
  f.config.groups[0].name = 'Metadata only';
  f.config.groups[0].apiKeys.reverse();
  f.router.reload(f.config);
  const unchanged = await request(f.origin, undefined, { body: payload() });
  assert.equal(JSON.parse(unchanged.text).text, ['[REDACTED]', newKey, '[REDACTED]'].join('|'));
  f.config.groups[0].upstreamApiKey = newKey;
  f.router.reload(f.config);
  const rotated = await request(f.origin, undefined, { body: payload() });
  assert.equal(JSON.parse(rotated.text).text, [oldKey, '[REDACTED]', '[REDACTED]'].join('|'));
  assert.equal(f.calls.at(-1).headers.authorization, 'Bearer ' + newKey);
  release.resolve();
  assert.equal(JSON.parse((await pending).text).text, ['[REDACTED]', newKey, '[REDACTED]'].join('|'));
});

check('tracking cache expires, evicts, rejects collisions and is bounded', () => {
  let now = 0; const scope = createResponseScope({ maxEntries: 2, ttlMs: 10, now: () => now });
  const binding = { modelId: model, fingerprint: 'hash' };
  scope.remember('a', 'resp_1', binding); scope.remember('a', 'resp_2', binding); scope.remember('a', 'resp_3', binding);
  assert.equal(scope.size, 2); assert.throws(() => scope.require('a', 'resp_1'), { status: 404 });
  assert.throws(() => scope.require('b', 'resp_2'), { status: 404 });
  scope.remember('a', 'resp_2', { modelId: 'different', fingerprint: 'changed' });
  assert.deepEqual(scope.require('a', 'resp_2').modelId, model);
  now = 10; assert.equal(scope.size, 0); assert.throws(() => scope.require('a', 'resp_2'), { status: 404 });
});

check('caller project/organization are stripped; only validated route constants are forwarded', async t => {
  const f = await fixture(t);
  const headers = { 'openai-project': 'proj_attacker', 'openai-organization': 'org_attacker' };
  await request(f.origin, undefined, { body: payload(), headers });
  assert.equal(f.calls[0].headers['openai-project'], undefined);
  assert.equal(f.calls[0].headers['openai-organization'], undefined);
  f.config.groups[0].routes.responses.project = 'proj_fixed';
  f.config.groups[0].routes.responses.organization = 'org_fixed'; f.router.reload(f.config);
  await request(f.origin, undefined, { body: payload(), headers });
  assert.equal(f.calls[1].headers['openai-project'], 'proj_fixed');
  assert.equal(f.calls[1].headers['openai-organization'], 'org_fixed');
  for (const value of ['', 'line\r\nbreak', 'space separated', {}, 23]) {
    const config = structuredClone(f.config); config.groups[0].routes.responses.project = value;
    assert.throws(() => compileConfig(config), /Invalid route project/);
  }
});

check('idempotency keys are stable within a caller but isolated across callers sharing upstream credentials', async t => {
  const f = await fixture(t, addGroup);
  for (const key of [A, A, B, C]) await request(f.origin, undefined, { key, body: payload(), headers: { 'idempotency-key': 'same-client-value' } });
  const values = f.calls.map(call => call.headers['idempotency-key']);
  assert.equal(values[0], values[1]); assert.equal(new Set(values).size, 3);
  assert.notEqual(values[0], 'same-client-value');
});

for (const [protocol, path, field] of [['responses', '/v1/responses', 'max_output_tokens'], ['chat', '/v1/chat/completions', 'max_completion_tokens'], ['chat', '/v1/completions', 'max_tokens'], ['messages', '/v1/messages', 'max_tokens']]) {
  check(protocol + ' output cap is injected when absent and validates explicit limits', async t => {
    const f = await fixture(t);
    assert.equal((await request(f.origin, path, { body: payload() })).status, 200);
    assert.equal(f.calls[0].body[field], 100);
    for (const value of [101, 0, -1, null, '10', 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await request(f.origin, path, { body: payload({ [field]: value }) })).status, 400);
    assert.equal(f.calls.length, 1);
    assert.equal((await request(f.origin, path, { body: payload({ [field]: 7 }) })).status, 200);
    assert.equal(f.calls[1].body[field], 7);
  });
}
check('configured output limits apply after defaults and both chat token spellings cannot bypass', async t => {
  const f = await fixture(t, config => { config.groups[0].models[0].defaults = { responses: { max_output_tokens: 101 } }; });
  assert.equal((await request(f.origin, undefined, { body: payload() })).status, 400);
  assert.equal((await request(f.origin, '/v1/chat/completions', { body: payload({ max_tokens: 101, max_completion_tokens: 1 }) })).status, 400);
  assert.equal(f.calls.length, 0);
});
check('unconfigured model output limits preserve the native request without arbitrary caps', async t => {
  const f = await fixture(t, config => { delete config.groups[0].models[0].maxOutputTokens; });
  await request(f.origin, undefined, { body: payload() });
  assert.deepEqual(f.calls[0].body, payload());
});

for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync], ['identity', value => value]]) {
  check('response byte limit counts accumulated decompressed bytes: ' + encoding, async t => {
    const done = deferred();
    const f = await fixture(t, config => { config.maxResponseBytes = 64; }, (req, res) => {
      res.once('close', done.resolve);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': encoding });
      const bytes = compress(Buffer.from('data: ' + 'x'.repeat(1024) + '\n\n'));
      res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      res.end(bytes.subarray(Math.floor(bytes.length / 2)));
    });
    const result = await request(f.origin, undefined, { body: payload({ stream: true }), allowAbort: true });
    assert.equal(result.aborted, true);
    assert.ok(result.bytes.length <= 64);
    await done.promise; await tick();
    assert.equal(f.logs.length, 1); assert.equal(f.metrics.length, 1);
    assert.equal(f.metrics[0].status, 502); assert.equal(f.metrics[0].outcome, 'response_limit_error');
  });
}
check('maxResponseBytes is strict positive safe integer with a 256MiB default', async t => {
  const f = await fixture(t);
  assert.equal(compileConfig(f.config).config.maxResponseBytes, 256 * 1024 * 1024);
  for (const value of [0, -1, null, '10', 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => compileConfig({ ...f.config, maxResponseBytes: value }), /Invalid maxResponseBytes/);
});

check('group RPM is shared across apiKeys/virtualApiKeys, isolated from other groups, and retained on reload', async t => {
  const f = await fixture(t, config => { config.groups[0].rateLimits = { maxConcurrent: 0, rpm: 2 }; addGroup(config); });
  for (const key of [A, V]) assert.equal((await request(f.origin, undefined, { key, body: payload() })).status, 200);
  f.router.reload(f.config);
  const limited = await request(f.origin, undefined, { key: B, body: payload() });
  assert.equal(limited.status, 429); assert.match(limited.headers['retry-after'], /^[1-9][0-9]*$/);
  assert.equal(JSON.parse(limited.text).error.type, 'rate_limit_error');
  assert.equal((await request(f.origin, undefined, { key: C, body: payload() })).status, 200);
  assert.equal(f.calls.length, 3);
});

check('group concurrency counts all keys and 0-to-limited reload preserves inflight requests', async t => {
  const entered = deferred(); const held = [];
  const f = await fixture(t, addGroup, (req, res) => { held.push(res); entered.resolve(); });
  const first = request(f.origin, undefined, { body: payload() }); await entered.promise;
  f.config.groups[0].rateLimits = { maxConcurrent: 1, rpm: 0 }; f.router.reload(f.config);
  const limited = await request(f.origin, undefined, { key: V, body: payload() });
  assert.equal(limited.status, 429); assert.equal(f.calls.length, 1);
  const other = request(f.origin, undefined, { key: C, body: payload() });
  // Release the first stream; accepted requests in the independent group finish too.
  held[0].end('{}'); assert.equal((await first).status, 200);
  await tick();
  const next = request(f.origin, undefined, { key: B, body: payload() });
  while (held.length < 3) await tick();
  held[1].end('{}'); held[2].end('{}');
  assert.equal((await other).status, 200); assert.equal((await next).status, 200);
});

check('default group and global limits are truly unlimited, including more than eight active requests', async t => {
  const entered = deferred(); const held = [];
  const f = await fixture(t, () => {}, (req, res) => { held.push(res); if (held.length === 12) entered.resolve(); });
  assert.deepEqual(compileConfig(f.config).config.groups[0].rateLimits, { maxConcurrent: 0, rpm: 0 });
  assert.deepEqual(compileConfig(f.config).config.rateLimits.api, { maxConcurrent: 0, rpm: 0, perKeyMaxConcurrent: 0, perKeyRpm: 0 });
  const pending = Array.from({ length: 12 }, () => request(f.origin, undefined, { body: payload() }));
  await entered.promise; for (const res of held) res.end('{}');
  assert.ok((await Promise.all(pending)).every(result => result.status === 200));
});

check('optional application API and per-key budgets stop requests before upstream', async t => {
  const f = await fixture(t, config => { config.rateLimits = { api: { rpm: 2, perKeyRpm: 1 } }; });
  assert.equal((await request(f.origin, undefined, { body: payload() })).status, 200);
  assert.equal((await request(f.origin, undefined, { body: payload() })).status, 429);
  assert.equal((await request(f.origin, undefined, { key: B, body: payload() })).status, 200);
  assert.equal((await request(f.origin, undefined, { key: V, body: payload() })).status, 429);
  assert.equal(f.calls.length, 2);
});

check('terminal log/metric is once for normal finish and once with status499/outcome for client abort; admission releases', async t => {
  let upstreamClosed = deferred();
  const f = await fixture(t, config => { config.groups[0].rateLimits = { maxConcurrent: 1, rpm: 0 }; }, (req, res) => {
    if (req.url.endsWith('/models')) { res.end('{}'); return; }
    res.once('close', upstreamClosed.resolve);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n');
  });
  await new Promise((resolve, reject) => {
    const req = http.request(f.origin + '/v1/responses', { method: 'POST', agent: false, headers: { authorization: 'Bearer ' + A, 'content-type': 'application/json' } }, res => {
      res.on('error', () => {}); res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
    }); req.on('error', reject); req.end(JSON.stringify(payload({ stream: true })));
  });
  await upstreamClosed.promise; await tick();
  assert.equal(f.logs.length, 1); assert.equal(f.metrics.length, 1);
  assert.equal(f.logs[0].status, 499); assert.equal(f.logs[0].outcome, 'aborted');
  assert.equal(f.metrics[0].status, 499); assert.equal(f.metrics[0].outcome, 'aborted');
  assert.equal((await request(f.origin, '/v1/models', { method: 'GET' })).status, 200);
  await tick(); assert.equal(f.logs.length, 2); assert.equal(f.metrics.length, 2);
  assert.equal(f.logs[1].status, 200); assert.equal(f.logs[1].outcome, 'success');
});

check('duplicate safety fields are canonicalized before upstream interpretation', async t => {
  const f = await fixture(t);
  await request(f.origin, undefined, { body: payload() });
  const raw = Buffer.from('{"model":"foreign-model","model":"security-model","max_output_tokens":9999,"max_output_tokens":10,"previous_response_id":"foreign-response","previous_response_id":"resp_owned"}');
  const result = await request(f.origin, undefined, { body: raw });
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls[1].body, { model, max_output_tokens: 10, previous_response_id: 'resp_owned' });
});

check('ordinary tool schema and metadata property names do not become object authority', async t => {
  const f = await fixture(t);
  const body = payload({ tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { conversation: { type: 'string' }, previous_response_id: { type: 'string' }, response_id: { type: 'string' } } } }], metadata: { conversation: 'user-data' } });
  assert.equal((await request(f.origin, undefined, { body })).status, 200);
  assert.deepEqual(f.calls[0].body.tools, body.tools);
  assert.deepEqual(f.calls[0].body.metadata, body.metadata);
});

check('response limit is cumulative across separately delivered legal-sized chunks', async t => {
  let stream;
  const firstChunk = deferred();
  const f = await fixture(t, config => { config.maxResponseBytes = 64; }, (req, res) => {
    stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('x'.repeat(48));
  });
  const pending = request(f.origin, undefined, { body: payload({ stream: true }), allowAbort: true, onData: firstChunk.resolve });
  await firstChunk.promise; stream.end('x'.repeat(48));
  const result = await pending; await tick();
  assert.equal(result.aborted, true); assert.equal(result.bytes.length, 48);
  assert.equal(f.metrics[0].status, 502); assert.equal(f.metrics[0].outcome, 'response_limit_error');
});

check('request-body disconnect reports499 once and releases group admission', async t => {
  const f = await fixture(t, config => { config.groups[0].rateLimits = { maxConcurrent: 1, rpm: 0 }; });
  const received = deferred(), closed = deferred();
  f.router.once('request', req => { req.once('data', received.resolve); req.socket.once('close', closed.resolve); });
  const req = http.request(f.origin + '/v1/responses', { method: 'POST', agent: false, headers: { authorization: 'Bearer ' + A, 'content-type': 'application/json', 'content-length': 1000 } });
  req.on('error', () => {}); req.write('{"model":');
  await received.promise; req.destroy(); await closed.promise; await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.metrics.length, 1);
  assert.equal(f.metrics[0].status, 499); assert.equal(f.metrics[0].outcome, 'aborted');
  assert.equal((await request(f.origin, '/v1/models', { method: 'GET' })).status, 200);
});

check('moving a calling key between groups does not transfer object ownership', async t => {
  const f = await fixture(t);
  await request(f.origin, undefined, { body: payload() });
  f.config.groups[0].id = 'renamed-security-group'; f.router.reload(f.config);
  assert.equal((await request(f.origin, '/v1/responses/resp_owned', { method: 'GET' })).status, 404);
  assert.equal(f.calls.length, 1);
});

for (const configured of [undefined, null]) {
  check('unset/null model output cap preserves native absent and null token fields: ' + String(configured), async t => {
    const f = await fixture(t, config => {
      if (configured === undefined) delete config.groups[0].models[0].maxOutputTokens;
      else config.groups[0].models[0].maxOutputTokens = null;
    });
    assert.equal(compileConfig(f.config).config.groups[0].models[0].maxOutputTokens, configured);
    for (const [path, field] of [['/v1/responses', 'max_output_tokens'], ['/v1/chat/completions', 'max_tokens'], ['/v1/chat/completions', 'max_completion_tokens'], ['/v1/messages', 'max_tokens']]) {
      assert.equal((await request(f.origin, path, { body: payload() })).status, 200);
      assert.deepEqual(f.calls.at(-1).body, payload());
      assert.equal((await request(f.origin, path, { body: payload({ [field]: null }) })).status, 200);
      assert.deepEqual(f.calls.at(-1).body, payload({ [field]: null }));
    }
  });
}
