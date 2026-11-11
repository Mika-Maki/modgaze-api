import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createRouter, compileConfig } from '../src/router.mjs';
import { createTokenUsageStore } from '../src/token-usage.mjs';

const CLIENT = 'mr-token-router-client', DIRECT = 'synthetic-token-direct';
const hash = value => createHash('sha256').update(value).digest('hex');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { limits = {}, tokenUsageStore, onTokenUsageError } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'modgaze-token-router-'));
  let upstreamHandler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } } })); };
  const servers = [], stores = [];
  t.after(async () => {
    for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function listen(server) { servers.push(server); await new Promise(done => server.listen(0, '127.0.0.1', done)); return 'http://127.0.0.1:' + server.address().port; }
  const upstreamRequests = [];
  const upstream = await listen(http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    upstreamHandler(req, res);
  }));
  const createStore = () => { const store = createTokenUsageStore({ directory: join(directory, 'tokens') }); stores.push(store); return store; };
  const store = tokenUsageStore ?? createStore();
  const config = { audit: { enabled: false }, groups: [{ id: 'tokens', virtualApiKeys: [CLIENT], apiKeys: [DIRECT], upstreamApiKey: 'synthetic-token-upstream',
    routes: Object.fromEntries(['chat', 'responses', 'messages'].map(protocol => [protocol, { baseURL: upstream }])), models: [{ id: 'm' }],
    virtualKeyMeta: { [hash(CLIENT).slice(0, 16)]: { tokenLimits: limits } } }] };
  let router = createRouter(config, { tokenUsageStore: store, onTokenUsageError });
  let base = await listen(router);
  return { directory, store, config, upstreamRequests, createStore,
    handler(value) { upstreamHandler = value; },
    async restart() { router.closeAllConnections(); await new Promise(done => router.close(done)); await store.close(); router = createRouter(config, { tokenUsageStore: createStore() }); base = await listen(router); },
    reload() { router.reload(config); },
    async request(path = '/v1/chat/completions', body = { model: 'm' }, key = CLIENT) {
      const response = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, text: await response.text() };
    },
  };
}

test('all upstream requests persist known usage with audit disabled and cached input counted once', async t => {
  const f = await fixture(t);
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request('/v1/chat/completions', { model: 'm' }, DIRECT)).status, 200);
  f.handler((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 11 } } })); });
  assert.equal((await f.request('/v1/responses')).status, 200);
  const { total, today } = await f.store.snapshot();
  assert.equal(total.inputTokens, 40); assert.equal(total.outputTokens, 11); assert.equal(total.cachedTokens, 23); assert.equal(total.totalTokens, 51); assert.equal(total.requests, 3);
  assert.deepEqual(today, total);
  assert.equal((await f.store.snapshot({ keyId: hash(CLIENT) })).total.totalTokens, 37);
  assert.equal((await f.store.snapshot({ keyId: hash(DIRECT) })).total.totalTokens, 14);
});

test('fragmented compressed Anthropic SSE merges cumulative usage and normalizes cache creation/read', async t => {
  const f = await fixture(t);
  const events = [{ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 6, cache_creation_input_tokens: 4, output_tokens: 0 } } },
    { type: 'message_delta', usage: { output_tokens: 3 } }, { type: 'message_delta', usage: { output_tokens: 8 } }];
  const body = ': ignored\r\ndata: {bad JSON}\r\n\r\n' + events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
  f.handler(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    for (const byte of gzipSync(body)) { res.write(Buffer.from([byte])); await nextTurn(); }
    res.end();
  });
  const response = await f.request('/v1/messages', { model: 'm', stream: true, max_tokens: 8 });
  assert.equal(response.status, 200); assert.equal(response.text, body);
  const { total } = await f.store.snapshot();
  assert.equal(total.inputTokens, 20); assert.equal(total.outputTokens, 8); assert.equal(total.cachedTokens, 6); assert.equal(total.totalTokens, 28); assert.equal(total.requests, 1);
});

test('streaming usage is recorded once and request stream_options remain native', async t => {
  const f = await fixture(t);
  const body = 'data: {"usage":{"prompt_tokens":12,"prompt_tokens_details":{"cached_tokens":5}}}\n\ndata: {"usage":{"completion_tokens":7}}\n\ndata: {"usage":{"completion_tokens":7}}\n\ndata: [DONE]\n\n';
  f.handler((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const byte of Buffer.from(body)) res.write(Buffer.from([byte])); res.end(); });
  const input = { model: 'm', stream: true, stream_options: { include_usage: false, custom: 'preserve' } };
  assert.equal((await f.request('/v1/chat/completions', input)).text, body);
  assert.deepEqual(JSON.parse(f.upstreamRequests[0].body), input);
  const { total } = await f.store.snapshot();
  assert.equal(total.inputTokens, 12); assert.equal(total.outputTokens, 7); assert.equal(total.cachedTokens, 5); assert.equal(total.totalTokens, 19); assert.equal(total.requests, 1);
});

