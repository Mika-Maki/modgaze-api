import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeAuditConfig, resolveAuditIp, createAuditObserver, extractSystemPrompt, createRequestAudit } from '../src/request-audit.mjs';

const enabled = (extra = {}) => normalizeAuditConfig({ enabled: true, ...extra });
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
const base = { time: 123, requestId: 'request-1', method: 'POST', protocol: 'chat', status: 200, outcome: 'success', durationMs: 12 };

async function observe(body, type = 'application/json', fragmentSize = 7) {
  const source = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const usages = [], output = [];
  const observer = createAuditObserver(type, usage => usages.push(usage));
  function* chunks() {
    for (let i = 0; i < source.length; i += fragmentSize) yield source.subarray(i, i + fragmentSize);
  }
  await pipeline(Readable.from(chunks()), observer, new Writable({ write(chunk, encoding, done) { output.push(chunk); done(); } }));
  assert.deepEqual(Buffer.concat(output), source, 'observer must preserve every byte');
  return usages;
}

test('audit config defaults, partial merge, exact bounds and detached copies', () => {
  const defaults = normalizeAuditConfig();
  assert.deepEqual(defaults, {
    enabled: false, fields: { requestIp: true, inputTokens: true, outputTokens: true, systemPrompt: false, reasoningTokens: true, model: true, group: true, key: false },
    ipSource: 'cloudflare', trustedProxies: ['127.0.0.1', '::1'], maxEntries: 500, maxPromptChars: 16384,
  });
  assert.equal(enabled({ fields: { systemPrompt: true } }).fields.requestIp, true);
  for (const [maxEntries, maxPromptChars] of [[1, 1], [2000, 65536]]) {
    assert.equal(enabled({ maxEntries, maxPromptChars }).maxEntries, maxEntries);
  }
  defaults.fields.key = true;
  defaults.trustedProxies.push('192.0.2.1');
  assert.equal(normalizeAuditConfig().fields.key, false);
  assert.equal(normalizeAuditConfig().trustedProxies.length, 2);
  assert.deepEqual(enabled({ trustedProxies: ['::ffff:127.0.0.1', '2001:0DB8:0:0:0:0:0:1'] }).trustedProxies, ['127.0.0.1', '2001:db8::1']);
  assert.deepEqual(enabled({ trustedProxies: [] }).trustedProxies, []);
});

test('audit config strictly rejects unknown keys, wrong types and invalid exact proxies', () => {
  for (const input of [null, [], true, 'yes', 0, new Date(), { typo: true }, { [Symbol('x')]: 1 }, { fields: { typo: false } }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => normalizeAuditConfig(input));
  }
  for (const value of [null, 1, 'true', undefined, [], {}]) assert.throws(() => normalizeAuditConfig({ enabled: value }));
  for (const fields of [null, [], true, { key: 1 }, { inputTokens: undefined }, { systemPrompt: null }]) assert.throws(() => normalizeAuditConfig({ fields }));
  for (const ipSource of [null, undefined, '', 'forwarded', 'Cloudflare']) assert.throws(() => normalizeAuditConfig({ ipSource }));
  for (const key of ['maxEntries', 'maxPromptChars']) {
    for (const value of [0, -1, 1.5, null, undefined, '1', NaN, Infinity, key === 'maxEntries' ? 2001 : 65537]) {
      assert.throws(() => normalizeAuditConfig({ [key]: value }));
    }
  }
  for (const trustedProxies of [null, '127.0.0.1', [null], [1], ['localhost'], ['127.0.0.0/8'], ['::/0'], ['127.0.0.1:80'], ['[::1]'], ['fe80::1%eth0'], [' 127.0.0.1'], ['999.0.0.1'], new Array(1)]) {
    assert.throws(() => normalizeAuditConfig({ trustedProxies }));
  }
});

test('Cloudflare headers require trusted socket peers and invalid headers fall back', () => {
  const headers = { 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '192.0.2.1' };
  assert.equal(resolveAuditIp(req('203.0.113.9', headers), enabled()), '203.0.113.9');
  assert.equal(resolveAuditIp(req('127.0.0.1', headers), enabled()), '198.51.100.9');
  assert.equal(resolveAuditIp(req('::ffff:127.0.0.1', headers), enabled()), '198.51.100.9');
  assert.equal(resolveAuditIp(req('127.0.0.1', headers), enabled({ ipSource: 'socket' })), '127.0.0.1');
  assert.equal(resolveAuditIp(req('127.0.0.1', headers), enabled({ trustedProxies: [] })), '127.0.0.1');
  for (const value of ['', 'unknown', '198.51.100.9, 192.0.2.1', ['198.51.100.9'], '[::1]', '1.2.3.4:443', 'fe80::1%eth0']) {
    assert.equal(resolveAuditIp(req('::1', { 'cf-connecting-ip': value }), enabled()), '::1');
  }
  assert.equal(resolveAuditIp(req('::1', { 'x-forwarded-for': '192.0.2.1' }), enabled()), '::1');
  assert.equal(resolveAuditIp(req('not-an-ip', headers), enabled()), null);
  assert.equal(resolveAuditIp({}, enabled()), null);
});

