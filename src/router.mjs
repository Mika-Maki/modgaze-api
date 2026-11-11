import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import { normalizeRateLimits, normalizeGroupRateLimits, createRequestLimiter } from './rate-limit.mjs';
import { createResponseScope, createResponseObserver } from './response-scope.mjs';
import { createGunzip, createBrotliDecompress, createUnzip } from 'node:zlib';
import { secretRedactor } from './secrets.mjs';
import { normalizeMRExpiresAt } from './key-expiry.mjs';
import { normalizeTokenLimits } from './token-usage.mjs';
import { validateResourceReferences, rejectResourceQuery } from './resource-policy.mjs';
import { normalizeAuditConfig, resolveAuditIp, createAuditObserver, extractSystemPrompt, createRequestAudit } from './request-audit.mjs';

export const PROTOCOLS = ['chat', 'responses', 'messages'];
const FORBIDDEN = ['base_url', 'baseURL', 'baseUrl', 'upstream_url', 'upstreamURL', 'api_base', 'api_key', 'apiKey'];
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const digest = key => createHash('sha256').update(key).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (status, message, type = 'invalid_request_error') => Object.assign(new Error(message), { status, type });
const positive = (n, fallback, name) => {
  if (n === undefined) return fallback;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid ' + name);
  return n;
};

