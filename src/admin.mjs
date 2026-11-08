import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import {
  ADMIN_PASSWORD_MIN_LENGTH, AdminAuth, assertPassword, generatePassword,
} from './admin-auth.mjs';
import {
  ConfigStore, HttpError, httpError, assertGroupId, assertLabel, assertModelId, assertNote,
  assertSafeKeys, findKeyEntry, friendlyError, groupById,
  normalizeModel, normalizeRoute, normalizeSecret, recordKeyMeta, removeKeyMeta, resolvedGroupById,
  sanitizeGroup, sanitizeSettings, setKeyLabel,
} from './admin-store.mjs';
import { PROTOCOLS, upstreamURL } from './router.mjs';
import { createMetrics } from './metrics.mjs';
import { readBackup as readBackupFile, validateConfig } from './config.mjs';
import { secretRedactor } from './secrets.mjs';

const COOKIE_NAME = 'mr_admin_session';
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const BODY_LIMIT = 8 * 1024 * 1024;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const round = value => Math.round(value);

const PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { value = decodeURIComponent(value); } catch {}
    cookies[name] = value;
  }
  return cookies;
}

function setSessionCookie(res, raw, maxAge = Math.floor(SESSION_ABSOLUTE_MS / 1000)) {
  res.setHeader('set-cookie', COOKIE_NAME + '=' + raw + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge);
}

function clearSessionCookie(res) {
  res.setHeader('set-cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(bytes);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const bytes = Buffer.from(text);
  res.writeHead(status, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(bytes);
}

async function readJson(req, limit = BODY_LIMIT) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw httpError(415, '请求必须使用 application/json');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw httpError(413, '请求体过大');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!size) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, '请求体不是合法 JSON'); }
  if (!isObject(parsed)) throw httpError(400, '请求体必须是 JSON 对象');
  assertSafeKeys(parsed);
  return parsed;
}

function decodeSegment(value) {
  try { return decodeURIComponent(value); }
  catch { throw httpError(400, 'URL 编码无效'); }
}

function assertProtocol(protocol) {
  if (!PROTOCOLS.includes(protocol)) throw httpError(400, '未知协议：' + protocol);
  return protocol;
}

function modelFrom(value) {
  return typeof value === 'string' ? { id: value } : value;
}

function addAccessKey(group, field, value, label) {
  const normalized = normalizeSecret(value, '访问密钥');
  if (!normalized) throw httpError(400, '访问密钥不能为空');
  group[field] ??= [];
  group[field].push(normalized);
  if (typeof normalized === 'string') recordKeyMeta(group, field, normalized, label);
  else if (process.env[normalized.env]) recordKeyMeta(group, field, process.env[normalized.env], label);
}

function addGeneratedVirtualKey(group, label = '默认密钥') {
  const key = 'mr-' + randomBytes(32).toString('hex');
  group.virtualApiKeys ??= [];
  group.virtualApiKeys.push(key);
  recordKeyMeta(group, 'virtualApiKeys', key, label);
  return key;
}

function keyCount(group) {
  return (group.apiKeys?.length ?? 0) + (group.virtualApiKeys?.length ?? 0);
}

function fileToDisplay(projectRoot, path) {
  if (!path) return null;
  if (path.startsWith(projectRoot)) return path.slice(projectRoot.length).replace(/^\/+/, '');
  return path;
}