test('IPv6 canonicalization and mapped IPv4 apply equally to socket, headers and trust', () => {
  assert.equal(resolveAuditIp(req('2001:0DB8:0:0:0:0:0:1'), enabled()), '2001:db8::1');
  assert.equal(resolveAuditIp(req('0:0:0:0:0:ffff:c000:0201'), enabled()), '192.0.2.1');
  assert.equal(resolveAuditIp(req('::1', { 'cf-connecting-ip': ' 2001:0DB8:0:0:0:0:0:9 ' }), enabled()), '2001:db8::9');
  assert.equal(resolveAuditIp(req('::1', { 'cf-connecting-ip': '::FFFF:192.0.2.9' }), enabled()), '192.0.2.9');
  assert.equal(resolveAuditIp(req('2001:db8::1', { 'cf-connecting-ip': '192.0.2.9' }), enabled({ trustedProxies: ['2001:0db8:0000::1'] })), '192.0.2.9');
});

test('XFF walks right to left, stops at first untrusted hop and rejects invalid chains', () => {
  const config = enabled({ ipSource: 'x-forwarded-for', trustedProxies: ['127.0.0.1', '::1', '10.0.0.2'] });
  const resolve = value => resolveAuditIp(req('127.0.0.1', { 'x-forwarded-for': value }), config);
  assert.equal(resolve('198.51.100.1, 203.0.113.5, 10.0.0.2'), '203.0.113.5');
  assert.equal(resolve('2001:0DB8::8, ::ffff:10.0.0.2'), '2001:db8::8');
  assert.equal(resolve('::1, 10.0.0.2'), '::1');
  for (const value of ['bad, 10.0.0.2', '192.0.2.1, bad', '192.0.2.1,', '', ['192.0.2.1']]) assert.equal(resolve(value), '127.0.0.1');
  assert.equal(resolveAuditIp(req('203.0.113.1', { 'x-forwarded-for': '192.0.2.1' }), config), '203.0.113.1');
});

test('JSON usage supports chat, Responses, Anthropic and count_tokens without invented fields', async () => {
  const cases = [
    [{ usage: { prompt_tokens: 10, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } } }, { inputTokens: 10, outputTokens: 8, reasoningTokens: 3 }],
    [{ usage: { input_tokens: 11, output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 } } }, { inputTokens: 11, outputTokens: 7, reasoningTokens: 2 }],
    [{ response: { usage: { input_tokens: 12, output_tokens: 6, output_tokens_details: { reasoning_tokens: 1 } } } }, { inputTokens: 12, outputTokens: 6, reasoningTokens: 1 }],
    [{ type: 'message_start', message: { usage: { input_tokens: 13, output_tokens: 0 } } }, { inputTokens: 13, outputTokens: 0 }],
    [{ type: 'message_delta', usage: { output_tokens: 5 } }, { outputTokens: 5 }],
    [{ input_tokens: 42 }, { inputTokens: 42 }],
    [{ usage: { prompt_tokens: 0, completion_tokens: null } }, { inputTokens: 0 }],
  ];
  for (const [value, expected] of cases) assert.deepEqual(await observe(JSON.stringify({ ...value, text: '中文🦉' }), 'application/json; charset=utf-8', 1), [expected]);
  assert.deepEqual(await observe('{"usage":{"prompt_tokens":2}}', 'application/vnd.api+json'), [{ inputTokens: 2 }]);
  for (const body of ['{bad', 'null', '[]', '{"usage":null}', '{"usage":{"input_tokens":-1,"output_tokens":"3"}}', '{"input_tokens":1.5}', '{}']) assert.deepEqual(await observe(body), []);
  assert.deepEqual(await observe('{"input_tokens":5}', 'text/plain'), []);
});