function validateRoute(route, label) {
  if (!object(route)) throw new Error('Invalid route: ' + label);
  let url;
  try { url = new URL(route.baseURL); } catch { throw new Error('Invalid baseURL: ' + label); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Unsafe baseURL: ' + label);
  if (route.auth !== undefined && !['bearer', 'x-api-key'].includes(route.auth)) throw new Error('Invalid route auth: ' + label);
  for (const name of ['project', 'organization']) {
    if (route[name] !== undefined && (typeof route[name] !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(route[name]))) throw new Error('Invalid route ' + name + ': ' + label);
  }
  if (route.upstreamApiKey !== undefined && (typeof route.upstreamApiKey !== 'string' || !route.upstreamApiKey || /[\r\n]/.test(route.upstreamApiKey))) throw new Error('Invalid route upstreamApiKey');
}

export function compileConfig(input) {
  const config = structuredClone(input);
  if (!object(config) || !Array.isArray(config.groups) || !config.groups.length) throw new Error('At least one key group is required');
  config.host ??= '127.0.0.1';
  config.port ??= 8787;
  if (typeof config.host !== 'string' || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid listen address');
  config.maxBodyBytes = positive(config.maxBodyBytes, 64 * 1024 * 1024, 'maxBodyBytes');
  config.maxResponseBytes = positive(config.maxResponseBytes, 256 * 1024 * 1024, 'maxResponseBytes');
  config.rateLimits = normalizeRateLimits(config.rateLimits);
  config.audit = normalizeAuditConfig(config.audit);
  config.requestTimeoutMs = positive(config.requestTimeoutMs, 600000, 'requestTimeoutMs');
  config.upstreamTimeoutMs = positive(config.upstreamTimeoutMs, 120000, 'upstreamTimeoutMs');
  const keys = new Map();
  const secrets = new Set();
  const ids = new Set();
  for (const group of config.groups) {
    if (!object(group) || typeof group.id !== 'string' || !group.id || ids.has(group.id)) throw new Error('Invalid or duplicate group id');
    if (group.enabled !== undefined && typeof group.enabled !== 'boolean') throw new Error('Invalid group enabled flag');
    ids.add(group.id);
    group.rateLimits = normalizeGroupRateLimits(group.rateLimits);
    group.apiKeys ??= [];
    group.virtualApiKeys ??= [];
    if (!Array.isArray(group.apiKeys) || !Array.isArray(group.virtualApiKeys) || (!(group.apiKeys.length + group.virtualApiKeys.length) && group.enabled !== false)) throw new Error('Group requires apiKeys or virtualApiKeys');
    for (const key of [...group.apiKeys, ...group.virtualApiKeys]) {
      if (typeof key !== 'string' || !key || /[\s]/.test(key)) throw new Error('Invalid API key');
      const hash = digest(key);
      if (keys.has(hash)) throw new Error('Duplicate API key across groups; merge routes first');
      // Disabled groups stay in the file (and in redaction) but cannot authenticate.
      if (group.enabled !== false) keys.set(hash, group);
      secrets.add(key);
    }
    group.virtualKeyExpirations = new Map();
    group.virtualKeyTokenLimits = new Map();
    group.virtualKeyUsageIds = new Map();
    if (group.virtualKeyMeta !== undefined && !object(group.virtualKeyMeta)) throw new Error('Invalid MR expiry metadata');
    for (const key of group.virtualApiKeys) {
      const hash = digest(key);
      const meta = group.virtualKeyMeta?.[hash.slice(0, 16)];
      if (meta !== undefined && !object(meta)) throw new Error('Invalid MR expiry metadata');
      const expiry = normalizeMRExpiresAt(meta?.expiresAt);
      if (expiry !== null) group.virtualKeyExpirations.set(hash, Date.parse(expiry));
      group.virtualKeyTokenLimits.set(hash, normalizeTokenLimits(meta?.tokenLimits));
      if (meta?.tokenUsageId !== undefined && (typeof meta.tokenUsageId !== 'string' || !/^[a-f0-9]{64}$/.test(meta.tokenUsageId))) throw new Error('Invalid MR token usage identity');
      group.virtualKeyUsageIds.set(hash, meta?.tokenUsageId ?? hash);
    }
    if (group.upstreamApiKey !== undefined && (typeof group.upstreamApiKey !== 'string' || !group.upstreamApiKey || /[\r\n]/.test(group.upstreamApiKey))) throw new Error('Invalid upstreamApiKey');
    if (group.upstreamApiKey) secrets.add(group.upstreamApiKey);
    if (!object(group.routes ?? {})) throw new Error('Invalid group routes');
    for (const [protocol, route] of Object.entries(group.routes ?? {})) {
      if (!PROTOCOLS.includes(protocol)) throw new Error('Unknown route protocol');
      validateRoute(route, group.id + '/' + protocol);
      if (route.upstreamApiKey) secrets.add(route.upstreamApiKey);
      if (group.virtualApiKeys.length && !route.upstreamApiKey && !group.upstreamApiKey) throw new Error('Virtual API keys require an upstreamApiKey on every group route');
    }
    if (!Array.isArray(group.models) || !group.models.length) throw new Error('Group requires models');
    group.modelIndex = new Map();
    for (const model of group.models) {
      if (!object(model) || typeof model.id !== 'string' || !model.id || group.modelIndex.has(model.id)) throw new Error('Invalid or duplicate model id');
      if (model.maxOutputTokens != null) positive(model.maxOutputTokens, undefined, 'maxOutputTokens');
      if (model.upstreamModel !== undefined && (typeof model.upstreamModel !== 'string' || !model.upstreamModel)) throw new Error('Invalid upstreamModel');
      if (model.defaults !== undefined && !object(model.defaults)) throw new Error('Invalid model defaults');
      for (const [protocol, defaults] of Object.entries(model.defaults ?? {})) {
        if (!PROTOCOLS.includes(protocol) || !object(defaults) || Object.hasOwn(defaults, 'model') || FORBIDDEN.some(k => Object.hasOwn(defaults, k))) throw new Error('Invalid protocol defaults');
      }
      for (const [protocol, route] of Object.entries(model.routes ?? {})) {
        if (!PROTOCOLS.includes(protocol)) throw new Error('Unknown model route protocol');
        validateRoute(route, group.id + '/' + model.id + '/' + protocol);
        if (route.upstreamApiKey) secrets.add(route.upstreamApiKey);
      }
      if (!PROTOCOLS.some(p => model.routes?.[p] || group.routes?.[p])) throw new Error('Model has no available route');
      if (group.virtualApiKeys.length && PROTOCOLS.some(p => (model.routes?.[p] ?? group.routes?.[p]) && !(model.routes?.[p] ?? group.routes?.[p]).upstreamApiKey && !group.upstreamApiKey)) throw new Error('Virtual API keys require an upstreamApiKey on every effective route');
      group.modelIndex.set(model.id, model);
    }
  }
  const virtualKeys = new Set(config.groups.flatMap(g => g.virtualApiKeys));
  for (const g of config.groups) {
    const upstreamKeys = [g.upstreamApiKey, ...Object.values(g.routes ?? {}).map(r => r.upstreamApiKey), ...g.models.flatMap(m => Object.values(m.routes ?? {}).map(r => r.upstreamApiKey))].filter(Boolean);
    if (upstreamKeys.some(k => virtualKeys.has(k))) throw new Error('Upstream credential must not be a virtual API key');
  }
  return { config, keys, secrets: [...secrets] };
}

// API-prefix normalization: /v1 stays /v1; /anthropic becomes /anthropic/v1.
export function upstreamURL(baseURL, endpoint, search = '') {
  const url = new URL(baseURL);
  const prefix = url.pathname.replace(/\/+$/, '');
  const versioned = /\/v\d+(?:beta\d*)?$/.test(prefix);
  url.pathname = prefix + (versioned ? endpoint.slice(3) : endpoint);
  url.search = search;
  return url;
}

function authenticate(req, keys) {
  const auth = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];
  let bearer;
  if (auth !== undefined) {
    const match = /^Bearer ([^\s]+)$/i.exec(auth);
    if (!match) throw fail(401, 'Invalid API key', 'authentication_error');
    bearer = match[1];
  }
  if (bearer && apiKey && bearer !== apiKey) throw fail(401, 'Conflicting API key headers', 'authentication_error');
  const key = bearer ?? apiKey;
  const hash = typeof key === 'string' ? digest(key) : null;
  const group = hash && keys.get(hash);
  if (!group) throw fail(401, 'Invalid API key', 'authentication_error');
  const expiry = group.virtualKeyExpirations.get(hash);
  if (expiry !== undefined && Date.now() >= expiry) throw fail(401, 'MR API key has expired', 'authentication_error');
  return { group, key, keyHash: hash, usageId: group.virtualKeyUsageIds.get(hash) ?? hash, tokenLimits: group.virtualKeyTokenLimits.get(hash) };
}

function modelMetadata(model, group) {
  return {
    id: model.id, object: 'model', created: 0, owned_by: 'modgaze',
    type: 'model', display_name: model.name ?? model.id,
    context_window: model.contextWindow ?? null,
    max_output_tokens: model.maxOutputTokens ?? null,
    input_modalities: model.input ?? null,
    reasoning_efforts: model.reasoningEfforts ?? null,
    available_reasoning_efforts: model.availableReasoningEfforts ?? (model.reasoningEfforts ? Object.keys(model.reasoningEfforts) : null),
    metadata_provenance: model.provenance ?? null,
    metadata_source: model.metadataSource ?? 'configured; not remotely verified',
    supported_endpoints: PROTOCOLS.filter(p => model.routes?.[p] || group.routes?.[p]),
  };
}

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}