export async function createAdmin(options = {}) {
  const configPath = resolve(options.configPath ?? 'config/local.json');
  const runDir = resolve(options.runDir ?? 'run');
  const projectRoot = resolve(options.projectRoot ?? fileURLToPath(new URL('../', import.meta.url)));
  const publicDir = resolve(options.publicDir ?? fileURLToPath(new URL('../public/', import.meta.url)));
  const adminPort = Number(options.adminPort ?? 8788);
  const authPath = resolve(options.authPath ?? join(dirname(configPath), 'admin-auth.private.json'));
  const backupDir = join(runDir, 'backups');
  const routerPort = typeof options.routerPort === 'function' ? options.routerPort : () => options.routerPort;
  const reload = options.reload ?? (async () => {});
  const metrics = options.metrics ?? createMetrics();
  const auth = new AdminAuth(authPath);
  const store = new ConfigStore({ configPath, backupDir, reload });
  const startedAt = Date.now();
  const audit = [];
  const sessions = new Map();
  let authFingerprint;
  let rate = { failures: 0, firstAt: 0, blockedUntil: 0 };
  let indexHtml = '';
  try { indexHtml = await readFile(join(publicDir, 'index.html'), 'utf8'); } catch {}

  const loginGate = () => {
    const now = Date.now();
    if (rate.blockedUntil > now) {
      const wait = Math.ceil((rate.blockedUntil - now) / 1000);
      const error = httpError(429, '尝试次数过多，请在 ' + wait + ' 秒后重试');
      error.retryAfter = wait;
      throw error;
    }
  };
  const loginFailed = () => {
    const now = Date.now();
    if (!rate.firstAt || now - rate.firstAt > 10 * 60 * 1000) { rate.firstAt = now; rate.failures = 0; }
    rate.failures += 1;
    if (rate.failures >= 5) {
      rate.blockedUntil = now + Math.min(15 * 60 * 1000, 60000 * 2 ** (rate.failures - 5));
    }
  };
  const loginSucceeded = () => { rate = { failures: 0, firstAt: 0, blockedUntil: 0 }; };

  function auditEvent(action, target, ok = true, detail = null) {
    audit.unshift({ time: Date.now(), action, target, ok, detail: detail == null ? null : String(detail).slice(0, 300) });
    if (audit.length > 250) audit.length = 250;
  }

  function createSession() {
    const raw = randomBytes(32).toString('hex');
    const record = {
      csrf: randomBytes(32).toString('hex'),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      expiresAt: Math.min(Date.now() + SESSION_ABSOLUTE_MS, Date.now() + SESSION_IDLE_MS),
    };
    sessions.set(digest(raw), record);
    return { raw, ...record, maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000) };
  }

  function sessionFromRequest(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) return null;
    const hash = digest(raw);
    const record = sessions.get(hash);
    if (!record) return null;
    const now = Date.now();
    if (now > record.expiresAt || now - record.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(hash);
      return null;
    }
    record.lastSeen = now;
    record.expiresAt = Math.min(record.createdAt + SESSION_ABSOLUTE_MS, now + SESSION_IDLE_MS);
    return { raw, hash, record };
  }

  function destroySession(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (raw) sessions.delete(digest(raw));
  }

  async function authState() {
    try {
      const current = await auth.status();
      if (current.fingerprint !== authFingerprint) {
        sessions.clear();
        authFingerprint = current.fingerprint;
      }
      return { ...current, error: null };
    } catch (error) {
      sessions.clear();
      authFingerprint = null;
      const friendly = friendlyError(error);
      return { configured: true, error: friendly.message, detail: friendly.detail ?? null };
    }
  }

  async function authContextFor(req) {
    const current = await authState();
    const session = current.configured && !current.error ? sessionFromRequest(req) : null;
    return { current, session };
  }

  function requireSession(req) {
    const session = sessionFromRequest(req);
    if (!session) {
      const error = httpError(401, '登录状态已失效，请重新登录');
      error.code = 'unauthorized';
      throw error;
    }
    return session;
  }

  async function serviceStatus() {
    try {
      const state = JSON.parse(await readFile(join(runDir, 'service.json'), 'utf8'));
      if (!Number.isSafeInteger(state.pid) || state.pid <= 1) return { running: false, pid: null, managed: false };
      let alive = true;
      try { process.kill(state.pid, 0); } catch { alive = false; }
      return { running: alive, pid: state.pid, managed: alive && state.pid === process.pid, start: state.start ?? null };
    } catch { return { running: false, pid: null, managed: false }; }
  }

  function runtimeInfo() {
    return {
      pid: process.pid,
      node: process.version,
      version: PACKAGE.version,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      memoryMB: round(process.memoryUsage().rss / 1048576),
      adminPort: currentAdminPort(),
      routerPort: routerPort(),
      configPath,
      configDisplay: fileToDisplay(projectRoot, configPath),
      authFile: authPath,
      authDisplay: fileToDisplay(projectRoot, authPath),
      runDir,
      runDisplay: fileToDisplay(projectRoot, runDir),
    };
  }

  function currentAdminPort() {
    try { return server.address()?.port ?? adminPort; } catch { return adminPort; }
  }

  function allowedHosts(port) {
    return new Set(['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]);
  }

  function allowedOrigins(port) {
    return new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port]);
  }

  function assertTrustedRequest(req) {
    const port = currentAdminPort();
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts(port).has(host)) throw httpError(403, '非法的 Host 请求头');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins(port).has(String(origin))) throw httpError(403, '非法的请求来源');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, '拒绝跨站请求');
  }

  function groupPayload(result, id) {
    const rawGroup = result.raw.groups.find(group => group.id === id);
    if (!rawGroup) return null;
    const resolvedGroup = resolvedGroupById(result.resolved, id) ?? rawGroup;
    return sanitizeGroup(rawGroup, resolvedGroup);
  }

  async function statePayload() {
    const snapshot = await store.read();
    const groups = snapshot.raw.groups.map(rawGroup => sanitizeGroup(rawGroup, resolvedGroupById(snapshot.resolved, rawGroup.id) ?? rawGroup));
    const service = await serviceStatus();
    const backups = await store.listBackups();
    const runtime = runtimeInfo();
    runtime.service = service;
    return {
      ok: true,
      now: Date.now(),
      version: PACKAGE.version,
      runtime,
      service,
      settings: sanitizeSettings(snapshot.raw, snapshot.compiled, runtime),
      summary: snapshot.summary,
      groups,
      stats: metrics.snapshot(),
      recentAudit: audit.slice(0, 100),
      backups,
      limits: {
        protocols: PROTOCOLS,
        passwordMinLength: ADMIN_PASSWORD_MIN_LENGTH,
        bodyLimit: BODY_LIMIT,
      },
    };
  }

  function restartRequired(before, after, adminBefore, adminAfter) {
    const fields = [];
    if (before.compiled.host !== after.compiled.host || before.compiled.port !== after.compiled.port) fields.push('路由监听地址');
    if (adminBefore !== adminAfter) fields.push('管理台端口');
    return fields;
  }

  function configWarnings(raw, compiled) {
    const warnings = [];
    for (const group of raw.groups ?? []) {
      if (group.enabled === false) warnings.push('分组 ' + group.id + ' 当前处于禁用状态，不会接受客户端请求');
      if (!(group.virtualApiKeys?.length) && group.apiKeys?.length) warnings.push('分组 ' + group.id + ' 仅使用直通 Key，客户端需要发送真实上游 Key');
    }
    if (compiled.host !== '127.0.0.1' && compiled.host !== 'localhost') warnings.push('路由监听地址不是回环地址，请确认防火墙与访问控制');
    if (raw.accessLog === true) warnings.push('访问日志已开启；日志只记录请求 ID、方法、协议、状态和耗时');
    return warnings;
  }

  function incomingConfig(value) {
    let config = value;
    if (typeof config === 'string') {
      try { config = JSON.parse(config); }
      catch { throw httpError(400, '导入的配置不是合法 JSON'); }
    }
    if (!isObject(config)) throw httpError(400, '导入的配置必须是 JSON 对象');
    assertSafeKeys(config);
    return config;
  }

  function redactedConfig(raw) {
    const copy = structuredClone(raw);
    for (const group of copy.groups ?? []) {
      const maskList = list => Array.isArray(list) ? list.map(entry => isObject(entry) ? entry : '__REDACTED__') : list;
      if (group.virtualApiKeys) group.virtualApiKeys = maskList(group.virtualApiKeys);
      if (group.apiKeys) group.apiKeys = maskList(group.apiKeys);
      if (typeof group.upstreamApiKey === 'string') group.upstreamApiKey = '__REDACTED__';
      for (const route of Object.values(group.routes ?? {})) if (typeof route?.upstreamApiKey === 'string') route.upstreamApiKey = '__REDACTED__';
      for (const model of group.models ?? []) {
        for (const route of Object.values(model.routes ?? {})) if (typeof route?.upstreamApiKey === 'string') route.upstreamApiKey = '__REDACTED__';
      }
    }
    return copy;
  }

  async function groupTest(body) {
    const snapshot = await store.read();
    const target = body.id ? groupById(snapshot.raw, body.id) : null;
    if (!target) throw httpError(400, '缺少分组 ID');
    const resolvedGroup = resolvedGroupById(snapshot.resolved, target.id) ?? target;
    const mode = body.mode === 'generate' ? 'generate' : 'models';
    const requestedProtocol = body.protocol ? assertProtocol(body.protocol) : null;
    const model = body.model ? target.models?.find(item => item.id === body.model) : (target.models?.[0] ?? null);
    if (body.model && !model) throw httpError(404, '分组中不存在该模型：' + body.model);
    const resolvedModel = model ? resolvedGroup.models?.find(item => item.id === model.id) : null;
    const protocols = PROTOCOLS.filter(protocol => (model?.routes?.[protocol] ?? target.routes?.[protocol]));
    const protocol = requestedProtocol ?? protocols[0] ?? null;
    if (!protocol) throw httpError(400, '该模型/分组没有可用协议路由');
    if (!protocols.includes(protocol)) throw httpError(400, '该模型没有 ' + protocol + ' 路由');
    const route = model?.routes?.[protocol] ?? target.routes?.[protocol];
    const resolvedRoute = resolvedModel?.routes?.[protocol] ?? resolvedGroup.routes?.[protocol] ?? route;
    const upstreamKey = resolvedRoute.upstreamApiKey ?? resolvedGroup.upstreamApiKey;
    if (!upstreamKey) throw httpError(400, '未配置上游 Key；此路由只能直传客户端 Key，管理台无法代为测试');
    const authMode = resolvedRoute.auth ?? route.auth ?? (protocol === 'messages' ? 'x-api-key' : 'bearer');
    const headers = { accept: 'application/json' };
    if (authMode === 'x-api-key') headers['x-api-key'] = upstreamKey;
    else headers.authorization = 'Bearer ' + upstreamKey;
    if (protocol === 'messages') headers['anthropic-version'] = '2023-06-01';
    let endpoint;
    let requestInit = { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) };
    if (mode === 'models') {
      endpoint = upstreamURL(route.baseURL, '/v1/models');
    } else {
      if (!model) throw httpError(400, '生成测试需要一个模型');
      endpoint = upstreamURL(route.baseURL, protocol === 'chat' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : '/v1/messages');
      const modelName = model.upstreamModel ?? model.id;
      const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim().slice(0, 4000) : 'ping';
      const maxTokens = Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0 ? Math.min(body.maxTokens, 128) : 16;
      const payload = protocol === 'chat'
        ? { model: modelName, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }
        : protocol === 'responses'
          ? { model: modelName, input: prompt, max_output_tokens: maxTokens }
          : { model: modelName, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
      headers['content-type'] = 'application/json';
      requestInit = { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(30000) };
    }
    const secrets = [target.upstreamApiKey, ...(target.apiKeys ?? []), ...(target.virtualApiKeys ?? []),
      ...Object.values(target.routes ?? {}).map(route => route?.upstreamApiKey),
      ...(target.models ?? []).flatMap(item => Object.values(item.routes ?? {}).map(route => route?.upstreamApiKey))]
      .filter(value => typeof value === 'string');
    const redact = secretRedactor([...secrets, ...(resolvedGroup.apiKeys ?? []), ...(resolvedGroup.virtualApiKeys ?? []), resolvedGroup.upstreamApiKey, route.upstreamApiKey].filter(value => typeof value === 'string'));
    const started = Date.now();
    let response;
    try { response = await fetch(endpoint, requestInit); }
    catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      return { ok: false, status: 0, latencyMs: Date.now() - started, error: timedOut ? '请求超时（30s）' : redact.text(error.message), protocol, baseURL: route.baseURL, mode };
    }
    const snippet = redact.text(await readLimited(response, 256 * 1024)).slice(0, 800);
    return {
      ok: response.ok, status: response.status, latencyMs: Date.now() - started,
      endpoint: endpoint.pathname + endpoint.search, baseURL: route.baseURL, protocol, mode,
      contentType: response.headers.get('content-type'), snippet,
    };
  }

  async function readLimited(response, limit) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          chunks.push(value.subarray(0, Math.max(0, limit - (total - value.byteLength))));
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    } catch {}
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  }

  async function routerTest(body) {
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key || /\s/.test(key)) throw httpError(400, '请选择或输入一个本地访问 Key');
    const port = routerPort();
    if (!port) throw httpError(503, '路由服务尚未就绪');
    const mode = body.mode === 'generate' ? 'generate' : 'models';
    const protocol = body.protocol ? assertProtocol(body.protocol) : 'chat';
    const base = 'http://127.0.0.1:' + port;
    const headers = { accept: 'application/json', authorization: 'Bearer ' + key };
    let path = '/v1/models';
    let requestInit = { method: 'GET', headers, signal: AbortSignal.timeout(30000) };
    if (mode === 'generate') {
      if (typeof body.model !== 'string' || !body.model) throw httpError(400, '生成测试需要模型 ID');
      const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim().slice(0, 4000) : 'ping';
      const maxTokens = Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0 ? Math.min(body.maxTokens, 128) : 16;
      const payload = protocol === 'chat'
        ? { model: body.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }
        : protocol === 'responses'
          ? { model: body.model, input: prompt, max_output_tokens: maxTokens }
          : { model: body.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
      path = protocol === 'chat' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : '/v1/messages';
      if (protocol === 'messages') headers['anthropic-version'] = '2023-06-01';
      headers['content-type'] = 'application/json';
      requestInit = { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) };
    }
    const redact = secretRedactor([key]);
    const started = Date.now();
    let response;
    try { response = await fetch(base + path, requestInit); }
    catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      return { ok: false, status: 0, latencyMs: Date.now() - started, error: timedOut ? '请求超时（30s）' : redact.text(error.message), mode, protocol };
    }
    const text = redact.text(await readLimited(response, 256 * 1024));
    let models;
    if (mode === 'models' && response.ok) {
      try {
        const parsed = JSON.parse(text);
        models = Array.isArray(parsed.data) ? parsed.data.map(item => item.id).filter(Boolean) : undefined;
      } catch {}
    }
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, models, snippet: text.slice(0, 800), mode, protocol, endpoint: base + path };
  }

  async function handleAuthRoutes(req, res, path) {
    const method = req.method;
    if (path === '/api/auth/status' && method === 'GET') {
      const { current, session } = await authContextFor(req);
      sendJson(res, 200, {
        ok: true,
        configured: current.configured,
        authenticated: Boolean(session),
        csrfToken: session?.record.csrf ?? null,
        expiresAt: session?.record.expiresAt ?? null,
        error: current.error ?? null,
        minPasswordLength: ADMIN_PASSWORD_MIN_LENGTH,
        passwordFile: fileToDisplay(projectRoot, authPath),
        resetCommand: 'npm run admin:password',
      });
      return true;
    }
    if (path === '/api/auth/setup' && method === 'POST') {
      const current = await authState();
      if (current.configured) throw httpError(409, current.error ? '管理员密码文件无效，请本地重置后再试' : '管理员密码已经设置，请登录');
      const body = await readJson(req);
      try { await auth.setPassword(body.password, { exclusive: true }); }
      catch (error) {
        if (error.code === 'EEXIST') throw httpError(409, '管理员密码已经设置，请刷新页面登录');
        const message = error instanceof Error ? error.message : String(error);
        throw httpError(400, /at least/i.test(message) ? '密码至少需要 ' + ADMIN_PASSWORD_MIN_LENGTH + ' 个字符' : /blank/i.test(message) ? '密码不能为空白字符' : message);
      }
      authFingerprint = undefined;
      await authState();
      const session = createSession();
      setSessionCookie(res, session.raw, session.maxAge);
      auditEvent('auth.setup', 'admin', true);
      sendJson(res, 200, { ok: true, configured: true, authenticated: true, csrfToken: session.csrf, expiresAt: session.expiresAt });
      return true;
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const current = await authState();
      if (current.error) throw httpError(500, current.error);
      if (!current.configured) {
        const error = httpError(409, '尚未设置管理员密码');
        error.code = 'setup_required';
        throw error;
      }
      loginGate();
      const body = await readJson(req);
      const ok = await auth.verify(body.password);
      if (!ok) {
        loginFailed();
        auditEvent('auth.login_failed', 'admin', false);
        throw httpError(401, '管理员密码错误');
      }
      loginSucceeded();
      const session = createSession();
      setSessionCookie(res, session.raw, session.maxAge);
      auditEvent('auth.login', 'admin', true);
      sendJson(res, 200, { ok: true, authenticated: true, csrfToken: session.csrf, expiresAt: session.expiresAt });
      return true;
    }
    return false;
  }

  async function handleGroupCollection(req, res) {
    if (req.method === 'GET') {
      const snapshot = await store.read();
      const groups = snapshot.raw.groups.map(rawGroup => sanitizeGroup(rawGroup, resolvedGroupById(snapshot.resolved, rawGroup.id) ?? rawGroup));
      sendJson(res, 200, { ok: true, summary: snapshot.summary, groups });
      return;
    }
    if (req.method !== 'POST') throw httpError(405, '不支持的方法');
    const body = await readJson(req);
    const id = assertGroupId(body.id);
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 80)) throw httpError(400, '分组名称不能超过 80 字符');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw httpError(400, 'enabled 必须是布尔值');
    if (!isObject(body.routes) || !Object.keys(body.routes).length) throw httpError(400, '至少配置一个协议路由');
    if (!Array.isArray(body.models) || !body.models.length) throw httpError(400, '至少添加一个模型');
    if (body.virtualApiKeys !== undefined && !Array.isArray(body.virtualApiKeys)) throw httpError(400, 'virtualApiKeys 必须是数组');
    if (body.apiKeys !== undefined && !Array.isArray(body.apiKeys)) throw httpError(400, 'apiKeys 必须是数组');
    const label = assertLabel(body.label) || '默认密钥';
    let generatedKey = null;
    const result = await store.update((raw) => {
      if (raw.groups.some(group => group.id === id)) throw httpError(409, '分组 ID 已存在：' + id);
      const group = {
        id,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : id,
        note: assertNote(body.note),
        enabled: body.enabled !== false,
        apiKeys: [],
        virtualApiKeys: [],
        routes: {},
        models: [],
      };
      for (const [protocol, route] of Object.entries(body.routes)) {
        assertProtocol(protocol);
        if (route === null) continue;
        group.routes[protocol] = normalizeRoute(route, null, protocol + ' 路由');
      }
      if (!Object.keys(group.routes).length) throw httpError(400, '至少配置一个有效的协议路由');
      for (const value of body.models) group.models.push(normalizeModel(modelFrom(value)));
      if (body.upstreamApiKey !== undefined) {
        const key = normalizeSecret(body.upstreamApiKey, '上游 API Key');
        if (key !== null) group.upstreamApiKey = key;
      }
      for (const value of body.virtualApiKeys ?? []) addAccessKey(group, 'virtualApiKeys', value, label);
      for (const value of body.apiKeys ?? []) addAccessKey(group, 'apiKeys', value, '直通 Key');
      if (!keyCount(group)) generatedKey = addGeneratedVirtualKey(group, label);
      raw.groups.push(group);
      return true;
    }, { label: 'group.create' });
    auditEvent('group.create', id, true);
    sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id), generatedKey });
  }

  async function handleGroups(req, res, parts, url) {
    const method = req.method;
    const id = parts[2] ?? '';
    if (parts.length === 3) {
      if (method === 'PATCH') {
        const body = await readJson(req);
        let targetId = id;
        const result = await store.update((raw) => {
          const group = groupById(raw, id);
          if (body.newId !== undefined) {
            const nextId = assertGroupId(body.newId);
            if (nextId !== id && raw.groups.some(item => item.id === nextId)) throw httpError(409, '新的分组 ID 已存在');
            group.id = nextId;
            targetId = nextId;
          }
          if (body.name !== undefined) {
            if (body.name === null || body.name === '') delete group.name;
            else if (typeof body.name !== 'string' || body.name.length > 80) throw httpError(400, '分组名称不能超过 80 字符');
            else group.name = body.name.trim();
          }
          if (body.note !== undefined) group.note = assertNote(body.note);
          if (body.enabled !== undefined) {
            if (typeof body.enabled !== 'boolean') throw httpError(400, 'enabled 必须是布尔值');
            group.enabled = body.enabled;
          }
          if (body.upstreamApiKey !== undefined) {
            const value = normalizeSecret(body.upstreamApiKey, '上游 API Key');
            if (value === null) delete group.upstreamApiKey;
            else group.upstreamApiKey = value;
          }
          return true;
        }, { label: 'group.update' });
        auditEvent('group.update', targetId, true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, targetId) });
        return;
      }
      if (method === 'DELETE') {
        const result = await store.update((raw) => {
          const group = groupById(raw, id);
          if (raw.groups.length <= 1) throw httpError(409, '至少保留一个上游分组');
          raw.groups = raw.groups.filter(item => item !== group);
          return true;
        }, { label: 'group.delete' });
        auditEvent('group.delete', id, true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, deleted: id });
        return;
      }
      throw httpError(405, '不支持的方法');
    }

    if (parts.length === 4) {
      if (parts[3] === 'clone' && method === 'POST') {
        const body = await readJson(req);
        let newId;
        const result = await store.update((raw) => {
          const source = groupById(raw, id);
          newId = body.id ? assertGroupId(body.id) : id + '-copy';
          if (raw.groups.some(group => group.id === newId)) throw httpError(409, '目标分组 ID 已存在');
          const clone = structuredClone(source);
          clone.id = newId;
          clone.name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : (source.name ? source.name + ' 副本' : newId);
          clone.enabled = source.enabled !== false;
          clone.apiKeys = [];
          clone.virtualApiKeys = [];
          delete clone.virtualKeyMeta;
          delete clone.apiKeyMeta;
          for (const key of body.apiKeys ?? []) addAccessKey(clone, 'apiKeys', key, '克隆');
          if (!keyCount(clone)) {
            const hasKey = clone.upstreamApiKey || (clone.models ?? []).every(model => PROTOCOLS.some(protocol => (model.routes?.[protocol] ?? clone.routes?.[protocol])?.upstreamApiKey));
            if (!hasKey) throw httpError(409, '源分组没有可复用的上游 Key；请先为克隆分组添加直通 Key');
            addGeneratedVirtualKey(clone, '克隆默认密钥');
          }
          raw.groups.push(clone);
          return true;
        }, { label: 'group.clone' });
        auditEvent('group.clone', id + ' -> ' + newId, true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, newId) });
        return;
      }
      if (parts[3] === 'test' && method === 'POST') {
        const body = await readJson(req);
        body.id = id;
        const result = await groupTest(body);
        auditEvent('group.test', id, result.ok, result.mode + ' ' + result.status);
        sendJson(res, 200, { ok: true, result });
        return;
      }
      if (parts[3] === 'models' && method === 'POST') {
        const body = await readJson(req);
        const input = modelFrom(body.model ?? body);
        const result = await store.update((raw) => {
          const group = groupById(raw, id);
          group.models ??= [];
          if (group.models.some(model => model.id === input.id)) throw httpError(409, '模型已存在：' + input.id);
          group.models.push(normalizeModel(input));
          return true;
        }, { label: 'model.create' });
        auditEvent('model.create', id + '/' + (input.id ?? '?'), true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
        return;
      }
      if (parts[3] === 'virtual-keys' && method === 'POST') {
        const body = await readJson(req);
        let newKey = null;
        const result = await store.update((raw) => {
          const group = groupById(raw, id);
          group.virtualApiKeys ??= [];
          const value = body.key === undefined || body.key === null || body.key === '' ? null : normalizeSecret(body.key, '虚拟 Key');
          if (value === null) newKey = addGeneratedVirtualKey(group, assertLabel(body.label) || '新密钥');
          else {
            if (typeof value === 'string') newKey = value;
            group.virtualApiKeys.push(value);
            if (typeof value === 'string') recordKeyMeta(group, 'virtualApiKeys', value, assertLabel(body.label));
            else if (process.env[value.env]) recordKeyMeta(group, 'virtualApiKeys', process.env[value.env], assertLabel(body.label));
          }
          return true;
        }, { label: 'key.create' });
        auditEvent('key.create', id + '/virtual', true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id), key: newKey });
        return;
      }
      if (parts[3] === 'api-keys' && method === 'POST') {
        const body = await readJson(req);
        const result = await store.update((raw) => {
          const group = groupById(raw, id);
          addAccessKey(group, 'apiKeys', body.key, assertLabel(body.label) || '直通 Key');
          return true;
        }, { label: 'key.create' });
        auditEvent('key.create', id + '/api', true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
        return;
      }
      throw httpError(404, '未知管理接口');
    }

    if (parts.length === 5) {
      if (parts[3] === 'models' && parts[4] === 'bulk' && method === 'POST') {
        const body = await readJson(req);
        const template = isObject(body.template) ? body.template : {};
        const items = Array.isArray(body.models) ? body.models : Array.isArray(body.ids) ? body.ids : null;
        if (!items) throw httpError(400, '需要 ids 或 models 数组');
        const added = [];
        const skipped = [];
        const result = await store.update((raw) => {
          const group = groupById(raw, id);
          group.models ??= [];
          for (const item of items) {
            const input = typeof item === 'string' ? { ...template, id: item } : { ...template, ...(isObject(item) ? item : {}) };
            if (!input.id || group.models.some(model => model.id === input.id) || added.includes(input.id)) { skipped.push(input.id ?? '?'); continue; }
            group.models.push(normalizeModel(input));
            added.push(input.id);
          }
          if (!added.length) return false;
          return true;
        }, { label: 'model.bulk' });
        auditEvent('model.bulk', id, true, '新增 ' + added.length + ' 个模型');
        if (result.unchanged) {
          const snapshot = await store.read();
          sendJson(res, 200, { ok: true, unchanged: true, added, skipped, summary: snapshot.summary, groups: sanitizeGroup(groupById(snapshot.raw, id), resolvedGroupById(snapshot.resolved, id) ?? groupById(snapshot.raw, id)) });
          return;
        }
        sendJson(res, 200, { ok: true, added, skipped, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
        return;
      }
      if (parts[3] === 'models' && (method === 'PATCH' || method === 'DELETE')) {
        const modelId = parts[4];
        let updatedId = modelId;
        if (method === 'DELETE') {
          const result = await store.update((raw) => {
            const group = groupById(raw, id);
            if ((group.models?.length ?? 0) <= 1) throw httpError(409, '分组至少保留一个模型');
            const position = group.models.findIndex(model => model.id === modelId);
            if (position === -1) throw httpError(404, '模型不存在：' + modelId);
            group.models.splice(position, 1);
            return true;
          }, { label: 'model.delete' });
          auditEvent('model.delete', id + '/' + modelId, true);
          sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
          return;
        }
        const body = await readJson(req);
        const result = await store.update((raw) => {
          const group = groupById(raw, id);
          const position = group.models.findIndex(model => model.id === modelId);
          if (position === -1) throw httpError(404, '模型不存在：' + modelId);
          const updated = normalizeModel(body, group.models[position]);
          if (updated.id !== modelId && group.models.some((model, index) => index !== position && model.id === updated.id)) throw httpError(409, '模型 ID 已存在');
          group.models[position] = updated;
          updatedId = updated.id;
          return true;
        }, { label: 'model.update' });
        auditEvent('model.update', id + '/' + updatedId, true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id), modelId: updatedId });
        return;
      }
      if (parts[3] === 'routes' && (method === 'PUT' || method === 'DELETE')) {
        const protocol = assertProtocol(parts[4]);
        const body = method === 'PUT' ? await readJson(req) : {};
        const result = await store.update((raw) => {
          const group = groupById(raw, id);
          group.routes ??= {};
          if (method === 'DELETE') delete group.routes[protocol];
          else {
            const route = normalizeRoute(body, group.routes[protocol], protocol + ' 路由');
            if (!route) delete group.routes[protocol];
            else group.routes[protocol] = route;
          }
          if (!Object.keys(group.routes).length) delete group.routes;
          return true;
        }, { label: method === 'DELETE' ? 'route.delete' : 'route.update' });
        auditEvent(method === 'DELETE' ? 'route.delete' : 'route.update', id + '/' + protocol, true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
        return;
      }
      if (parts[3] === 'virtual-keys' && (method === 'PATCH' || method === 'DELETE')) {
        const keyId = parts[4];
        const body = method === 'PATCH' ? await readJson(req) : {};
        const result = await store.update((raw, before) => {
          const group = groupById(raw, id);
          const resolvedGroup = resolvedGroupById(before.resolved, id) ?? group;
          const found = findKeyEntry(group, resolvedGroup, 'virtualApiKeys', keyId);
          if (method === 'DELETE') {
            if (keyCount(group) <= 1) throw httpError(409, '分组至少保留一个访问密钥');
            group.virtualApiKeys.splice(found.index, 1);
            removeKeyMeta(group, 'virtualApiKeys', keyId);
            return true;
          }
          setKeyLabel(group, 'virtualApiKeys', keyId, assertLabel(body.label));
          return true;
        }, { label: 'key.update' });
        auditEvent(method === 'DELETE' ? 'key.delete' : 'key.update', id + '/virtual/' + keyId, true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
        return;
      }
      if (parts[3] === 'api-keys' && (method === 'PATCH' || method === 'DELETE')) {
        const keyId = parts[4];
        const body = method === 'PATCH' ? await readJson(req) : {};
        const result = await store.update((raw, before) => {
          const group = groupById(raw, id);
          const resolvedGroup = resolvedGroupById(before.resolved, id) ?? group;
          const found = findKeyEntry(group, resolvedGroup, 'apiKeys', keyId);
          if (method === 'DELETE') {
            if (keyCount(group) <= 1) throw httpError(409, '分组至少保留一个访问密钥');
            group.apiKeys.splice(found.index, 1);
            removeKeyMeta(group, 'apiKeys', keyId);
            return true;
          }
          setKeyLabel(group, 'apiKeys', keyId, assertLabel(body.label));
          return true;
        }, { label: 'key.update' });
        auditEvent(method === 'DELETE' ? 'key.delete' : 'key.update', id + '/api/' + keyId, true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
        return;
      }
      throw httpError(404, '未知管理接口');
    }

    if (parts.length === 6 && parts[3] === 'virtual-keys' && parts[5] === 'rotate' && method === 'POST') {
      const keyId = parts[4];
      let newKey = null;
      const result = await store.update((raw, before) => {
        const group = groupById(raw, id);
        const resolvedGroup = resolvedGroupById(before.resolved, id) ?? group;
        const found = findKeyEntry(group, resolvedGroup, 'virtualApiKeys', keyId);
        if (isObject(found.entry) && typeof found.entry.env === 'string') throw httpError(409, '环境变量 Key 不能在此轮换，请更新环境变量');
        const label = group.virtualKeyMeta?.[keyId]?.label ?? '轮换密钥';
        newKey = 'mr-' + randomBytes(32).toString('hex');
        group.virtualApiKeys[found.index] = newKey;
        removeKeyMeta(group, 'virtualApiKeys', keyId);
        recordKeyMeta(group, 'virtualApiKeys', newKey, label);
        return true;
      }, { label: 'key.rotate' });
      auditEvent('key.rotate', id + '/virtual/' + keyId, true);
      sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id), key: newKey });
      return;
    }

    if (parts.length === 7 && parts[3] === 'models' && parts[5] === 'routes' && (method === 'PUT' || method === 'DELETE')) {
      const modelId = parts[4];
      const protocol = assertProtocol(parts[6]);
      const body = method === 'PUT' ? await readJson(req) : {};
      const result = await store.update((raw) => {
        const group = groupById(raw, id);
        const model = group.models.find(item => item.id === modelId);
        if (!model) throw httpError(404, '模型不存在：' + modelId);
        model.routes ??= {};
        if (method === 'DELETE') delete model.routes[protocol];
        else {
          const route = normalizeRoute(body, model.routes[protocol], modelId + '/' + protocol + ' 路由');
          if (!route) delete model.routes[protocol];
          else model.routes[protocol] = route;
        }
        if (!Object.keys(model.routes).length) delete model.routes;
        return true;
      }, { label: method === 'DELETE' ? 'model.route.delete' : 'model.route.update' });
      auditEvent(method === 'DELETE' ? 'model.route.delete' : 'model.route.update', id + '/' + modelId + '/' + protocol, true);
      sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
      return;
    }

    throw httpError(404, '未知管理接口');
  }

  async function handleApi(req, res, url, parts) {
    const method = req.method;
    const session = requireSession(req);
    if (MUTATING.has(method) && method !== 'GET') {
      const csrf = req.headers['x-csrf-token'];
      if (!safeEqual(session.record.csrf, typeof csrf === 'string' ? csrf : '')) {
        throw httpError(403, 'CSRF 校验失败，请刷新页面后重试');
      }
    }

    if (parts[1] === 'auth') {
      if (parts[2] === 'logout' && method === 'POST') {
        destroySession(req);
        clearSessionCookie(res);
        auditEvent('auth.logout', 'admin', true);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (parts[2] === 'password' && method === 'POST' && parts.length === 3) {
        const body = await readJson(req);
        loginGate();
        const valid = await auth.verify(body.currentPassword);
        if (!valid) { loginFailed(); throw httpError(401, '当前密码错误'); }
        try { await auth.setPassword(body.newPassword); }
        catch (error) { throw httpError(400, error instanceof Error ? error.message : String(error)); }
        loginSucceeded();
        sessions.clear();
        authFingerprint = undefined;
        // Refresh the auth fingerprint first; otherwise the new session would be
        // dropped by the rotation check on the next request.
        await authState();
        const fresh = createSession();
        setSessionCookie(res, fresh.raw, fresh.maxAge);
        auditEvent('auth.password_change', 'admin', true);
        sendJson(res, 200, { ok: true, csrfToken: fresh.csrf, expiresAt: fresh.expiresAt });
        return;
      }
      throw httpError(404, '未知认证接口');
    }

    if (parts.length === 2) {
      if (parts[1] === 'state' && method === 'GET') { sendJson(res, 200, await statePayload()); return; }
      if (parts[1] === 'stats' && method === 'GET') { sendJson(res, 200, { ok: true, now: Date.now(), stats: metrics.snapshot() }); return; }
      if (parts[1] === 'requests' && method === 'GET') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
        sendJson(res, 200, { ok: true, requests: metrics.snapshot().recent.slice(0, limit) });
        return;
      }
      if (parts[1] === 'audit' && method === 'GET') { sendJson(res, 200, { ok: true, audit: audit.slice(0, 200) }); return; }
      if (parts[1] === 'backups' && method === 'GET') { sendJson(res, 200, { ok: true, backups: await store.listBackups() }); return; }
      if (parts[1] === 'settings' && method === 'GET') {
        const snapshot = await store.read();
        sendJson(res, 200, { ok: true, settings: sanitizeSettings(snapshot.raw, snapshot.compiled, runtimeInfo()), summary: snapshot.summary });
        return;
      }
    }

    if (parts[1] === 'stats' && parts[2] === 'reset' && method === 'POST' && parts.length === 3) {
      metrics.reset();
      auditEvent('stats.reset', 'metrics', true);
      sendJson(res, 200, { ok: true, stats: metrics.snapshot() });
      return;
    }

    if (parts[1] === 'groups') {
      if (parts.length === 2) return await handleGroupCollection(req, res);
      return await handleGroups(req, res, parts, url);
    }
    if (parts[1] === 'test' && parts[2] === 'router' && method === 'POST' && parts.length === 3) {
      const body = await readJson(req);
      const result = await routerTest(body);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (parts[1] === 'settings' && method === 'PATCH' && parts.length === 2) {
      const body = await readJson(req);
      const allowed = new Set(['host', 'port', 'adminPort', 'maxBodyBytes', 'upstreamTimeoutMs', 'requestTimeoutMs', 'accessLog']);
      for (const key of Object.keys(body)) if (!allowed.has(key)) throw httpError(400, '未知设置项：' + key);
      if (body.host !== undefined && (typeof body.host !== 'string' || !body.host.trim() || body.host.length > 255)) throw httpError(400, '监听地址无效');
      if (body.port !== undefined && (!Number.isSafeInteger(body.port) || body.port < 1 || body.port > 65535)) throw httpError(400, '路由端口必须在 1-65535 之间');
      if (body.adminPort !== undefined && (!Number.isSafeInteger(body.adminPort) || body.adminPort < 1 || body.adminPort > 65535)) throw httpError(400, '管理台端口必须在 1-65535 之间');
      if (body.maxBodyBytes !== undefined && (!Number.isSafeInteger(body.maxBodyBytes) || body.maxBodyBytes < 1024 || body.maxBodyBytes > 1024 * 1024 * 1024)) throw httpError(400, '最大请求体必须在 1 KiB 到 1 GiB 之间');
      for (const field of ['upstreamTimeoutMs', 'requestTimeoutMs']) {
        if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 1000 || body[field] > 24 * 60 * 60 * 1000)) throw httpError(400, field + ' 必须在 1 秒到 24 小时之间');
      }
      if (body.accessLog !== undefined && typeof body.accessLog !== 'boolean') throw httpError(400, 'accessLog 必须是布尔值');
      const effectiveAdminPort = body.adminPort ?? currentAdminPort();
      if (body.port !== undefined && Number(body.port) === Number(effectiveAdminPort)) throw httpError(400, '路由端口与管理台端口不能相同');
      let beforeCompiled = null;
      let adminBefore = null;
      const result = await store.update((raw, before) => {
        beforeCompiled = before.compiled;
        adminBefore = Number.isInteger(raw.adminPort) ? raw.adminPort : currentAdminPort();
        for (const key of allowed) if (body[key] !== undefined) raw[key] = body[key];
        const effectivePort = raw.port ?? before.compiled.port;
        const effectiveAdmin = raw.adminPort ?? currentAdminPort();
        if (effectivePort === effectiveAdmin) throw httpError(400, '路由端口与管理台端口不能相同');
        return true;
      }, { label: 'settings.update' });
      auditEvent('settings.update', Object.keys(body).join(','), true);
      const restart = restartRequired({ compiled: beforeCompiled }, result, adminBefore, Number.isInteger(result.raw.adminPort) ? result.raw.adminPort : currentAdminPort());
      sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, settings: sanitizeSettings(result.raw, result.compiled, runtimeInfo()), restartRequired: restart });
      return;
    }

    if (parts[1] === 'config') {
      if (parts[2] === 'validate' && method === 'POST' && parts.length === 3) {
        const body = await readJson(req);
        const config = incomingConfig(body.config);
        let validated;
        try { validated = validateConfig(config); }
        catch (error) { const friendly = friendlyError(error); throw httpError(400, friendly.message, friendly.detail); }
        sendJson(res, 200, { ok: true, dryRun: true, summary: validated.summary, warnings: configWarnings(config, validated.compiled) });
        return;
      }
      if (parts[2] === 'import' && method === 'POST' && parts.length === 3) {
        const body = await readJson(req);
        const config = incomingConfig(body.config);
        let validated;
        try { validated = validateConfig(config); }
        catch (error) { const friendly = friendlyError(error); throw httpError(400, friendly.message, friendly.detail); }
        const importedAdminPort = Number.isInteger(config.adminPort) ? config.adminPort : currentAdminPort();
        const importedRouterPort = Number.isInteger(config.port) ? config.port : 8787;
        if (importedAdminPort === importedRouterPort) throw httpError(400, '导入配置的路由端口与管理台端口不能相同');
        const warnings = configWarnings(config, validated.compiled);
        if (body.dryRun === true) { sendJson(res, 200, { ok: true, dryRun: true, summary: validated.summary, warnings }); return; }
        const result = await store.replace(config, { label: 'import' });
        auditEvent('config.import', 'config/local.json', true);
        const restart = restartRequired(result.before, result, Number.isInteger(result.before.raw.adminPort) ? result.before.raw.adminPort : currentAdminPort(), Number.isInteger(result.raw.adminPort) ? result.raw.adminPort : currentAdminPort());
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, warnings, restartRequired: restart });
        return;
      }
      if (parts[2] === 'reload' && method === 'POST' && parts.length === 3) {
        const snapshot = await store.read();
        await reload(snapshot.resolved);
        auditEvent('config.reload', 'config/local.json', true);
        sendJson(res, 200, { ok: true, summary: snapshot.summary, warnings: configWarnings(snapshot.raw, snapshot.compiled) });
        return;
      }
      if (parts[2] === 'export' && method === 'GET' && parts.length === 3) {
        const redact = url.searchParams.get('redacted') === '1' || url.searchParams.get('mode') === 'redacted';
        const snapshot = await store.read();
        const config = redact ? redactedConfig(snapshot.raw) : structuredClone(snapshot.raw);
        if (url.searchParams.get('download') === '1') {
          sendText(res, 200, JSON.stringify(config, null, 2) + '\n', 'application/json; charset=utf-8', {
            'content-disposition': 'attachment; filename="modgaze-config-' + (redact ? 'redacted' : 'private') + '.json"',
          });
        } else {
          sendJson(res, 200, { ok: true, redacted: redact, config });
        }
        return;
      }
    }

    if (parts[1] === 'backups') {
      if (parts.length === 2 && method === 'POST') {
        const body = await readJson(req);
        const name = await store.createBackup(assertLabel(body.label) || 'manual');
        auditEvent('backup.create', name, true);
        sendJson(res, 200, { ok: true, name, backups: await store.listBackups() });
        return;
      }
      if (parts.length === 4 && parts[3] === 'download' && method === 'GET') {
        const name = parts[2];
        let raw;
        try { raw = await readBackupFile(backupDir, name); }
        catch (error) { throw httpError(400, '备份不存在或不可读', error.message); }
        sendText(res, 200, JSON.stringify(raw, null, 2) + '\n', 'application/json; charset=utf-8', {
          'content-disposition': 'attachment; filename="' + name.replace(/[^A-Za-z0-9._-]/g, '_') + '"',
        });
        return;
      }
      if (parts.length === 4 && parts[3] === 'restore' && method === 'POST') {
        const name = parts[2];
        const result = await store.restoreBackup(name);
        auditEvent('backup.restore', name, true);
        sendJson(res, 200, { ok: true, restoredFrom: name, summary: result.summary, backup: result.backup });
        return;
      }
      if (parts.length === 3 && method === 'DELETE') {
        const name = parts[2];
        await store.removeBackup(name);
        auditEvent('backup.delete', name, true);
        sendJson(res, 200, { ok: true, backups: await store.listBackups() });
        return;
      }
      if (parts.length === 2 && method === 'GET') { sendJson(res, 200, { ok: true, backups: await store.listBackups() }); return; }
    }

    if (parts[1] === 'service' && parts[2] === 'restart' && method === 'POST' && parts.length === 3) {
      const service = await serviceStatus();
      if (!service.managed) throw httpError(409, '当前进程不是由 service.mjs 托管；请在终端运行 npm run service:restart');
      auditEvent('service.restart', 'service', true);
      sendJson(res, 202, { ok: true, restarting: true, message: '服务将在数秒内重启，页面会自动重连' });
      setTimeout(() => {
        try {
          const child = spawn(process.execPath, [join(projectRoot, 'scripts/service.mjs'), 'restart'], { cwd: projectRoot, detached: true, stdio: 'ignore', env: process.env });
          child.unref();
        } catch { console.error(JSON.stringify({ event: 'admin_restart_error' })); }
      }, 250);
      return;
    }

    throw httpError(404, '未知管理接口');
  }

  async function serveStatic(req, res, path) {
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const files = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/assets/app.js': ['assets/app.js', 'text/javascript; charset=utf-8'],
      '/assets/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    };
    const entry = files[path];
    if (!entry && path.startsWith('/assets/')) {
      const relativePath = path.slice('/assets/'.length);
      const segments = relativePath.split('/');
      if (!relativePath || relativePath.includes('\\') || segments.some(segment => !segment || segment === '..' || segment === '.') || !/\.(?:js|css)$/i.test(relativePath)) {
        throw httpError(404, '页面不存在');
      }
      const assetRoot = resolve(publicDir, 'assets');
      const assetPath = resolve(assetRoot, relativePath);
      if (assetPath !== assetRoot && !assetPath.startsWith(assetRoot + sep)) throw httpError(404, '页面不存在');
      const type = /\.css$/i.test(relativePath) ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      const content = await readFile(assetPath, 'utf8');
      sendText(res, 200, content, type, { 'cache-control': 'no-store' });
      return;
    }
    if (!entry) throw httpError(404, '页面不存在');
    const [file, type] = entry;
    let content;
    if (file === 'index.html') {
      content = indexHtml;
      if (!content) throw httpError(500, 'Web UI 资源缺失，请检查 public/index.html');
      content = content.replaceAll('%APP_VERSION%', PACKAGE.version).replaceAll('%ADMIN_PORT%', String(currentAdminPort()));
      res.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; form-action 'self'");
      res.setHeader('x-frame-options', 'DENY');
    }
    content = file === 'index.html' ? content : await readFile(join(publicDir, file), 'utf8');
    sendText(res, 200, content, type, { 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
  }

  function handleError(res, error) {
    if (res.headersSent || res.writableEnded) { res.destroy(); return; }
    let status;
    let message;
    let detail = null;
    let code = null;
    if (error instanceof HttpError) {
      status = error.status;
      message = error.message;
      detail = error.detail ?? null;
      code = error.code ?? null;
    } else {
      const friendly = friendlyError(error);
      message = friendly.message;
      detail = friendly.detail;
      const raw = error instanceof Error ? error.message : String(error);
      if (error instanceof SyntaxError) { message = '配置或请求 JSON 无效'; detail = null; status = 400; }
      else if (/(Invalid|requires|Duplicate|Unknown|Unsafe|At least one|must have mode|environment variable|Model has no|Upstream credential)/.test(raw)) status = 400;
      else if (error?.code === 'ENOENT') status = 404;
      else if (error?.code === 'EEXIST') status = 409;
      else status = 500;
    }
    if (status >= 500) {
      console.error(JSON.stringify({ event: 'admin_error', status, message }));
      detail = null;
    }
    if (error?.retryAfter) res.setHeader('retry-after', String(error.retryAfter));
    sendJson(res, status, { ok: false, error: { message, detail, code } });
  }

  async function handle(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    try {
      assertTrustedRequest(req);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/healthz') { sendJson(res, 200, { status: 'ok', service: 'admin' }); return; }
      if (url.pathname.startsWith('/assets/') || url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/favicon.ico') {
        await serveStatic(req, res, url.pathname);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw httpError(404, '页面不存在');
      if (MUTATING.has(req.method) && req.headers['content-type'] && !String(req.headers['content-type']).startsWith('application/json')) {
        throw httpError(415, '请求必须使用 application/json');
      }
      if (await handleAuthRoutes(req, res, url.pathname)) return;
      const parts = url.pathname.split('/').filter(Boolean).map(decodeSegment);
      const currentAuth = await authState();
      if (!currentAuth.configured) {
        const error = httpError(409, '尚未设置管理员密码');
        error.code = 'setup_required';
        throw error;
      }
      if (currentAuth.error) throw httpError(500, currentAuth.error);
      if (!parts[1]) throw httpError(404, '未知管理接口');
      await handleApi(req, res, url, parts);
    } catch (error) { handleError(res, error); }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(error => handleError(res, error)); });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.on('error', error => { console.error(JSON.stringify({ event: 'admin_listen_error', code: error.code ?? 'UNKNOWN' })); });
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [hash, record] of sessions) if (now > record.expiresAt || now - record.lastSeen > SESSION_IDLE_MS) sessions.delete(hash);
  }, 10 * 60 * 1000);
  prune.unref?.();
  server.on('close', () => clearInterval(prune));
  server.adminAuthPath = authPath;
  server.adminBackupDir = backupDir;
  server.adminMetrics = metrics;
  await authState();
  return server;
}
