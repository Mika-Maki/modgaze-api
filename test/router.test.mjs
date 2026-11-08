import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from '../src/router.mjs';

// All traffic stays on ephemeral localhost ports. These are deliberately fake keys.
const CLIENT_A = 'test-client-alpha';
const CLIENT_B = 'test-client-beta';
const UPSTREAM_KEY = 'test-upstream-only';
const MODEL = 'public-model';
const TEST_TIMEOUT = 6000;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return 'http://127.0.0.1:' + server.address().port;
}

function track(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return async () => {
    const closed = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    await closed;
  };
}

function request(origin, path, { method = 'POST', headers = {}, body, key = CLIENT_A } = {}) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body :
    Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, origin), {
      method,
      agent: false,
      headers: {
        ...(key === null ? {} : { authorization: 'Bearer ' + key }),
        ...(bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': bytes.length }),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('test client timeout')));
    req.once('error', reject);
    req.end(bytes);
  });
}

async function fixture(t, { configure = () => {}, handler } = {}) {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const call = { method: req.method, url: req.url, headers: req.headers, body,
        json: body.length ? JSON.parse(body.toString('utf8')) : undefined };
      calls.push(call);
      if (handler) await handler(req, res, call);
      else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    } catch (error) {
      if (!res.destroyed) res.destroy(error);
    }
  });
  const stopUpstream = track(upstream);
  t.after(stopUpstream);
  const upstreamURL = await listen(upstream);
  const config = {
    host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024,
    requestTimeoutMs: 2000, upstreamTimeoutMs: 1000,
    groups: [{
      id: 'alpha', apiKeys: [CLIENT_A], upstreamApiKey: UPSTREAM_KEY,
      routes: {
        chat: { baseURL: upstreamURL + '/v1', auth: 'bearer' },
        responses: { baseURL: upstreamURL + '/v1', auth: 'bearer' },
        messages: { baseURL: upstreamURL + '/anthropic', auth: 'x-api-key' },
      },
      models: [{ id: MODEL, contextWindow: 128000, maxOutputTokens: 8192,
        input: ['text', 'image'], reasoningEfforts: ['low', 'medium', 'high'] }],
    }],
  };
  configure(config, upstreamURL);
  const logs = [];
  const router = createRouter(config, { logger: (...args) => logs.push(args) });
  assert.ok(router instanceof http.Server, 'createRouter returns a node http.Server');
  assert.equal(router.listening, false, 'createRouter must not listen itself');
  t.after(track(router));
  const origin = await listen(router);
  return { config, origin, upstreamURL, calls, logs, router };
}

const check = (name, fn) => test(name, { timeout: TEST_TIMEOUT }, fn);
const payload = extra => ({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], ...extra });

check('healthz is available without credentials and does not contact upstream', async t => {
  const f = await fixture(t);
  const res = await request(f.origin, '/healthz', { method: 'GET', key: null });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0);
});

for (const [path, expected, body] of [
  ['/v1/chat/completions', '/v1/chat/completions', payload()],
  ['/v1/completions', '/v1/completions', { model: MODEL, prompt: 'hello' }],
  ['/v1/responses', '/v1/responses', { model: MODEL, input: 'hello' }],
  ['/v1/messages', '/anthropic/v1/messages', { model: MODEL, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }],
  ['/v1/messages/count_tokens', '/anthropic/v1/messages/count_tokens', payload()],
]) {
  check('POST ' + path + ' selects the correct protocol route', async t => {
    const f = await fixture(t);
    const res = await request(f.origin, path, { body });
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, expected);
    assert.equal(f.calls[0].method, 'POST');
    assert.deepEqual(f.calls[0].json, body);
  });
}

for (const [base, path, expected] of [
  ['', '/v1/chat/completions', '/v1/chat/completions'],
  ['/v1/', '/v1/chat/completions', '/v1/chat/completions'],
  ['', '/v1/messages', '/v1/messages'],
  ['/v1', '/v1/messages', '/v1/messages'],
  ['/anthropic/v1', '/v1/messages', '/anthropic/v1/messages'],
  ['/anthropic/', '/v1/messages', '/anthropic/v1/messages'],
]) {
  check('baseURL ' + (base || '(root)') + ' joins ' + path + ' without duplicate v1', async t => {
    const f = await fixture(t, { configure(config, origin) {
      for (const route of Object.values(config.groups[0].routes)) route.baseURL = origin + base;
    } });
    const res = await request(f.origin, path, { body: payload({ max_tokens: 20 }) });
    assert.equal(res.status, 200);
    assert.equal(f.calls[0].url, expected);
  });
}