function sendError(res, error, anthropic) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  const status = error.status ?? 500;
  if (status === 429 && Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0) res.setHeader('retry-after', String(error.retryAfter));
  const type = error.type ?? (status === 504 ? 'timeout_error' : 'api_error');
  const message = error.status ? error.message : 'Internal router error';
  json(res, status, anthropic ? { type: 'error', error: { type, message } } : { error: { message, type, param: null, code: String(status) } });
}

async function readBody(req, limit, timeoutMs) {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw fail(415, 'Compressed request bodies are not supported');
  if (Number(req.headers['content-length']) > limit) throw fail(413, 'Request body exceeds configured limit');
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => done(fail(408, 'Request body timeout')), timeoutMs);
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const done = (err, value) => { cleanup(); if (err) { req.resume(); reject(err); } else resolve(value); };
    const data = chunk => { size += chunk.length; if (size > limit) done(fail(413, 'Request body exceeds configured limit')); else chunks.push(chunk); };
    const end = () => done(null, Buffer.concat(chunks));
    const error = () => done(fail(400, 'Request body interrupted'));
    const aborted = () => done(fail(400, 'Request aborted'));
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
  });
}

// Recursively fill missing values only. Explicit null, false, zero and arrays win.
function withDefaults(value, defaults) {
  if (!object(defaults) || !object(value)) return value;
  const result = { ...value };
  for (const [key, fallback] of Object.entries(defaults)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (!Object.hasOwn(value, key)) result[key] = structuredClone(fallback);
    else if (object(value[key]) && object(fallback)) result[key] = withDefaults(value[key], fallback);
  }
  return result;
}