test('partial count_tokens usage persists known input without inventing output or cached observations', async t => {
  const f = await fixture(t);
  f.handler((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":17}'); });
  assert.equal((await f.request('/v1/messages/count_tokens')).status, 200);
  const { total } = await f.store.snapshot();
  assert.equal(total.inputTokens, 17); assert.equal(total.totalTokens, 17);
  assert.deepEqual(total.observed, { inputTokens: 1, outputTokens: 0, cachedTokens: 0, totalTokens: 0 });
});

test('unknown and malformed usage is forwarded without manufacturing consumption', async t => {
  const f = await fixture(t);
  for (const body of ['{"choices":[]}', '{bad JSON}', '{"usage":{"input_tokens":-1,"output_tokens":"3"}}']) {
    f.handler((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
    assert.equal((await f.request()).text, body);
  }
  assert.equal((await f.store.snapshot()).total.requests, 0);
});

for (const [field, value] of [['totalTokens', 14], ['inputTokens', 10], ['outputTokens', 4], ['cachedTokens', 6], ['dayTokens', 14]]) {
  test('MR quota rejects the next upstream request at ' + field + ' boundary', async t => {
    const f = await fixture(t, { limits: { [field]: value } });
    assert.equal((await f.request()).status, 200);
    const denied = await f.request();
    assert.equal(denied.status, 429); assert.equal(JSON.parse(denied.text).error.type, 'token_quota_exceeded');
    if (field === 'dayTokens') assert.ok(Number(denied.headers.get('retry-after')) > 0);
    assert.equal(f.upstreamRequests.length, 1);
    assert.equal((await f.request('/v1/chat/completions', { model: 'm' }, DIRECT)).status, 200);
  });
}

test('quota survives router/store restart and stable identity preserves consumption after key rotation', async t => {
  const f = await fixture(t, { limits: { totalTokens: 14 } });
  assert.equal((await f.request()).status, 200);
  await f.restart();
  assert.equal((await f.request()).status, 429);
  const rotated = 'mr-token-router-rotated';
  f.config.groups[0].virtualApiKeys = [rotated];
  f.config.groups[0].virtualKeyMeta = { [hash(rotated).slice(0, 16)]: { tokenLimits: { totalTokens: 14 }, tokenUsageId: hash(CLIENT) } };
  f.reload();
  assert.equal((await f.request('/v1/chat/completions', { model: 'm' }, rotated)).status, 429);
  assert.equal(f.upstreamRequests.length, 1);
});

test('already admitted requests may complete after another response exhausts quota', async t => {
  const f = await fixture(t, { limits: { totalTokens: 1 } });
  const first = deferred(), second = deferred(), entered = deferred();
  let hits = 0;
  t.after(() => { first.resolve(); second.resolve(); });
  f.handler(async (req, res) => {
    const index = ++hits; if (hits === 2) entered.resolve();
    await (index === 1 ? first.promise : second.promise);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"usage":{"prompt_tokens":10,"completion_tokens":2}}');
  });
  const a = f.request(), b = f.request();
  await entered.promise; first.resolve(); assert.equal((await a).status, 200);
  assert.equal((await f.request()).status, 429);
  second.resolve(); assert.equal((await b).status, 200);
  assert.equal((await f.store.snapshot()).total.totalTokens, 24);
});

test('record failure is reported and subsequent limited requests fail closed', async t => {
  let errors = 0, records = 0;
  const f = await fixture(t, { limits: { totalTokens: 100 }, onTokenUsageError: () => { errors++; }, tokenUsageStore: {
    async check() {}, async record() { records++; throw new Error('synthetic private error'); },
  } });
  assert.equal((await f.request()).status, 200); await nextTurn();
  assert.equal(records, 1); assert.equal(errors, 1);
  const denied = await f.request();
  assert.equal(denied.status, 503); assert.equal(JSON.parse(denied.text).error.type, 'token_usage_unavailable');
  assert.equal(f.upstreamRequests.length, 1);
});

test('compile rejects invalid token limits and stable usage identities', async t => {
  const f = await fixture(t);
  for (const tokenLimits of [null, { totalTokens: -1 }, { dayTokens: 1.5 }, { extra: 1 }]) {
    const config = structuredClone(f.config); config.groups[0].virtualKeyMeta[hash(CLIENT).slice(0, 16)].tokenLimits = tokenLimits;
    assert.throws(() => compileConfig(config));
  }
  for (const tokenUsageId of ['short', 'A'.repeat(64), 1, null]) {
    const config = structuredClone(f.config); config.groups[0].virtualKeyMeta[hash(CLIENT).slice(0, 16)].tokenUsageId = tokenUsageId;
    assert.throws(() => compileConfig(config), /usage identity/);
  }
});

test('actual server drains on SIGTERM and enforces persisted quota after process restart', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'modgaze-token-process-'));
  await cp(resolve('src'), join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', version: 'test' }));
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"usage":{"prompt_tokens":2,"completion_tokens":1}}'); });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  let child;
  t.after(async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); await rm(directory, { recursive: true, force: true }); });
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port: 0, groups: [{ id: 'process', virtualApiKeys: [CLIENT], upstreamApiKey: 'synthetic-token-process-upstream', routes: { chat: { baseURL: 'http://127.0.0.1:' + upstream.address().port } }, models: [{ id: 'm' }], virtualKeyMeta: { [hash(CLIENT).slice(0, 16)]: { tokenLimits: { totalTokens: 3 } } } }] }), { mode: 0o600 });
  async function start() {
    child = spawn(process.execPath, [join(directory, 'src/server.mjs'), '--config', configPath, '--no-admin'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    return await new Promise((done, reject) => {
      let output = '', errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      child.once('error', reject); child.once('exit', code => reject(new Error('server exited ' + code + ': ' + errors)));
      child.stdout.on('data', chunk => { output += chunk; for (const line of output.split('\n')) { try { const record = JSON.parse(line); if (record.event === 'listening') done('http://127.0.0.1:' + record.port); } catch {} } });
    });
  }
  async function request(base) { const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + CLIENT, 'content-type': 'application/json' }, body: '{"model":"m"}' }); await response.text(); return response.status; }
  assert.equal(await request(await start()), 200);
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0);
  assert.equal(await request(await start()), 429);
});