check('bearer upstream receives only its configured credential', async t => {
  const f = await fixture(t);
  const res = await request(f.origin, '/v1/chat/completions', { body: payload() });
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].headers.authorization, 'Bearer ' + UPSTREAM_KEY);
  assert.equal(f.calls[0].headers['x-api-key'], undefined);
  assert.equal(JSON.stringify(f.calls[0]).includes(CLIENT_A), false);
});

check('x-api-key client authentication maps to the configured messages credential', async t => {
  const f = await fixture(t);
  const res = await request(f.origin, '/v1/messages', { key: null,
    headers: { 'x-api-key': CLIENT_A, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-test' },
    body: payload({ max_tokens: 10 }) });
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].headers['x-api-key'], UPSTREAM_KEY);
  assert.equal(f.calls[0].headers.authorization, undefined);
  assert.equal(f.calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(f.calls[0].headers['anthropic-beta'], 'tools-test');
});

for (const [name, options] of [
  ['missing', { key: null }],
  ['unknown', { key: 'not-a-real-client-key' }],
  ['malformed bearer', { key: null, headers: { authorization: 'Basic abc' } }],
  ['conflicting', { headers: { 'x-api-key': CLIENT_B } }],
]) {
  check(name + ' authentication returns 401 without an upstream request', async t => {
    const f = await fixture(t);
    const res = await request(f.origin, '/v1/chat/completions', { ...options, body: payload() });
    assert.equal(res.status, 401);
    assert.equal(f.calls.length, 0);
  });
}

for (const key of ['base_url', 'baseURL', 'upstream_url', 'upstreamURL']) {
  check('caller upstream override ' + key + ' is rejected with 400', async t => {
    const f = await fixture(t);
    const res = await request(f.origin, '/v1/chat/completions', {
      body: payload({ [key]: f.upstreamURL + '/attacker-controlled' }),
    });
    assert.equal(res.status, 400);
    assert.equal(f.calls.length, 0);
  });
}

check('an undeclared model returns 404 without forwarding', async t => {
  const f = await fixture(t);
  const res = await request(f.origin, '/v1/chat/completions', { body: payload({ model: 'not-declared' }) });
  assert.equal(res.status, 404);
  assert.equal(f.calls.length, 0);
});

check('an undeclared protocol returns 400 rather than falling back to chat', async t => {
  const f = await fixture(t, { configure(config) { delete config.groups[0].routes.messages; } });
  const res = await request(f.origin, '/v1/messages', { body: payload() });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

check('model-level routes override group routes', async t => {
  const f = await fixture(t, { configure(config, origin) {
    config.groups[0].models[0].routes = { chat: { baseURL: origin + '/alternate/v1', auth: 'bearer' } };
  } });
  const res = await request(f.origin, '/v1/chat/completions', { body: payload() });
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].url, '/alternate/v1/chat/completions');
});

check('an upstreamModel alias is applied without dropping other request fields', async t => {
  const f = await fixture(t, { configure(config) { config.groups[0].models[0].upstreamModel = 'private-model'; } });
  const body = payload({ temperature: 0, metadata: { trace: 'opaque' }, reasoning_effort: 'high' });
  const res = await request(f.origin, '/v1/chat/completions', { body });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls[0].json, { ...body, model: 'private-model' });
});

check('JSON request bytes are unchanged when no alias or defaults apply', async t => {
  const f = await fixture(t);
  const raw = Buffer.from('{  "model" : "public-model",\n "messages": [], "custom":1e+3, "text":"你好" }\n');
  const res = await request(f.origin, '/v1/chat/completions', { body: raw });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls[0].body, raw);
});

