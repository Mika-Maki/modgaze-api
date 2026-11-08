import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createRouter } from '../src/router.mjs';
import { createAdmin } from '../src/admin.mjs';

const CLIENT_KEY = 'synthetic-audit-client-key-2026';
const UPSTREAM_KEY = 'synthetic-audit-upstream-key-2026';
const MODEL = 'audit-model';
const IP = '198.51.100.23';
const FIELDS = ['requestIp', 'inputTokens', 'outputTokens', 'reasoningTokens', 'systemPrompt', 'model', 'group', 'key'];
const fingerprint = createHash('sha256').update(CLIENT_KEY).digest('hex').slice(0, 16);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, audit) {
  const dir = await mkdtemp(join(tmpdir(), 'mr-audit-e2e-'));
  const servers = [], upstreamRequests = [], logs = [], callbacks = [];
  const auditEvents = new EventEmitter();
  let handler = async (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } } }));
  };
  t.after(async () => {
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });
  const upstream = http.createServer((request, response) => {
    (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      upstreamRequests.push({ path: request.url, headers: request.headers, parsed: body ? JSON.parse(body) : null });
      await handler(request, response);
    })().catch(error => response.destroy(error));
  });
  servers.push(upstream);
  const upstreamUrl = await listen(upstream);
  const config = {
    host: '127.0.0.1', port: 0, upstreamTimeoutMs: 10000, requestTimeoutMs: 15000,
    groups: [{
      id: 'audit-group', virtualApiKeys: [CLIENT_KEY], upstreamApiKey: UPSTREAM_KEY,
      routes: Object.fromEntries(['chat', 'responses', 'messages'].map(protocol => [protocol, { baseURL: upstreamUrl + '/v1' }])),
      models: [{ id: MODEL, maxOutputTokens: null, defaults: {
        chat: { messages: [{ role: 'system', content: '默认系统提示 中文🙂' }] },
        responses: { instructions: 'Responses default instructions' },
        messages: { system: [{ type: 'text', text: 'Anthropic default system' }] },
      } }],
    }],
    ...(audit === undefined ? {} : { audit }),
  };
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const router = createRouter(config, { logger: entry => logs.push(entry), onAudit: entry => { callbacks.push(entry); auditEvents.emit('record', entry); } });
  servers.push(router);
  const api = await listen(router);
  const admin = await createAdmin({
    configPath, runDir: join(dir, 'run'), authPath: join(dir, 'auth.private.json'),
    projectRoot: fileURLToPath(new URL('../', import.meta.url)), adminPort: 0,
    requestAudit: router.requestAudit, reload: next => router.reload(next),
  });
  servers.push(admin);
  const management = await listen(admin);
  const setup = await fetch(management + '/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-audit-admin-password-2026' }),
  });
  assert.equal(setup.status, 200);
  const { csrfToken } = await setup.json();
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  async function manage(path, body) {
    const response = await fetch(management + path, {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() };
  }
  function request(path = '/v1/chat/completions', { body = { model: MODEL }, headers = {}, localAddress = '127.0.0.1' } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request(api + path, { method: 'POST', localAddress, agent: false, headers: {
        authorization: 'Bearer ' + CLIENT_KEY, 'content-type': 'application/json', 'cf-connecting-ip': IP, ...headers,
      } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      outgoing.on('error', reject);
      outgoing.end(JSON.stringify(body));
    });
  }
  return { config, configPath, router, api, auditEvents, management, manage, request, logs, callbacks, upstreamRequests, setHandler: next => { handler = next; } };
}

function assertNoRawSecrets(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(CLIENT_KEY), false);
  assert.equal(text.includes(UPSTREAM_KEY), false);
}

