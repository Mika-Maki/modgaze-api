import { isIP } from 'node:net';
import { Transform } from 'node:stream';

const FIELD_DEFAULTS = Object.freeze({
  requestIp: true, inputTokens: true, outputTokens: true, systemPrompt: false,
  reasoningTokens: true, model: true, group: true, key: false,
});
const CONFIG_KEYS = new Set(['enabled', 'fields', 'ipSource', 'trustedProxies', 'maxEntries', 'maxPromptChars']);
const BASE_FIELDS = ['time', 'requestId', 'method', 'protocol', 'status', 'outcome', 'durationMs'];
const MAX_PARSE_BYTES = 1024 * 1024;
const plainObject = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function canonicalIp(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const ip = new URL('http://[' + value + ']/').hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(ip);
  if (!mapped) return ip;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}

// trustedProxies accepts exact IP literals only, not CIDRs, hostnames, ports,
// bracketed addresses or zone identifiers. Mapped IPv4 and IPv6 are canonicalized.
export function normalizeAuditConfig(input = {}) {
  if (!plainObject(input)) throw new Error('Invalid requestAudit: expected an object');
  for (const key of Reflect.ownKeys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new Error('Unknown requestAudit field: ' + String(key));
  }
  const result = {
    enabled: false, fields: { ...FIELD_DEFAULTS }, ipSource: 'cloudflare',
    trustedProxies: ['127.0.0.1', '::1'], maxEntries: 500, maxPromptChars: 16384,
  };
  for (const key of ['enabled', 'ipSource', 'maxEntries', 'maxPromptChars']) {
    if (Object.hasOwn(input, key)) result[key] = input[key];
  }
  if (typeof result.enabled !== 'boolean') throw new Error('Invalid requestAudit.enabled: expected a boolean');
  if (!['socket', 'cloudflare', 'x-forwarded-for'].includes(result.ipSource)) throw new Error('Invalid requestAudit.ipSource');
  for (const [key, maximum] of [['maxEntries', 2000], ['maxPromptChars', 65536]]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maximum) {
      throw new Error('Invalid requestAudit.' + key + ': expected 1 to ' + maximum);
    }
  }
  if (Object.hasOwn(input, 'fields')) {
    if (!plainObject(input.fields)) throw new Error('Invalid requestAudit.fields: expected an object');
    for (const key of Reflect.ownKeys(input.fields)) {
      if (!Object.hasOwn(FIELD_DEFAULTS, key)) throw new Error('Unknown requestAudit.fields field: ' + String(key));
      if (typeof input.fields[key] !== 'boolean') throw new Error('Invalid requestAudit.fields.' + key + ': expected a boolean');
      result.fields[key] = input.fields[key];
    }
  }
  if (Object.hasOwn(input, 'trustedProxies')) {
    if (!Array.isArray(input.trustedProxies)) throw new Error('Invalid requestAudit.trustedProxies: expected exact IPs');
    result.trustedProxies = Array.from(input.trustedProxies, ip => {
      const normalized = canonicalIp(ip);
      if (!normalized) throw new Error('Invalid requestAudit.trustedProxies: expected exact IPs (no CIDR, hostname, port or zone)');
      return normalized;
    });
  }
  return result;
}

export function resolveAuditIp(req, config) {
  const socket = canonicalIp(req?.socket?.remoteAddress);
  if (!socket) return null;
  const settings = normalizeAuditConfig(config);
  if (settings.ipSource === 'socket' || !settings.trustedProxies.includes(socket)) return socket;
  const name = settings.ipSource === 'cloudflare' ? 'cf-connecting-ip' : 'x-forwarded-for';
  const header = req?.headers?.[name];
  if (typeof header !== 'string') return socket;
  if (settings.ipSource === 'cloudflare') return canonicalIp(header.trim()) ?? socket;
  const chain = header.split(',').map(ip => canonicalIp(ip.trim()));
  if (chain.some(ip => !ip)) return socket;
  for (let index = chain.length - 1; index >= 0; index--) {
    if (!settings.trustedProxies.includes(chain[index])) return chain[index];
  }
  return chain[0] ?? socket;
}