function endpointFor(method, path) {
  if (method === 'POST') {
    if (['/v1/chat/completions', '/v1/completions'].includes(path)) return { protocol: 'chat', needsModel: true };
    if (['/v1/responses', '/v1/responses/compact'].includes(path)) return { protocol: 'responses', needsModel: true };
    if (['/v1/messages', '/v1/messages/count_tokens'].includes(path)) return { protocol: 'messages', needsModel: true };
  }
  if ((['GET', 'DELETE'].includes(method) && /^\/v1\/responses\/[a-zA-Z0-9_-]+$/.test(path)) || (method === 'GET' && /^\/v1\/responses\/[a-zA-Z0-9_-]+\/input_items$/.test(path)) || (method === 'POST' && /^\/v1\/responses\/[a-zA-Z0-9_-]+\/cancel$/.test(path))) return { protocol: 'responses', needsModel: false };
  throw fail(404, 'Unknown API endpoint', 'not_found_error');
}

function routeFingerprint(route, group, key) {
  return digest(JSON.stringify([new URL(route.baseURL).href, route.auth ?? 'bearer', digest(route.upstreamApiKey ?? group.upstreamApiKey ?? key), route.project ?? null, route.organization ?? null]));
}

function capOutputTokens(parsed, model, protocol, path) {
  const fields = protocol === 'responses' ? ['max_output_tokens'] : protocol === 'messages' ? ['max_tokens'] : ['max_tokens', 'max_completion_tokens'];
  for (const field of fields) {
    if (model.maxOutputTokens == null && parsed[field] === null) continue;
    if (Object.hasOwn(parsed, field) && (!Number.isSafeInteger(parsed[field]) || parsed[field] <= 0 || (model.maxOutputTokens != null && parsed[field] > model.maxOutputTokens))) throw fail(400, field + ' must be a positive integer within the configured output limit');
  }
  if (model.maxOutputTokens != null && !path.endsWith('/count_tokens') && !path.endsWith('/compact') && !fields.some(field => Object.hasOwn(parsed, field))) {
    return { ...parsed, [protocol === 'chat' && path === '/v1/chat/completions' ? 'max_completion_tokens' : fields[0]]: model.maxOutputTokens };
  }
  return parsed;
}

function validateReferences(parsed, protocol, allowPrevious, checkPrevious) {
  validateResourceReferences(parsed, protocol);
  // Only protocol-level fields carry object authority. Tool schemas, metadata,
  // and user JSON with similarly named properties are ordinary opaque data.
  for (const [name, value] of Object.entries(parsed)) {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.startsWith('conversation') && value !== null) throw fail(400, 'Conversation references are not supported');
    if (normalized === 'previousresponseid' && value !== null) {
      if (name !== 'previous_response_id' || protocol !== 'responses' || !allowPrevious) throw fail(400, 'Response references are not supported here');
      checkPrevious(value);
    }
    if (normalized === 'responseid' && value !== null) throw fail(400, 'Untracked response references are not supported');
  }
}