test('fragmented CRLF SSE merges cumulative usage by latest value, not addition', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } }, text: '中文🙂' },
    { type: 'message_delta', usage: { output_tokens: 5 } },
    { type: 'message_delta', usage: { output_tokens: 8 } },
    { response: { usage: { output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 } } } },
  ];
  const body = ': heartbeat\r\nevent: message\r\n' + events.map(value => 'data: ' + JSON.stringify(value) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
  const usages = await observe(body, 'text/event-stream; charset=utf-8', 1);
  assert.deepEqual(usages, [
    { inputTokens: 100, outputTokens: 0 }, { inputTokens: 100, outputTokens: 5 },
    { inputTokens: 100, outputTokens: 8 }, { inputTokens: 100, outputTokens: 7, reasoningTokens: 2 },
  ]);
});

test('SSE accepts multiline data, bare CR, malformed frames and final unterminated frame', async () => {
  const body = 'data: {"usage":\rdata: {"prompt_tokens":3}}\r\rdata: nope\r\rdata\r\rdata: {"usage":{"completion_tokens":4}}';
  assert.deepEqual(await observe(body, 'text/event-stream', 2), [{ inputTokens: 3 }, { inputTokens: 3, outputTokens: 4 }]);
});

test('observer forwards bytes before EOF and callback failures cannot damage traffic', async () => {
  const stream = createAuditObserver('text/event-stream', () => { throw new Error('audit callback failed'); });
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  const frame = Buffer.from('data: {"input_tokens":1}\n\n');
  stream.write(frame);
  assert.deepEqual(Buffer.concat(chunks), frame);
  stream.end();
  await new Promise((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); });
});

test('JSON parser accepts 1MiB, ignores larger input and SSE recovers after oversized frames', async () => {
  const cap = 1024 * 1024;
  const prefix = '{"input_tokens":4,"padding":"', suffix = '"}';
  const atCap = prefix + 'x'.repeat(cap - prefix.length - suffix.length) + suffix;
  assert.deepEqual(await observe(atCap, 'application/json', 8191), [{ inputTokens: 4 }]);
  assert.deepEqual(await observe(atCap + ' ', 'application/json', 8191), []);
  const oversized = 'data: ' + atCap + '\n\n';
  assert.deepEqual(await observe(oversized + 'data: {"input_tokens":8}\n\n', 'text/event-stream', 8191), [{ inputTokens: 8 }]);
  assert.deepEqual(await observe('data: ' + 'x'.repeat(cap * 3) + '\n\ndata: {"output_tokens":2}\n\n', 'text/event-stream', 65536), [{ outputTokens: 2 }]);
  assert.deepEqual(await observe((': ignored\n').repeat(120000) + '\ndata: {"input_tokens":9}\n\n', 'text/event-stream', 65536), [{ inputTokens: 9 }]);
});

test('system prompt extraction selects only supported roles and textual blocks', () => {
  const messages = [
    { role: 'system', content: 'system' }, { role: 'user', content: 'private user' },
    { role: 'developer', content: [{ type: 'text', text: 'developer' }, { type: 'image_url', text: 'not text', image_url: 'private' }, { type: 'input_text', text: 'input' }] },
    { role: 'assistant', content: 'private assistant' }, null,
  ];
  assert.equal(extractSystemPrompt({ messages }, 'chat'), 'system\ndeveloper\ninput');
  assert.equal(extractSystemPrompt({ instructions: 'instructions', input: messages }, 'responses'), 'instructions\nsystem\ndeveloper\ninput');
  assert.equal(extractSystemPrompt({ system: [{ type: 'text', text: 'anthropic' }, { type: 'image', text: 'secret' }] }, 'messages'), 'anthropic');
  assert.equal(extractSystemPrompt({ system: 'direct' }, 'anthropic'), 'direct');
  for (const value of [null, {}, { system: '' }, { system: [] }, { system: [{ type: 'image', source: 'secret' }] }]) assert.equal(extractSystemPrompt(value, 'messages'), null);
  assert.equal(extractSystemPrompt({ input: 'user text' }, 'responses'), null);
});

test('records retain base fields and whitelist only enabled projected values', () => {
  const audit = createRequestAudit();
  assert.equal(audit.record(base, enabled()), null);
  assert.equal(audit.snapshot().total, 0);
  audit.configure(enabled());
  const entry = { ...base, requestIp: '192.0.2.1', inputTokens: 0, model: 'model', group: 'group', key: 'fingerprint', systemPrompt: 'hidden', headers: { authorization: 'secret' }, body: 'secret' };
  const recorded = audit.record(entry, enabled());
  assert.deepEqual(recorded, { ...base, requestIp: '192.0.2.1', inputTokens: 0, model: 'model', group: 'group' });
  recorded.model = 'external mutation';
  assert.deepEqual(audit.snapshot().entries[0], { ...base, requestIp: '192.0.2.1', inputTokens: 0, model: 'model', group: 'group' });
  entry.model = 'mutated';
  const snapshot = audit.snapshot();
  snapshot.entries[0].model = 'mutated again';
  assert.equal(audit.snapshot().entries[0].model, 'model');
  assert.equal('outputTokens' in audit.snapshot().entries[0], false);
});