function usageFields(parsed) {
  if (!plainObject(parsed)) return {};
  const usage = parsed.response?.usage ?? parsed.message?.usage ?? parsed.usage;
  const source = plainObject(usage) ? usage : parsed;
  const fields = {
    inputTokens: source.input_tokens ?? source.prompt_tokens,
    outputTokens: source.output_tokens ?? source.completion_tokens,
    reasoningTokens: source.output_tokens_details?.reasoning_tokens ?? source.completion_tokens_details?.reasoning_tokens,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
}

// Observes only JSON bodies and SSE frames. One fixed-capacity byte buffer avoids
// unbounded fragment arrays, unterminated lines and split UTF-8 decoding errors.
// Oversized JSON is ignored; oversized SSE frames are skipped until a blank line.
export function createAuditObserver(contentType, onUsage) {
  const type = typeof contentType === 'string' ? contentType.trim() : '';
  const sse = /^text\/event-stream(?:\s*;|$)/i.test(type);
  const json = /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(type);
  let buffer, length = 0, overflow = false, lineLength = 0, afterCR = false;
  let latest = {};
  function parse(text) {
    try {
      const fields = usageFields(JSON.parse(text));
      if (!Object.keys(fields).length) return;
      latest = { ...latest, ...fields };
      onUsage?.({ ...latest });
    } catch { /* Malformed upstream data or audit callbacks cannot break traffic. */ }
  }
  function append(bytes) {
    if (overflow || bytes.length === 0) return;
    if (length + bytes.length > MAX_PARSE_BYTES) {
      overflow = true; length = 0; buffer = undefined; return;
    }
    buffer ??= Buffer.allocUnsafe(MAX_PARSE_BYTES);
    bytes.copy(buffer, length);
    length += bytes.length;
  }
  function frame() {
    if (!overflow && length) {
      const data = buffer.toString('utf8', 0, length).split('\n')
        .filter(line => line === 'data' || line.startsWith('data:'))
        .map(line => line === 'data' ? '' : line.slice(line[5] === ' ' ? 6 : 5)).join('\n');
      if (data && data.trim() !== '[DONE]') parse(data);
    }
    length = 0; overflow = false;
  }
  const newline = Buffer.from('\n');
  function observe(chunk) {
    if (!sse) { if (json) append(chunk); return; }
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (afterCR) {
        afterCR = false;
        if (byte === 10) { start = index + 1; continue; }
      }
      if (byte !== 10 && byte !== 13) { lineLength++; continue; }
      append(chunk.subarray(start, index));
      if (lineLength === 0) frame();
      else append(newline);
      lineLength = 0;
      afterCR = byte === 13;
      start = index + 1;
    }
    append(chunk.subarray(start));
  }
  return new Transform({
    transform(chunk, encoding, callback) {
      observe(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (sse) frame();
      else if (json && !overflow && length) parse(buffer.toString('utf8', 0, length));
      buffer = undefined; length = 0;
      callback();
    },
    destroy(error, callback) { buffer = undefined; length = 0; callback(error); },
  });
}

function textParts(content) {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.filter(block => block && ['text', 'input_text', 'output_text'].includes(block.type)
    && typeof block.text === 'string' && block.text).map(block => block.text);
}

export function extractSystemPrompt(parsed, protocol) {
  if (!plainObject(parsed)) return null;
  let parts = [];
  if (protocol === 'messages' || protocol === 'anthropic') parts = textParts(parsed.system);
  else if (protocol === 'chat' || protocol === 'responses') {
    if (protocol === 'responses') for (const text of textParts(parsed.instructions)) parts.push(text);
    const messages = protocol === 'chat' ? parsed.messages : parsed.input;
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (message && ['system', 'developer'].includes(message.role)) {
          for (const text of textParts(message.content)) parts.push(text);
        }
      }
    }
  }
  return parts.length ? parts.join('\n') : null;
}

// Process-local only. key must already be a caller fingerprint, never a raw key.
// configure() is authoritative; a stale record(entry, requestConfig) can only
// remove permissions, never re-enable a field disabled by a later configure().
// record() returns a detached projected clone for safe downstream audit callbacks,
// or null when recording is disabled. snapshot totals/grouping honor its IP filter.
export function createRequestAudit() {
  let current = normalizeAuditConfig();
  let ring = new Array(current.maxEntries), start = 0, size = 0;
  function reset() { ring = new Array(current.maxEntries); start = 0; size = 0; }
  function project(entry, config, requestConfig = config) {
    const result = {};
    for (const key of BASE_FIELDS) {
      const value = entry[key];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
    }
    result.time ??= Date.now();
    for (const key of Object.keys(FIELD_DEFAULTS)) {
      if (!config.fields[key] || !requestConfig.fields[key] || !Object.hasOwn(entry, key)) continue;
      const value = entry[key];
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) continue;
      result[key] = key === 'systemPrompt' && typeof value === 'string'
        ? value.slice(0, Math.min(config.maxPromptChars, requestConfig.maxPromptChars)) : value;
    }
    return result;
  }
  function insert(entry) {
    if (size < ring.length) ring[(start + size++) % ring.length] = entry;
    else { ring[start] = entry; start = (start + 1) % ring.length; }
  }
  function configure(config) {
    const next = normalizeAuditConfig(config);
    const previous = [];
    if (next.enabled) {
      for (let index = Math.max(0, size - next.maxEntries); index < size; index++) {
        previous.push(project(ring[(start + index) % ring.length], next));
      }
    }
    current = next;
    reset();
    for (const entry of previous) insert(entry);
  }
  function record(entry, config) {
    if (!current.enabled || !plainObject(entry)) return null;
    const requestConfig = config === undefined ? current : normalizeAuditConfig(config);
    if (!requestConfig.enabled) return null;
    const stored = project(entry, current, requestConfig);
    insert(stored);
    return { ...stored };
  }
  function snapshot({ ip } = {}) {
    const entries = [], grouped = new Map();
    if (current.enabled) {
      for (let index = size - 1; index >= 0; index--) {
        const entry = project(ring[(start + index) % ring.length], current);
        const address = entry.requestIp || '未记录 IP';
        if (ip !== undefined && ip !== address) continue;
        entries.push(entry);
        const group = grouped.get(address) ?? { ip: address, requests: 0, errors: 0 };
        group.requests++;
        if (entry.status >= 400 || (entry.outcome && entry.outcome !== 'success')) group.errors++;
        grouped.set(address, group);
      }
    }
    return { entries, byIp: [...grouped.values()], total: entries.length };
  }
  return { record, snapshot, configure, reset };
}