function proxy(req, res, target, body, route, group, key, protocol, config, anthropic, deadline, redact, { owner, observeId, deleted, markError, observeUsage }) {
  return new Promise(resolve => {
    const headers = { 'accept-encoding': 'identity' };
    const connectionHeaders = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map(x => x.trim()));
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP.has(name) || connectionHeaders.has(name) || value === undefined) continue;
      if (['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'idempotency-key', 'x-request-id'].includes(name) || name.startsWith('x-stainless-')) headers[name] = Array.isArray(value) ? value.map(v => redact.text(v)) : redact.text(value);
    }
    if (headers['idempotency-key'] !== undefined) headers['idempotency-key'] = digest(JSON.stringify([owner, headers['idempotency-key']]));
    for (const name of ['project', 'organization']) if (route[name] !== undefined) headers['openai-' + name] = route[name];
    const upstreamKey = route.upstreamApiKey ?? group.upstreamApiKey ?? key;
    if ((route.auth ?? (protocol === 'messages' ? 'x-api-key' : 'bearer')) === 'x-api-key') headers['x-api-key'] = upstreamKey;
    else headers.authorization = 'Bearer ' + upstreamKey;
    if (protocol === 'messages') headers['anthropic-version'] ??= '2023-06-01';
    if (body !== undefined) { headers['content-type'] ??= 'application/json'; headers['content-length'] = body.length; }
    let finished = false;
    let incoming;
    let timer;
    const remaining = () => Math.max(1, deadline - Date.now());
    const idleTimeoutMs = Math.min(config.upstreamTimeoutMs, remaining());
    // Set the initial socket timeout too: request.setTimeout() only applies
    // after connect, leaving slow DNS under the global Agent's 5s default.
    const outgoing = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers, timeout: idleTimeoutMs });
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); res.off('close', disconnected); resolve(); };
    const disconnected = () => { outgoing.destroy(); incoming?.destroy(); finish(); };
    const failed = error => { if (finished) return; markError(error); sendError(res, error, anthropic); outgoing.destroy(); incoming?.destroy(); finish(); };
    res.on('close', disconnected);
    outgoing.on('error', () => { if (!finished) failed(fail(502, 'Upstream connection failed', 'api_error')); });
    outgoing.setTimeout(idleTimeoutMs, () => failed(fail(504, 'Upstream idle timeout', 'timeout_error')));
    timer = setTimeout(() => failed(fail(504, 'Upstream request deadline exceeded', 'timeout_error')), remaining());
    outgoing.on('response', upstream => {
      incoming = upstream;
      upstream.once('aborted', () => { if (!finished) markError(fail(502, 'Upstream response interrupted', 'api_error')); });
      if (finished) { upstream.destroy(); return; }
      // Never follow redirects or expose their internal Location target.
      if (upstream.statusCode >= 300 && upstream.statusCode < 400) { failed(fail(502, 'Upstream redirect rejected', 'api_error')); return; }
      const responseHeaders = {};
      const excluded = new Set(String(upstream.headers.connection ?? '').toLowerCase().split(',').map(x => x.trim()));
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (HOP.has(name) || excluded.has(name) || ['set-cookie', 'location', 'server', 'x-powered-by', 'via'].includes(name) || value === undefined) continue;
        if (['content-type', 'content-encoding', 'retry-after', 'request-id', 'x-request-id', 'openai-processing-ms', 'openai-version'].includes(name) || name.startsWith('x-ratelimit-') || name.startsWith('anthropic-ratelimit-')) responseHeaders[name] = Array.isArray(value) ? value.map(v => redact.text(v)) : redact.text(value);
      }
      const encoding = String(upstream.headers['content-encoding'] ?? 'identity').toLowerCase();
      const decoders = [];
      if (encoding !== 'identity') {
        if (encoding === 'gzip') decoders.push(createGunzip());
        else if (encoding === 'deflate') decoders.push(createUnzip());
        else if (encoding === 'br') decoders.push(createBrotliDecompress());
        else { failed(fail(502, 'Unsupported upstream content encoding', 'api_error')); return; }
        delete responseHeaders['content-encoding'];
      }
      for (const decoder of decoders) decoder.once('error', () => markError(fail(502, 'Invalid upstream compressed response', 'api_error')));
      let size = 0;
      const guard = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > config.maxResponseBytes) {
          const error = fail(502, 'Upstream response exceeds configured decompressed limit', 'response_limit_error');
          markError(error); callback(error);
        } else callback(null, chunk);
      } });
      const observers = observeId && upstream.statusCode >= 200 && upstream.statusCode < 300 ? [createResponseObserver(String(upstream.headers['content-type'] ?? ''), observeId)] : [];
      if (observeUsage) observers.push(createAuditObserver(String(upstream.headers['content-type'] ?? ''), observeUsage, { tokenUsage: true, protocol }));
      responseHeaders['cache-control'] = 'no-store';
      responseHeaders['x-accel-buffering'] = 'no';
      res.writeHead(upstream.statusCode, responseHeaders);
      res.flushHeaders();
      // Transform/pipeline preserve SSE streaming and propagate client backpressure.
      pipeline(upstream, ...decoders, guard, ...observers, redact.stream(), res, error => {
        if (error && !finished && !res.writableFinished && !req.aborted) markError(fail(502, 'Upstream response interrupted', 'api_error'));
        if (!error && upstream.statusCode >= 200 && upstream.statusCode < 300) deleted?.();
        finish();
      });
    });
    outgoing.end(body);
  });
}