test('audit settings persist nested partial patches, require auth and reject invalid patches without writes', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const unauthorized = await fetch(f.management + '/api/request-audit');
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  const first = await f.manage('/api/settings', { audit: { enabled: true, fields: { systemPrompt: true, key: true }, maxEntries: 17 } });
  assert.equal(first.status, 200);
  assert.equal(first.json.settings.audit.fields.inputTokens, true);
  const second = await f.manage('/api/settings', { audit: { fields: { outputTokens: false } } });
  assert.equal(second.status, 200);
  assert.equal(second.json.settings.audit.enabled, true);
  assert.equal(second.json.settings.audit.fields.systemPrompt, true);
  assert.equal(second.json.settings.audit.fields.key, true);
  assert.equal(second.json.settings.audit.fields.outputTokens, false);
  const persisted = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.deepEqual(persisted.audit, second.json.settings.audit);
  assert.equal((await stat(f.configPath)).mode & 0o777, 0o600);
  const before = await readFile(f.configPath, 'utf8'), beforeStat = await stat(f.configPath);
  for (const audit of [null, [], { enabled: 'yes' }, { unknown: 1 }, { fields: null }, { fields: { key: 1 } }, { fields: { typo: true } }, { maxEntries: 2001 }, { maxPromptChars: 0 }, { trustedProxies: ['127.0.0.0/8'] }, { ipSource: 'forwarded' }]) {
    const response = await f.manage('/api/settings', { audit });
    assert.equal(response.status, 400, JSON.stringify({ audit, response }));
    assert.equal(await readFile(f.configPath, 'utf8'), before);
    const afterStat = await stat(f.configPath);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  }
  assert.equal((await f.request()).status, 200);
  assert.equal(f.callbacks.length, 1);
  assert.equal('outputTokens' in f.callbacks[0], false);
  const state = await f.manage('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.settings.audit.enabled, true);
  assert.equal(state.json.requestAudit.total, 1);
  // Authenticated state intentionally includes management virtualKeys; audit must not.
  assertNoRawSecrets(state.json.requestAudit);
});

test('real socket peers enforce Cloudflare trust and authenticated audit filtering', { timeout: 20000 }, async t => {
  const f = await fixture(t, { enabled: true });
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request('/v1/chat/completions', { localAddress: '127.0.0.2', headers: { 'cf-connecting-ip': '203.0.113.99' } })).status, 200);
  assert.deepEqual(f.callbacks.map(entry => entry.requestIp), [IP, '127.0.0.2']);
  const all = await f.manage('/api/request-audit');
  assert.equal(all.status, 200);
  assert.equal(all.json.total, 2);
  assert.deepEqual(all.json.entries.map(entry => entry.requestIp), ['127.0.0.2', IP]);
  const filtered = await f.manage('/api/request-audit?ip=' + encodeURIComponent(IP));
  assert.equal(filtered.json.total, 1);
  assert.deepEqual(filtered.json.byIp, [{ ip: IP, requests: 1, errors: 0 }]);
  const state = await f.manage('/api/state');
  assert.deepEqual(state.json.requestAudit.entries, all.json.entries);
});