check('JSON response bytes and upstream success status are preserved', async t => {
  const raw = Buffer.from('{ "id": "response-1",\n "value":1e+3,"text":"你好" }\n');
  const f = await fixture(t, { handler(req, res) {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(raw);
  } });
  const res = await request(f.origin, '/v1/responses', { body: { model: MODEL, input: 'hi' } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, raw);
});

for (const [protocol, path, nativeBody, defaults] of [
  ['chat', '/v1/chat/completions', payload({ temperature: 0, stream: false, top_p: null }),
    { temperature: 0.7, stream: true, top_p: 0.9, max_tokens: 77 }],
  ['responses', '/v1/responses', { model: MODEL, input: 'hi', temperature: 0, store: false },
    { temperature: 0.7, store: true, max_output_tokens: 77 }],
  ['messages', '/v1/messages', payload({ temperature: 0, max_tokens: 12 }),
    { temperature: 0.7, max_tokens: 77, top_k: 4 }],
]) {
  check(protocol + ' defaults fill absent fields and preserve explicit false, zero and null', async t => {
    const f = await fixture(t, { configure(config) { config.groups[0].models[0].defaults = { [protocol]: defaults }; } });
    const res = await request(f.origin, path, { body: nativeBody });
    assert.equal(res.status, 200);
    assert.deepEqual(f.calls[0].json, { ...defaults, ...nativeBody });
  });
}

check('protocol defaults never leak into a different protocol', async t => {
  const f = await fixture(t, { configure(config) {
    config.groups[0].models[0].defaults = { chat: { max_tokens: 19, reasoning_effort: 'low' } };
  } });
  const body = { model: MODEL, input: 'hello' };
  const res = await request(f.origin, '/v1/responses', { body });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls[0].json, body);
});

check('chat image, tools and native reasoning parameters survive unchanged', async t => {
  const f = await fixture(t);
  const body = payload({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
    ] }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto', parallel_tool_calls: false, reasoning_effort: 'provider-native-effort',
  });
  const res = await request(f.origin, '/v1/chat/completions', { body });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls[0].json, body);
});

check('responses input items, tools and reasoning object survive unchanged', async t => {
  const f = await fixture(t);
  const body = { model: MODEL, input: [{ role: 'user', content: [
    { type: 'input_text', text: 'describe' },
    { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
  ] }], tools: [{ type: 'web_search_preview' }], reasoning: { effort: 'provider-native', summary: 'auto' },
  previous_response_id: 'resp_earlier', include: ['reasoning.encrypted_content'] };
  const res = await request(f.origin, '/v1/responses', { body });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls[0].json, body);
});

check('messages image, tool blocks, system and thinking survive unchanged', async t => {
  const f = await fixture(t);
  const body = payload({ max_tokens: 4096, system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      { type: 'text', text: 'describe' },
    ] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'answer' }] }],
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    thinking: { type: 'enabled', budget_tokens: 2048 }, tool_choice: { type: 'auto' } });
  const res = await request(f.origin, '/v1/messages', { body });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls[0].json, body);
});

function addBeta(config, origin) {
  config.groups.push({ id: 'beta', apiKeys: [CLIENT_B], upstreamApiKey: 'test-beta-upstream',
    routes: { chat: { baseURL: origin + '/beta/v1', auth: 'bearer' } },
    models: [{ id: 'beta-only', contextWindow: 4096, maxOutputTokens: 512,
      input: ['text'], reasoningEfforts: [] }] });
}

check('model list exposes declared capabilities but no upstream secrets or URLs', async t => {
  const f = await fixture(t, { configure(config, origin) {
    config.groups[0].models[0].upstreamModel = 'private-model-hidden';
    addBeta(config, origin);
  } });
  const res = await request(f.origin, '/v1/models', { method: 'GET' });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.text).data;
  assert.deepEqual(data.map(model => model.id), [MODEL]);
  assert.equal(data[0].context_window, 128000);
  assert.equal(data[0].max_output_tokens, 8192);
  assert.deepEqual(data[0].input_modalities, ['text', 'image']);
  assert.deepEqual(data[0].reasoning_efforts, ['low', 'medium', 'high']);
  for (const secret of [CLIENT_A, CLIENT_B, UPSTREAM_KEY, f.upstreamURL, 'private-model-hidden']) {
    assert.equal(res.text.includes(secret), false, 'must hide ' + secret);
  }
  assert.equal(f.calls.length, 0);
});

check('model listings and model detail are isolated by API key', async t => {
  const f = await fixture(t, { configure: addBeta });
  const list = await request(f.origin, '/v1/models', { method: 'GET', key: CLIENT_B });
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.text).data.map(model => model.id), ['beta-only']);
  const visible = await request(f.origin, '/v1/models/' + MODEL, { method: 'GET' });
  assert.equal(visible.status, 200);
  assert.equal(JSON.parse(visible.text).id, MODEL);
  assert.equal(JSON.parse(visible.text).context_window, 128000);
  const hidden = await request(f.origin, '/v1/models/' + MODEL, { method: 'GET', key: CLIENT_B });
  assert.equal(hidden.status, 404);
  assert.equal(f.calls.length, 0);
});

