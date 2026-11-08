import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream';
import { createGunzip, createBrotliDecompress, createUnzip } from 'node:zlib';
import { secretRedactor } from './secrets.mjs';

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
  if (route.upstreamApiKey !== undefined && (typeof route.upstreamApiKey !== 'string' || !route.upstreamApiKey || /[\r\n]/.test(route.upstreamApiKey))) throw new Error('Invalid route upstreamApiKey');
}

export function compileConfig(input) {
  const config = structuredClone(input);
  if (!object(config) || !Array.isArray(config.groups) || !config.groups.length) throw new Error('At least one key group is required');
  config.host ??= '127.0.0.1';
  config.port ??= 8787;
  if (typeof config.host !== 'string' || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid listen address');
  config.maxBodyBytes = positive(config.maxBodyBytes, 64 * 1024 * 1024, 'maxBodyBytes');
  config.requestTimeoutMs = positive(config.requestTimeoutMs, 600000, 'requestTimeoutMs');
  config.upstreamTimeoutMs = positive(config.upstreamTimeoutMs, 120000, 'upstreamTimeoutMs');
  const keys = new Map();
  const secrets = new Set();
  const ids = new Set();
  for (const group of config.groups) {
    if (!object(group) || typeof group.id !== 'string' || !group.id || ids.has(group.id)) throw new Error('Invalid or duplicate group id');
    if (group.enabled !== undefined && typeof group.enabled !== 'boolean') throw new Error('Invalid group enabled flag');
    ids.add(group.id);
    group.apiKeys ??= [];
    group.virtualApiKeys ??= [];
    if (!Array.isArray(group.apiKeys) || !Array.isArray(group.virtualApiKeys) || !(group.apiKeys.length + group.virtualApiKeys.length)) throw new Error('Group requires apiKeys or virtualApiKeys');
    for (const key of [...group.apiKeys, ...group.virtualApiKeys]) {
      if (typeof key !== 'string' || !key || /[\s]/.test(key)) throw new Error('Invalid API key');
      const hash = digest(key);
      if (keys.has(hash)) throw new Error('Duplicate API key across groups; merge routes first');
      // Disabled groups stay in the file (and in redaction) but cannot authenticate.
      if (group.enabled !== false) keys.set(hash, group);
      secrets.add(key);
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
  const group = typeof key === 'string' && keys.get(digest(key));
  if (!group) throw fail(401, 'Invalid API key', 'authentication_error');
  return { group, key };
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

function proxy(req, res, target, body, route, group, key, protocol, config, anthropic, deadline, redact) {
  return new Promise(resolve => {
    const headers = { 'accept-encoding': 'identity' };
    const connectionHeaders = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map(x => x.trim()));
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP.has(name) || connectionHeaders.has(name) || value === undefined) continue;
      if (['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'openai-organization', 'openai-project', 'idempotency-key', 'x-request-id'].includes(name) || name.startsWith('x-stainless-')) headers[name] = Array.isArray(value) ? value.map(v => redact.text(v)) : redact.text(value);
    }
    const upstreamKey = route.upstreamApiKey ?? group.upstreamApiKey ?? key;
    if ((route.auth ?? (protocol === 'messages' ? 'x-api-key' : 'bearer')) === 'x-api-key') headers['x-api-key'] = upstreamKey;
    else headers.authorization = 'Bearer ' + upstreamKey;
    if (protocol === 'messages') headers['anthropic-version'] ??= '2023-06-01';
    if (body !== undefined) { headers['content-type'] ??= 'application/json'; headers['content-length'] = body.length; }
    let finished = false;
    let incoming;
    let timer;
    const outgoing = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers });
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); res.off('close', disconnected); resolve(); };
    const disconnected = () => { outgoing.destroy(); incoming?.destroy(); finish(); };
    const failed = error => { sendError(res, error, anthropic); outgoing.destroy(); incoming?.destroy(); finish(); };
    res.on('close', disconnected);
    outgoing.on('error', () => { if (!finished) failed(fail(502, 'Upstream connection failed', 'api_error')); });
    const remaining = () => Math.max(1, deadline - Date.now());
    outgoing.setTimeout(Math.min(config.upstreamTimeoutMs, remaining()), () => failed(fail(504, 'Upstream idle timeout', 'timeout_error')));
    timer = setTimeout(() => failed(fail(504, 'Upstream request deadline exceeded', 'timeout_error')), remaining());
    outgoing.on('response', upstream => {
      incoming = upstream;
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
      responseHeaders['cache-control'] = 'no-store';
      responseHeaders['x-accel-buffering'] = 'no';
      res.writeHead(upstream.statusCode, responseHeaders);
      res.flushHeaders();
      // Byte-preserving unless an exact configured credential is found, across chunks too.
      pipeline(upstream, ...decoders, redact.stream(), res, () => finish());
    });
    outgoing.end(body);
  });
}