test('JSON and fragmented gzip SSE expose protocol usage, default prompts and only key fingerprints', { timeout: 20000 }, async t => {
  const f = await fixture(t, { enabled: true, fields: { systemPrompt: true, key: true } });
  const variants = [
    { path: '/v1/chat/completions', protocol: 'chat', prompt: '默认系统提示 中文🙂', json: { usage: { prompt_tokens: 21, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } } }, events: [{ usage: { prompt_tokens: 21, completion_tokens: 2 } }, { usage: { completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } } }], expected: { inputTokens: 21, outputTokens: 8, reasoningTokens: 3 } },
    { path: '/v1/responses', protocol: 'responses', prompt: 'Responses default instructions', json: { id: 'resp_audit', usage: { input_tokens: 22, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } }, events: [{ type: 'response.created', response: { id: 'resp_stream_audit' } }, { type: 'response.completed', response: { usage: { input_tokens: 22, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } } }], expected: { inputTokens: 22, outputTokens: 9, reasoningTokens: 4 } },
    { path: '/v1/messages', protocol: 'messages', prompt: 'Anthropic default system', json: { usage: { input_tokens: 23, output_tokens: 10 } }, events: [{ type: 'message_start', message: { usage: { input_tokens: 23, output_tokens: 0 } } }, { type: 'message_delta', usage: { output_tokens: 6 } }, { type: 'message_delta', usage: { output_tokens: 10 } }], expected: { inputTokens: 23, outputTokens: 10 } },
  ];
  for (const variant of variants) {
    for (const streaming of [false, true]) {
      const body = streaming
        ? ': 中文🙂\r\n' + variant.events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n'
        : JSON.stringify(variant.json);
      f.setHandler(async (request, response) => {
        response.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json', ...(streaming ? { 'content-encoding': 'gzip' } : {}) });
        if (!streaming) { response.end(body); return; }
        const compressed = gzipSync(Buffer.from(body));
        for (let index = 0; index < compressed.length; index += 3) {
          if (response.destroyed) return;
          response.write(compressed.subarray(index, index + 3));
          await nextTurn();
        }
        response.end();
      });
      const response = await f.request(variant.path, { body: { model: MODEL, ...(streaming ? { stream: true } : {}) } });
      assert.equal(response.status, 200);
      assert.equal(response.body, body);
      assert.equal(response.headers['content-encoding'], undefined);
      const entry = f.callbacks.at(-1);
      assert.equal(entry.protocol, variant.protocol);
      assert.equal(entry.systemPrompt, variant.prompt);
      assert.equal(entry.model, MODEL);
      assert.equal(entry.group, 'audit-group');
      assert.equal(entry.key, fingerprint);
      for (const field of ['inputTokens', 'outputTokens', 'reasoningTokens']) {
        if (Object.hasOwn(variant.expected, field)) assert.equal(entry[field], variant.expected[field]);
        else assert.equal(field in entry, false);
      }
      const upstream = f.upstreamRequests.at(-1);
      assert.equal(variant.protocol === 'messages' ? upstream.headers['x-api-key'] : upstream.headers.authorization, variant.protocol === 'messages' ? UPSTREAM_KEY : 'Bearer ' + UPSTREAM_KEY);
    }
  }
  f.setHandler(async (request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":31}'); });
  assert.equal((await f.request('/v1/messages/count_tokens')).status, 200);
  assert.equal(f.callbacks.at(-1).inputTokens, 31);
  assert.equal('outputTokens' in f.callbacks.at(-1), false);
  assert.equal(f.callbacks.length, 7);
  const snapshot = (await f.manage('/api/request-audit')).json;
  assert.equal(snapshot.total, 7);
  assertNoRawSecrets({ snapshot, callbacks: f.callbacks, logs: f.logs });
});

for (const globalDisable of [false, true]) {
  test('hot ' + (globalDisable ? 'global disable clears memory' : 'field opt-out filters records') + ' during held SSE prevents API and callback leaks', { timeout: 20000 }, async t => {
    const f = await fixture(t, { enabled: true, fields: { systemPrompt: true, key: true } });
    await f.request();
    assert.equal(f.callbacks.length, 1);
    const started = deferred(), release = deferred();
    t.after(() => release.resolve());
    f.setHandler(async (request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"usage":{"prompt_tokens":100}}\n\n');
      started.resolve();
      await release.promise;
      response.end('data: {"usage":{"completion_tokens":20}}\n\n');
    });
    const pending = f.request('/v1/chat/completions', { body: { model: MODEL, stream: true } });
    await started.promise;
    const patch = globalDisable ? { enabled: false } : { fields: Object.fromEntries(FIELDS.map(field => [field, false])) };
    assert.equal((await f.manage('/api/settings', { audit: patch })).status, 200);
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.match(response.body, /completion_tokens/);
    const snapshot = (await f.manage('/api/request-audit')).json;
    if (globalDisable) {
      assert.equal(f.callbacks.length, 1);
      assert.deepEqual(snapshot.entries, []);
      assert.equal(snapshot.total, 0);
      assert.equal((await f.manage('/api/settings', { audit: { enabled: true } })).status, 200);
      assert.equal((await f.manage('/api/request-audit')).json.total, 0, 'reenabling cannot resurrect records');
    } else {
      assert.equal(f.callbacks.length, 2);
      assert.equal(snapshot.total, 2);
      for (const entry of [f.callbacks.at(-1), ...snapshot.entries]) {
        for (const field of FIELDS) assert.equal(field in entry, false, field + ' must be omitted');
      }
      assert.deepEqual(snapshot.byIp, [{ ip: '未记录 IP', requests: 2, errors: 0 }]);
      assert.equal((await f.manage('/api/settings', { audit: { fields: { systemPrompt: true, key: true } } })).status, 200);
      for (const entry of (await f.manage('/api/request-audit')).json.entries) {
        assert.equal('systemPrompt' in entry, false);
        assert.equal('key' in entry, false);
      }
    }
    assertNoRawSecrets({ snapshot, callbacks: f.callbacks, logs: f.logs });
  });
}