check('API key alone selects the group route and upstream credential', async t => {
  const f = await fixture(t, { configure: addBeta });
  const res = await request(f.origin, '/v1/chat/completions', { key: CLIENT_B, body: payload({ model: 'beta-only' }) });
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].url, '/beta/v1/chat/completions');
  assert.equal(f.calls[0].headers.authorization, 'Bearer test-beta-upstream');
});

check('a model declared only in another group cannot be invoked', async t => {
  const f = await fixture(t, { configure: addBeta });
  const res = await request(f.origin, '/v1/chat/completions', { body: payload({ model: 'beta-only' }) });
  assert.equal(res.status, 404);
  assert.equal(f.calls.length, 0);
});

check('model discovery requires authentication', async t => {
  const f = await fixture(t);
  for (const path of ['/v1/models', '/v1/models/' + MODEL]) {
    const res = await request(f.origin, path, { method: 'GET', key: null });
    assert.equal(res.status, 401);
  }
  assert.equal(f.calls.length, 0);
});

for (const [method, path, body] of [
  ['GET', '/v1/responses/resp_test', undefined],
  ['DELETE', '/v1/responses/resp_test', undefined],
  ['GET', '/v1/responses/resp_test/input_items?limit=2&after=item_1&order=asc', undefined],
  ['POST', '/v1/responses/resp_test/cancel', {}],
]) {
  check(method + ' ' + path + ' passes through without a model field', async t => {
    const f = await fixture(t);
    const res = await request(f.origin, path, { method, body });
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, method);
    assert.equal(f.calls[0].url, path);
    assert.equal(f.calls[0].headers.authorization, 'Bearer ' + UPSTREAM_KEY);
  });
}