function compileState(input) {
  const { config, keys, secrets } = compileConfig(input);
  return { config, keys, secrets, redact: secretRedactor(secrets) };
}

function applyTimeouts(server, config) {
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(60000, config.requestTimeoutMs);
}

export function createRouter(input, { logger = () => {}, onRequest } = {}) {
  let state = compileState(input);
  const server = http.createServer(async (req, res) => {
    const snapshot = state;
    const { config, keys, redact } = snapshot;
    const requestId = randomUUID();
    const started = Date.now();
    let protocol;
    let groupId = null;
    let authKind = null;
    let modelId = null;
    res.setHeader('x-request-id', requestId);
    // Access logs intentionally omit URL/query, key, model, body and upstream identity.
    res.once('finish', () => {
      try { logger({ event: 'request', request_id: requestId, method: req.method, protocol: protocol ?? 'local', status: res.statusCode, duration_ms: Date.now() - started }); } catch {}
      try {
        onRequest?.({
          requestId, method: req.method, protocol: protocol ?? 'local', status: res.statusCode,
          durationMs: Date.now() - started, group: groupId, model: modelId, auth: authKind,
        });
      } catch {}
    });
    let anthropic = false;
    try {
      const deadline = Date.now() + config.requestTimeoutMs;
      const url = new URL(req.url, 'http://localhost');
      anthropic = url.pathname.startsWith('/v1/messages');
      if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { status: 'ok' }); return; }
      const { group, key } = authenticate(req, keys);
      groupId = group.id;
      authKind = group.virtualApiKeys.includes(key) ? 'virtual' : 'apiKey';
      if (FORBIDDEN.some(k => url.searchParams.has(k))) throw fail(400, 'Upstream routing parameters are not accepted');
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
      if (req.method === 'POST') {
        body = await readBody(req, config.maxBodyBytes, Math.max(1, deadline - Date.now()));
        if (body.length || endpoint.needsModel) {
          let parsed;
          try { parsed = JSON.parse(body.toString('utf8')); } catch { throw fail(400, 'Invalid JSON request body'); }
          if (!object(parsed)) throw fail(400, 'Request body must be an object');
          if (FORBIDDEN.some(k => Object.hasOwn(parsed, k))) throw fail(400, 'Upstream routing parameters are not accepted');
          if (endpoint.needsModel) {
            if (typeof parsed.model !== 'string' || !parsed.model) throw fail(400, 'model must be a non-empty string');
            model = group.modelIndex.get(parsed.model);
            if (!model) throw fail(404, 'Model not available for this API key', 'not_found_error');
            modelId = model.id;
            if (model.defaults?.[protocol] || model.upstreamModel) {
              parsed = withDefaults(parsed, model.defaults?.[protocol]);
              if (model.upstreamModel) parsed.model = model.upstreamModel;
              body = Buffer.from(JSON.stringify(parsed));
            }
          }
        }
      }
      let route = model?.routes?.[protocol] ?? group.routes?.[protocol];
      if (!model && !group.routes?.[protocol]) {
        // Without a group route, lifecycle requests may infer only one model target.
        const routes = group.models.map(m => m.routes?.[protocol]).filter(Boolean);
        const unique = new Map(routes.map(r => [JSON.stringify([r.baseURL, r.auth, r.upstreamApiKey]), r]));
        if (unique.size > 1) throw fail(400, 'Response lifecycle is ambiguous for this key group');
        route = unique.values().next().value;
      }
      if (!route) throw fail(400, 'Protocol is not configured for this model and API key');
      if (res.destroyed || req.aborted) return;
      await proxy(req, res, upstreamURL(route.baseURL, url.pathname, url.search), body, route, group, key, protocol, config, anthropic, deadline, redact);
    } catch (error) { req.resume(); sendError(res, error, anthropic); }
  });
  applyTimeouts(server, state.config);
  server.keepAliveTimeout = 5000;
  // Hot swap compiled configuration for requests that start after this call.
  // In-flight requests keep their immutable snapshot and redactor.
  server.reload = nextInput => {
    const next = compileState(nextInput);
    state = next;
    applyTimeouts(server, next.config);
    return {
      groups: next.config.groups.length,
      models: next.config.groups.reduce((total, group) => total + group.models.length, 0),
      compiled: next.config,
    };
  };
  return server;
}