test('configure purges opt-outs and stale in-flight records cannot re-enable fields', () => {
  const audit = createRequestAudit();
  const before = enabled({ fields: { systemPrompt: true, key: true }, maxPromptChars: 5 });
  audit.configure(before);
  audit.record({ ...base, systemPrompt: 'abcdef', key: 'fp', requestIp: '192.0.2.1', model: 'm' }, before);
  assert.equal(audit.snapshot().entries[0].systemPrompt, 'abcde');
  const after = enabled({ fields: { systemPrompt: false, key: false, requestIp: false, model: false } });
  audit.configure(after);
  audit.record({ ...base, systemPrompt: 'leak', key: 'fp', requestIp: '192.0.2.1', model: 'm' }, before);
  assert.deepEqual(audit.snapshot().entries, [base, base]);
  assert.deepEqual(audit.snapshot().byIp, [{ ip: '未记录 IP', requests: 2, errors: 0 }]);
  audit.configure(before);
  assert.deepEqual(audit.snapshot().entries, [base, base], 'old fields never resurrect');
  audit.record({ ...base, key: 'fp' }, after);
  assert.equal('key' in audit.snapshot().entries[0], false, 'request-time opt-out also respected');
  audit.configure({ enabled: false });
  assert.equal(audit.record({ ...base, key: 'fp' }, before), null);
  assert.deepEqual(audit.snapshot(), { entries: [], byIp: [], total: 0 });
  audit.configure(before);
  assert.equal(audit.snapshot().total, 0);
});

test('ring is bounded, newest first, resizes, groups errors and supports IP filtering/reset', () => {
  const audit = createRequestAudit();
  audit.configure(enabled({ maxEntries: 3 }));
  for (let i = 0; i < 5; i++) audit.record({ ...base, requestId: String(i), requestIp: i === 4 ? 'b' : 'a', status: i === 3 ? 500 : 200, outcome: i === 4 ? 'aborted' : 'success' });
  assert.deepEqual(audit.snapshot().entries.map(entry => entry.requestId), ['4', '3', '2']);
  assert.deepEqual(audit.snapshot().byIp, [{ ip: 'b', requests: 1, errors: 1 }, { ip: 'a', requests: 2, errors: 1 }]);
  assert.equal(audit.snapshot({ ip: 'a' }).total, 2);
  assert.deepEqual(audit.snapshot({ ip: 'missing' }), { entries: [], byIp: [], total: 0 });
  audit.configure(enabled({ maxEntries: 1 }));
  assert.equal(audit.snapshot().entries[0].requestId, '4');
  assert.equal(audit.snapshot().total, 1);
  audit.configure(enabled({ maxEntries: 4 }));
  audit.record({ ...base, requestId: '5' });
  assert.deepEqual(audit.snapshot({ ip: '未记录 IP' }).byIp, [{ ip: '未记录 IP', requests: 1, errors: 0 }]);
  audit.reset();
  assert.deepEqual(audit.snapshot(), { entries: [], byIp: [], total: 0 });
  audit.record(base);
  assert.equal(audit.snapshot().total, 1, 'reset preserves configuration');
});

test('configuration snapshots are detached and prompt shrink is permanent', () => {
  const audit = createRequestAudit(), config = enabled({ fields: { systemPrompt: true }, maxPromptChars: 8 });
  audit.configure(config);
  config.enabled = false;
  config.fields.systemPrompt = false;
  audit.record({ ...base, systemPrompt: 'abcdefghij' });
  assert.equal(audit.snapshot().entries[0].systemPrompt, 'abcdefgh');
  audit.configure(enabled({ fields: { systemPrompt: true }, maxPromptChars: 3 }));
  audit.configure(enabled({ fields: { systemPrompt: true }, maxPromptChars: 8 }));
  assert.equal(audit.snapshot().entries[0].systemPrompt, 'abc');
  assert.throws(() => audit.configure({ enabled: 'true' }));
  assert.equal(audit.snapshot().total, 1);
});