check('response resource operations require a group responses route', async t => {
  const f = await fixture(t, { configure(config) {
    delete config.groups[0].routes.responses;
  } });
  const res = await request(f.origin, '/v1/responses/resp_test', { method: 'GET' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

check('SSE status, retry-after, comments, event names and raw UTF-8 bytes are preserved', async t => {
  const raw = Buffer.from(': ping\nevent: response.output_text.delta\ndata: {"delta":"你好"}\n\ndata: [DONE]\n\n');
  const f = await fixture(t, { handler(req, res) {
    res.writeHead(202, { 'content-type': 'text/event-stream', 'retry-after': '7' });
    // Split inside the first multibyte character to detect unsafe chunk decoding.
    const split = raw.indexOf(Buffer.from('你')) + 1;
    res.write(raw.subarray(0, split));
    res.end(raw.subarray(split));
  } });
  const res = await request(f.origin, '/v1/responses', { body: { model: MODEL, input: 'hi', stream: true } });
  assert.equal(res.status, 202);
  assert.ok(res.headers['content-type'].startsWith('text/event-stream'));
  assert.equal(res.headers['retry-after'], '7');
  assert.deepEqual(res.body, raw);
});

check('SSE forwards the first event before the upstream ends', async t => {
  let upstreamEnded = false;
  let upstreamResponse;
  const f = await fixture(t, { handler(req, res) {
    upstreamResponse = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  } });
  await new Promise((resolve, reject) => {
    const body = JSON.stringify(payload({ stream: true }));
    const req = http.request(f.origin + '/v1/chat/completions', { method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + CLIENT_A, 'content-type': 'application/json' } }, res => {
      assert.equal(res.statusCode, 200);
      res.once('data', chunk => {
        try {
          assert.equal(upstreamEnded, false);
          assert.match(chunk.toString(), /data: first/);
          upstreamEnded = true;
          upstreamResponse.end('data: [DONE]\n\n');
        } catch (error) { reject(error); }
      });
      res.once('error', reject);
      res.once('end', resolve);
    });
    req.setTimeout(2000, () => req.destroy(new Error('stream was buffered')));
    req.once('error', reject);
    req.end(body);
  });
});

check('client disconnect closes an active upstream SSE response', async t => {
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const f = await fixture(t, { handler(req, res) {
    res.once('close', resolveClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  } });
  await new Promise((resolve, reject) => {
    const req = http.request(f.origin + '/v1/chat/completions', { method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + CLIENT_A, 'content-type': 'application/json' } }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
      res.on('error', () => {});
    });
    req.setTimeout(2000, () => req.destroy(new Error('no SSE event')));
    req.once('error', reject);
    req.end(JSON.stringify(payload({ stream: true })));
  });
  let timer;
  try {
    await Promise.race([closed, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('upstream connection survived client disconnect')), 1500);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(f.calls.length, 1);
});

for (const status of [400, 401, 429, 500, 503]) {
  check('upstream HTTP ' + status + ' is forwarded byte-for-byte without retry', async t => {
    const raw = Buffer.from('{ "error": { "message":"provider error", "code":"native" } }\n');
    const f = await fixture(t, { handler(req, res) {
      res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '13' });
      res.end(raw);
    } });
    const res = await request(f.origin, '/v1/chat/completions', { body: payload() });
    assert.equal(res.status, status);
    assert.equal(res.headers['retry-after'], '13');
    assert.deepEqual(res.body, raw);
    assert.equal(f.calls.length, 1);
  });
}

check('upstream socket failure returns 502 without retry', async t => {
  const f = await fixture(t, { handler(req, res) { req.socket.destroy(); } });
  const res = await request(f.origin, '/v1/chat/completions', { body: payload() });
  assert.equal(res.status, 502);
  assert.equal(f.calls.length, 1);
});

check('upstream response timeout returns 504 without retry', async t => {
  const f = await fixture(t, { configure(config) { config.upstreamTimeoutMs = 60; }, handler() {} });
  const res = await request(f.origin, '/v1/chat/completions', { body: payload() });
  assert.equal(res.status, 504);
  assert.equal(f.calls.length, 1);
});

check('redirects are not followed and cannot leak credentials to the redirect target', async t => {
  let leakedCalls = 0;
  const sink = http.createServer((req, res) => { leakedCalls++; res.end('leaked'); });
  t.after(track(sink));
  const sinkOrigin = await listen(sink);
  const f = await fixture(t, { handler(req, res) {
    res.writeHead(307, { location: sinkOrigin + '/credential-sink' });
    res.end('redirect body');
  } });
  const res = await request(f.origin, '/v1/chat/completions', { body: payload() });
  // Either forward the redirect or reject it; silently following it is forbidden.
  assert.ok(res.status === 307 || res.status === 502, 'redirect must be forwarded or rejected');
  assert.equal(leakedCalls, 0);
  assert.equal(f.calls.length, 1);
});

check('oversized Content-Length body returns 413 before forwarding', async t => {
  const f = await fixture(t, { configure(config) { config.maxBodyBytes = 128; } });
  const res = await request(f.origin, '/v1/chat/completions', { body: payload({ padding: 'x'.repeat(1024) }) });
  assert.equal(res.status, 413);
  assert.equal(f.calls.length, 0);
});

check('oversized chunked body returns 413 without relying on Content-Length', async t => {
  const f = await fixture(t, { configure(config) { config.maxBodyBytes = 128; } });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.origin + '/v1/chat/completions', { method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + CLIENT_A, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
      res.once('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('chunked client timeout')));
    req.once('error', reject);
    req.write('{"model":"public-model","padding":"');
    req.write('x'.repeat(1024));
    req.end('"}');
  });
  assert.equal(status, 413);
  assert.equal(f.calls.length, 0);
});

for (const raw of ['{broken', '', 'null', '[]']) {
  check('invalid request JSON ' + JSON.stringify(raw) + ' returns 400', async t => {
    const f = await fixture(t);
    const res = await request(f.origin, '/v1/chat/completions', { body: raw });
    assert.equal(res.status, 400);
    assert.equal(f.calls.length, 0);
  });
}

check('a stalled client request body hits requestTimeoutMs and returns 408', async t => {
  const f = await fixture(t, { configure(config) { config.requestTimeoutMs = 80; } });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.origin + '/v1/chat/completions', { method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + CLIENT_A, 'content-type': 'application/json', 'content-length': '100' } }, res => {
      res.resume();
      res.once('end', () => { resolve(res.statusCode); req.destroy(); });
      res.once('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('request body timeout was not enforced')));
    req.once('error', reject);
    req.write('{"model":');
  });
  assert.equal(status, 408);
  assert.equal(f.calls.length, 0);
});