test('HTTP failures, upstream socket failure and client abort each record exactly once', { timeout: 20000 }, async t => {
  const f = await fixture(t, { enabled: true });
  f.setHandler(async (request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"synthetic failure"}}');
  });
  assert.equal((await f.request()).status, 500);
  assert.equal(f.callbacks.length, 1);
  assert.equal(f.callbacks[0].outcome, 'error');
  f.setHandler(async (request, response) => response.destroy());
  assert.equal((await f.request()).status, 502);
  assert.equal(f.callbacks.length, 2);
  assert.equal(f.callbacks[1].outcome, 'api_error');
  const upstreamClosed = deferred();
  f.setHandler(async (request, response) => {
    response.once('close', upstreamClosed.resolve);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"usage":{"prompt_tokens":9}}\n\n');
  });
  const recorded = once(f.auditEvents, 'record');
  await new Promise((resolve, reject) => {
    const outgoing = http.request(f.api + '/v1/chat/completions', {
      method: 'POST', agent: false, headers: {
        authorization: 'Bearer ' + CLIENT_KEY, 'content-type': 'application/json', 'cf-connecting-ip': IP,
      },
    }, response => { response.destroy(); resolve(); });
    outgoing.on('error', error => { if (error.code === 'ECONNRESET') resolve(); else reject(error); });
    outgoing.end(JSON.stringify({ model: MODEL, stream: true }));
  });
  const [aborted] = await recorded;
  await upstreamClosed.promise;
  await nextTurn();
  assert.equal(aborted.status, 499);
  assert.equal(aborted.outcome, 'aborted');
  assert.equal(f.callbacks.length, 3);
  assert.equal(f.logs.length, 3);
  assert.equal(new Set(f.callbacks.map(entry => entry.requestId)).size, 3);
  const snapshot = (await f.manage('/api/request-audit')).json;
  assert.equal(snapshot.total, 3);
  assert.deepEqual(snapshot.entries.map(entry => entry.status), [499, 502, 500]);
  assert.deepEqual(snapshot.byIp, [{ ip: IP, requests: 3, errors: 3 }]);
  assertNoRawSecrets({ snapshot, callbacks: f.callbacks, logs: f.logs });
});

test('audit is disabled by default and preserves legacy request logging without sensitive fields', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.callbacks.length, 0);
  assert.equal(f.logs.length, 1);
  assert.deepEqual(Object.keys(f.logs[0]).sort(), ['duration_ms', 'event', 'method', 'outcome', 'protocol', 'request_id', 'status']);
  assert.equal(f.logs[0].event, 'request');
  assert.equal(f.logs[0].status, 200);
  const state = await f.manage('/api/state');
  assert.equal(state.json.settings.audit.enabled, false);
  assert.deepEqual(state.json.requestAudit, { entries: [], byIp: [], total: 0 });
  assert.equal((await f.manage('/api/request-audit')).json.total, 0);
  assertNoRawSecrets({ logs: f.logs, requestAudit: state.json.requestAudit });
});