function compileState(input, previous) {
  const { config, keys, secrets } = compileConfig(input);
  const secretSet = new Set(secrets);
  const unchanged = previous && previous.secretSet.size === secretSet.size && secrets.every(value => previous.secretSet.has(value));
  return { config, keys, secrets, secretSet, redact: unchanged ? previous.redact : secretRedactor(secrets) };
}

function applyTimeouts(server, config) {
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(60000, config.requestTimeoutMs);
}

export function createRouter(input, { logger = () => {}, onRequest, onAudit, tokenUsageStore, onTokenUsageError = () => console.error(JSON.stringify({ event: 'token_usage_error' })) } = {}) {
  let state = compileState(input);
  let usageUnavailable = false;
  function usageFailed() {
    usageUnavailable = true;
    try { onTokenUsageError(); } catch {}
  }
  const requestAudit = createRequestAudit();
  requestAudit.configure(state.config.audit);
  // Keep admission/RPM and ownership state across reload; never infer old owners.
  const limiter = createRequestLimiter();
  const responseScope = createResponseScope();
  const server = http.createServer(async (req, res) => {
    const snapshot = state;
    const { config, keys, redact } = snapshot;
    const requestId = randomUUID();
    const started = Date.now();
    let protocol;
    let groupId = null;
    let authKind = null;
    let modelId = null;
    let usageKeyId = null;
    let observedUsage;
    const auditFields = {};
    if (config.audit.enabled && config.audit.fields.requestIp) auditFields.requestIp = resolveAuditIp(req, config.audit);
    let release;
    let terminal = false;
    let terminalError;
    const markError = error => { terminalError ??= error; };
    res.setHeader('x-request-id', requestId);
    // finish and close can both fire. Every request releases and reports once,
    // including clients that disconnect before a response has been generated.
    const finalize = () => {
      if (terminal) return;
      terminal = true;
      release?.();
      const aborted = !res.writableFinished && !terminalError;
      const status = aborted ? 499 : terminalError?.status ?? res.statusCode;
      const outcome = aborted ? 'aborted' : terminalError?.type ?? (status >= 400 ? 'error' : 'success');
      const duration = Date.now() - started;
      if (tokenUsageStore && usageKeyId && observedUsage) {
        const usage = Object.fromEntries(['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens']
          .filter(field => Object.hasOwn(observedUsage, field)).map(field => [field, observedUsage[field]]));
        if (Object.keys(usage).length) {
          try { Promise.resolve(tokenUsageStore.record({ requestId, keyId: usageKeyId, group: groupId, usage, time: Date.now() })).catch(usageFailed); }
          catch { usageFailed(); }
        }
      }
      try { logger({ event: 'request', request_id: requestId, method: req.method, protocol: protocol ?? 'local', status, outcome, duration_ms: duration }); } catch {}
      try { onRequest?.({ requestId, method: req.method, protocol: protocol ?? 'local', status, outcome, durationMs: duration, group: groupId, model: modelId, auth: authKind }); } catch {}
      if (config.audit.enabled) {
        if (config.audit.fields.model) auditFields.model = modelId == null ? null : redact.text(modelId);
        if (config.audit.fields.group) auditFields.group = groupId == null ? null : redact.text(groupId);
        const entry = requestAudit.record({ time: Date.now(), requestId, method: req.method, protocol: protocol ?? 'local', status, outcome, durationMs: duration, ...auditFields }, config.audit);
        if (entry) { try { onAudit?.(entry); } catch {} }
      }
    };
    res.once('finish', finalize);
    res.once('close', finalize);
    let anthropic = false;
    try {
      const deadline = Date.now() + config.requestTimeoutMs;
      const url = new URL(req.url, 'http://localhost');
      anthropic = url.pathname.startsWith('/v1/messages');
      if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { status: 'ok' }); return; }
      const { group, key, keyHash, usageId, tokenLimits } = authenticate(req, keys);
      groupId = group.id;
      authKind = group.virtualApiKeys.includes(key) ? 'virtual' : 'apiKey';
      usageKeyId = usageId;
      if (config.audit.enabled && config.audit.fields.key) auditFields.key = keyHash.slice(0, 16);
      const owner = digest(JSON.stringify([group.id, keyHash]));
      const limits = config.rateLimits.api;
      release = limiter.acquire([
        { id: 'api', maxConcurrent: limits.maxConcurrent, rpm: limits.rpm },
        { id: 'api:key:' + keyHash, maxConcurrent: limits.perKeyMaxConcurrent, rpm: limits.perKeyRpm },
        { id: 'api:group:' + group.id, ...group.rateLimits },
      ]);
      if (terminal || res.destroyed || req.aborted) { release(); return; }
      if (FORBIDDEN.some(k => url.searchParams.has(k))) throw fail(400, 'Upstream routing parameters are not accepted');
      for (const name of url.searchParams.keys()) {
        rejectResourceQuery(name);
        const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (/previousresponse|conversation|responseid/.test(normalized)) throw fail(400, 'Object references are not accepted in query parameters');
      }
      if (req.method !== 'POST' && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])) throw fail(400, 'This endpoint does not accept a request body');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const data = group.models.map(model => JSON.parse(redact.text(JSON.stringify(modelMetadata(model, group)))));
        json(res, 200, { object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
        let id;
        try { id = decodeURIComponent(url.pathname.slice('/v1/models/'.length)); } catch { throw fail(400, 'Invalid model ID encoding'); }
        const model = group.modelIndex.get(id);
        if (!model) throw fail(404, 'Model not available for this API key', 'not_found_error');
        modelId = model.id;
        json(res, 200, JSON.parse(redact.text(JSON.stringify(modelMetadata(model, group))))); return;
      }
      const endpoint = endpointFor(req.method, url.pathname);
      protocol = endpoint.protocol;
      let body;
      let model;
      let parsed;
      if (req.method === 'POST') {
        body = await readBody(req, config.maxBodyBytes, Math.max(1, deadline - Date.now()));
        if (body.length || endpoint.needsModel) {
          try { parsed = JSON.parse(body.toString('utf8')); } catch { throw fail(400, 'Invalid JSON request body'); }
          if (!object(parsed)) throw fail(400, 'Request body must be an object');
          if (FORBIDDEN.some(k => Object.hasOwn(parsed, k))) throw fail(400, 'Upstream routing parameters are not accepted');
          if (endpoint.needsModel) {
            if (typeof parsed.model !== 'string' || !parsed.model) throw fail(400, 'model must be a non-empty string');
            model = group.modelIndex.get(parsed.model);
            if (!model) throw fail(404, 'Model not available for this API key', 'not_found_error');
            modelId = model.id;
            if (model.defaults?.[protocol]) parsed = withDefaults(parsed, model.defaults[protocol]);
            parsed = capOutputTokens(parsed, model, protocol, url.pathname);
            if (model.upstreamModel) parsed = { ...parsed, model: model.upstreamModel };
          }
        }
      }
      let resourceId;
      let route;
      if (!endpoint.needsModel) {
        resourceId = url.pathname.split('/')[3];
        const binding = responseScope.require(owner, resourceId);
        model = group.modelIndex.get(binding.modelId);
        modelId = model?.id ?? null;
        route = model?.routes?.[protocol] ?? (model && group.routes?.[protocol]);
        if (!route || routeFingerprint(route, group, key) !== binding.fingerprint) throw fail(404, 'Response not available for this API key and route', 'not_found_error');
      } else route = model.routes?.[protocol] ?? group.routes?.[protocol];
      if (!route) throw fail(400, 'Protocol is not configured for this model and API key');
      const fingerprint = routeFingerprint(route, group, key);
      if (parsed) {
        validateReferences(parsed, protocol, endpoint.needsModel, previousId => {
          const binding = responseScope.require(owner, previousId);
          const previousModel = group.modelIndex.get(binding.modelId);
          const previousRoute = previousModel?.routes?.[protocol] ?? (previousModel && group.routes?.[protocol]);
          if (!previousRoute || routeFingerprint(previousRoute, group, key) !== binding.fingerprint || binding.fingerprint !== fingerprint) throw fail(404, 'Response not available for this API key and route', 'not_found_error');
        });
        if (!endpoint.needsModel && Object.keys(parsed).length) throw fail(400, 'Response cancel does not accept request parameters');
        // Canonicalize validated JSON, including unchanged requests: duplicate
        // model/token/reference keys must not be interpreted differently upstream.
        body = Buffer.from(JSON.stringify(parsed));
        if (config.audit.enabled && config.audit.fields.systemPrompt) {
          const prompt = extractSystemPrompt(parsed, protocol);
          auditFields.systemPrompt = prompt == null ? null : redact.text(prompt).slice(0, config.audit.maxPromptChars);
        }
      }
      if (res.destroyed || req.aborted) return;
      if (tokenLimits && Object.values(tokenLimits).some(value => value > 0)) {
        if (!tokenUsageStore || usageUnavailable) throw fail(503, 'Token usage accounting is unavailable', 'token_usage_unavailable');
        await tokenUsageStore.check(usageId, tokenLimits);
        if (res.destroyed || req.aborted) return;
      }
      await proxy(req, res, upstreamURL(route.baseURL, url.pathname, url.search), body, route, group, key, protocol, config, anthropic, deadline, redact, {
        owner, markError,
        observeUsage: tokenUsageStore || (config.audit.enabled && ['inputTokens', 'outputTokens', 'reasoningTokens'].some(field => config.audit.fields[field])) ? usage => {
          observedUsage = usage;
          for (const field of ['inputTokens', 'outputTokens', 'reasoningTokens']) {
            if (config.audit.fields[field] && Object.hasOwn(usage, field)) auditFields[field] = usage[field];
          }
        } : undefined,
        observeId: protocol === 'responses' && url.pathname === '/v1/responses' ? id => responseScope.remember(owner, id, { modelId: model.id, fingerprint }) : undefined,
        deleted: resourceId && req.method === 'DELETE' ? () => responseScope.forget(owner, resourceId) : undefined,
      });
    } catch (error) { markError(error); req.resume(); sendError(res, error, anthropic); }
  });
  applyTimeouts(server, state.config);
  server.keepAliveTimeout = 5000;
  server.requestAudit = requestAudit;
  // In-flight requests retain their immutable routing/credential snapshot.
  server.reload = nextInput => {
    const next = compileState(nextInput, state);
    state = next;
    requestAudit.configure(next.config.audit);
    applyTimeouts(server, next.config);
    return { groups: next.config.groups.length, models: next.config.groups.reduce((total, group) => total + group.models.length, 0), compiled: next.config };
  };
  return server;
}
