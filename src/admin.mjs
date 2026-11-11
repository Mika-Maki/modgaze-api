import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  ADMIN_PASSWORD_MIN_LENGTH, AdminAuth, assertPassword,
} from './admin-auth.mjs';
import {
  ConfigStore, HttpError, assertSafeKeys, friendlyError, groupPayload, httpError,
  resolvedGroupById, sanitizeGroup, sanitizeSettings,
} from './admin-store.mjs';
import { PROTOCOLS } from './router.mjs';
import { createMetrics } from './metrics.mjs';
import { createRequestAudit } from './request-audit.mjs';
import { createRequestLimiter, normalizeRateLimits } from './rate-limit.mjs';
import {
  BODY_LIMIT, PUBLIC_ORIGIN_REQUEST, clearSessionCookie, decodeSegment,
  readJson, safeEqual, sendJson, setSessionCookie,
} from './admin-http.mjs';
import { SessionStore } from './admin-sessions.mjs';
import { createStaticHandler } from './admin-static.mjs';
import { fileToDisplay } from './admin-keys.mjs';
import { createGroupTest, createRouterTest } from './admin-probe.mjs';
import { createGroupRoutes } from './admin-routes-groups.mjs';
import { createSystemRoutes } from './admin-routes-system.mjs';
import { createTokenUsageStore } from './token-usage.mjs';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const round = value => Math.round(value);
const PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// HTTP composition root: options, runtime state, sessions, auth and dispatch.
// Group/model/key routes live in admin-routes-groups.mjs; settings/config/backups
// and service control live in admin-routes-system.mjs.
export async function createAdmin(options = {}) {
  const configPath = resolve(options.configPath ?? 'config/local.json');
  const runDir = resolve(options.runDir ?? 'run');
  const projectRoot = resolve(options.projectRoot ?? fileURLToPath(new URL('../', import.meta.url)));
  const publicDir = resolve(options.publicDir ?? fileURLToPath(new URL('../public/', import.meta.url)));
  const adminPort = Number(options.adminPort ?? 8788);
  const tlsAllowedHosts = options.tlsAllowedHosts ?? [];
  const httpAllowedHosts = options.allowedHosts ?? [];
  let publicOrigin = null;
  if (options.publicOrigin !== undefined) {
    try {
      const value = options.publicOrigin;
      const url = new URL(value);
      if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password ||
          url.search || url.hash || (value !== url.origin && value !== url.origin + '/')) throw new Error();
      publicOrigin = url;
    } catch { throw new Error('Invalid adminPublicOrigin: expected an HTTPS origin'); }
  }
  if (!Array.isArray(httpAllowedHosts) || httpAllowedHosts.some(h => typeof h !== 'string' || !h || [...h].some(c => !'abcdefghijklmnopqrstuvwxyz0123456789.:-[]'.includes(c.toLowerCase())))) throw new Error('Invalid admin allowedHosts');
  if (!Array.isArray(tlsAllowedHosts) || tlsAllowedHosts.some(h => typeof h !== 'string' || !h || [...h].some(c => !'abcdefghijklmnopqrstuvwxyz0123456789.:-[]'.includes(c.toLowerCase())))) throw new Error('Invalid TLS allowedHosts');
  const authPath = resolve(options.authPath ?? join(dirname(configPath), 'admin-auth.private.json'));
  const backupDir = join(runDir, 'backups');
  const routerPort = typeof options.routerPort === 'function' ? options.routerPort : () => options.routerPort;
  const reload = options.reload ?? (async () => {});
  const metrics = options.metrics ?? createMetrics();
  const requestAudit = options.requestAudit ?? createRequestAudit();
  const tokenUsageStore = options.tokenUsageStore ?? createTokenUsageStore({ directory: join(runDir, 'token-usage') });
  const auth = new AdminAuth(authPath);
  const limiter = createRequestLimiter();
  const rateLimitsRefreshMs = options.rateLimitsRefreshMs ?? 5000;
  if (!Number.isSafeInteger(rateLimitsRefreshMs) || rateLimitsRefreshMs < 1 || rateLimitsRefreshMs > 2147483647) throw new Error('Invalid rateLimitsRefreshMs');
  const store = options.store ?? new ConfigStore({ configPath, backupDir, reload });
  const initialSnapshot = await store.read();
  requestAudit.configure(initialSnapshot.compiled.audit);
  let rateLimits = normalizeRateLimits(options.rateLimits ?? initialSnapshot.compiled.rateLimits);
  let rateLimitsSignature = JSON.stringify(initialSnapshot.compiled.rateLimits);
  let limitsGeneration = 0;
  let reloadingLimits = 0;
  let limitsClosed = false;
  let limitsTimer;
  const reloadStore = (store.reload ?? reload).bind(store);
  store.reload = async resolved => {
    // Invalidate pending reads both before and after a reload (including rollback).
    ++limitsGeneration;
    ++reloadingLimits;
    try {
      await reloadStore(resolved);
      if (!limitsClosed) {
        rateLimits = normalizeRateLimits(resolved.rateLimits);
        rateLimitsSignature = JSON.stringify(rateLimits);
      }
    } finally {
      --reloadingLimits;
      ++limitsGeneration;
    }
  };
  function scheduleLimitsRefresh() {
    if (limitsClosed) return;
    limitsTimer = setTimeout(refreshRateLimits, rateLimitsRefreshMs);
    limitsTimer.unref();
  }
  async function refreshRateLimits() {
    // Independent of admission: local corrections recover even a fully exhausted
    // budget, while 401/429 floods cannot trigger config reads or compilation.
    const refresh = async () => {
      if (limitsClosed || reloadingLimits) return;
      const generation = limitsGeneration;
      const nextLimits = store.readRateLimits ? await store.readRateLimits() : (await store.read()).compiled.rateLimits;
      if (limitsClosed || reloadingLimits || generation !== limitsGeneration) return;
      const signature = JSON.stringify(nextLimits);
      if (signature !== rateLimitsSignature) {
        rateLimits = normalizeRateLimits(nextLimits);
        rateLimitsSignature = signature;
      }
    };
    try {
      // Serialize with ConfigStore writes so uncommitted settings never leak into
      // admission. The next timeout is armed only after this read settles.
      if (store.enqueue) await store.enqueue(refresh);
      else await refresh();
    } catch { /* Keep last-known-good limits and retry after local config repair. */ }
    finally { scheduleLimitsRefresh(); }
  }
  function stopLimitsRefresh() {
    limitsClosed = true;
    ++limitsGeneration;
    clearTimeout(limitsTimer);
  }
  const peerFor = req => String(req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/i, '');
  function acquireLogin(req) {
    const limits = rateLimits.admin;
    return limiter.acquire([
      { id: 'admin:login', maxConcurrent: limits.loginMaxConcurrent, rpm: 0 },
      { id: 'admin:login:peer:' + peerFor(req), maxConcurrent: 0, rpm: limits.loginRpm },
    ]);
  }
  const startedAt = Date.now();
  const audit = [];
  const sessions = new SessionStore();
  let authFingerprint;

  function auditEvent(action, target, ok = true, detail = null) {
    audit.unshift({ time: Date.now(), action, target, ok, detail: detail == null ? null : String(detail).slice(0, 300) });
    if (audit.length > 250) audit.length = 250;
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
    const session = current.configured && !current.error ? sessions.fromRequest(req) : null;
    return { current, session };
  }

  function requireSession(req) {
    const session = sessions.fromRequest(req);
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

  // Local tunnels and reverse proxies connect from loopback, so the TCP peer
  // alone cannot prove that first-time setup is happening at the server console.
  function isLoopbackHost(value) {
    try {
      const hostname = new URL('http://' + value).hostname.toLowerCase();
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
    } catch { return false; }
  }

  // Same-host tunnels connect from loopback and may rewrite Host. Any forwarded
  // identity header therefore disqualifies the request from "local console".
  const PROXY_IDENTITY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'forwarded', 'x-real-ip'];

  function isLocalRequest(req) {
    if (PROXY_IDENTITY_HEADERS.some(name => req.headers[name] !== undefined)) return false;
    const peer = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
    if (peer !== '127.0.0.1' && peer !== '::1') return false;
    return isLoopbackHost(req.headers.host);
  }

  function requireLocal(req) {
    if (!isLocalRequest(req)) throw httpError(403, '此操作仅允许在服务器本机执行');
  }

  function assertTrustedRequest(req) {
    const encrypted = Boolean(req.socket.encrypted);
    const port = encrypted ? req.socket.localPort : currentAdminPort();
    const host = String(req.headers.host ?? '').toLowerCase();
    const hosts = allowedHosts(port);
    {
      const localAddress = String(req.socket.localAddress ?? '').replace(/^::ffff:/, '');
      for (const name of [localAddress, ...(encrypted ? tlsAllowedHosts : httpAllowedHosts)]) {
        if (!name) continue;
        const hostname = name.includes(':') && !name.startsWith('[') ? '[' + name + ']' : name;
        hosts.add(hostname.toLowerCase() + ':' + port);
      }
    }
    // An explicit public HTTPS origin supports local TLS-terminating proxies.
    // Never infer trusted transport or host from arbitrary forwarded headers.
    const peer = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
    const publicHost = publicOrigin !== null && host === publicOrigin.host;
    const publicRequest = publicHost && (encrypted || peer === '127.0.0.1' || peer === '::1');
    if ((publicHost && !publicRequest) || (!publicRequest && !hosts.has(host))) throw httpError(403, '非法的 Host 请求头');
    const origin = req.headers.origin;
    const expectedOrigin = publicRequest ? publicOrigin.origin : (encrypted ? 'https://' : 'http://') + host;
    if (origin && String(origin) !== expectedOrigin) throw httpError(403, '非法的请求来源');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, '拒绝跨站请求');
    req[PUBLIC_ORIGIN_REQUEST] = publicRequest;
  }

  async function statePayload() {
    const snapshot = await store.readVersioned();
    const groups = snapshot.raw.groups.map(rawGroup => sanitizeGroup(rawGroup, resolvedGroupById(snapshot.resolved, rawGroup.id) ?? rawGroup));
    const service = await serviceStatus();
    const backups = await store.listBackups();
    const runtime = runtimeInfo();
    runtime.service = service;
    return {
      ok: true,
      now: Date.now(),
      version: PACKAGE.version,
      configRevision: snapshot.revision,
      runtime,
      service,
      settings: sanitizeSettings(snapshot.raw, snapshot.compiled, runtime),
      summary: snapshot.summary,
      groups,
      stats: metrics.snapshot(),
      recentAudit: audit.slice(0, 100),
      requestAudit: requestAudit.snapshot(),
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
    const previous = before?.compiled ?? initialSnapshot.compiled;
    if (previous.host !== after.compiled.host || previous.port !== after.compiled.port) fields.push('路由监听地址');
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
    if (config === null || typeof config !== 'object' || Array.isArray(config)) throw httpError(400, '导入的配置必须是 JSON 对象');
    assertSafeKeys(config);
    return config;
  }

  function redactedConfig(raw) {
    const copy = structuredClone(raw);
    for (const group of copy.groups ?? []) {
      const maskList = list => Array.isArray(list) ? list.map(entry => (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) ? entry : '__REDACTED__') : list;
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

  const groupTest = createGroupTest({ store });
  const routerTest = createRouterTest({ routerPort });
  const groups = createGroupRoutes({ store, readJson, sendJson, auditEvent, groupPayload, groupTest });

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
      // A tunnel or local proxy makes the TCP peer look like loopback. Host and
      // forwarded-identity headers must also look like a real console request.
      if (req[PUBLIC_ORIGIN_REQUEST] || !isLocalRequest(req)) throw httpError(403, '请先在服务器本机设置管理员密码');
      const current = await authState();
      if (current.configured) throw httpError(409, current.error ? '管理员密码文件无效，请本地重置后再试' : '管理员密码已经设置，请登录');
      const body = await readJson(req);
      try { assertPassword(body.password); } catch { throw httpError(400, '密码格式无效，至少需要 ' + ADMIN_PASSWORD_MIN_LENGTH + ' 个字符'); }
      const releaseLogin = acquireLogin(req);
      try { await auth.setPassword(body.password, { exclusive: true }); }
      catch (error) {
        if (error.code === 'EEXIST') throw httpError(409, '管理员密码已经设置，请刷新页面登录');
        throw httpError(500, '无法保存管理员密码，请在本机检查密码文件');
      } finally { releaseLogin(); }
      authFingerprint = undefined;
      await authState();
      const session = sessions.create(req);
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
      const body = await readJson(req);
      // Reserve synchronously before verify() can begin asynchronous scrypt work.
      const releaseLogin = acquireLogin(req);
      let ok;
      try { ok = await auth.verify(body.password); }
      finally { releaseLogin(); }
      if (!ok) {
        auditEvent('auth.login_failed', 'admin', false);
        throw httpError(401, '管理员密码错误');
      }
      const session = sessions.create(req);
      setSessionCookie(res, session.raw, session.maxAge);
      auditEvent('auth.login', 'admin', true);
      sendJson(res, 200, { ok: true, authenticated: true, csrfToken: session.csrf, expiresAt: session.expiresAt });
      return true;
    }
    return false;
  }

  const system = createSystemRoutes({
    store, metrics, requestAudit, tokenUsageStore, audit, auditEvent, serviceStatus, statePayload, runtimeInfo,
    currentAdminPort, routerPort, configWarnings, incomingConfig,
    redactedConfig, restartRequired, projectRoot, backupDir, auth, acquireLogin,
  });

  async function handleApi(req, res, url, parts) {
    const method = req.method;
    const session = requireSession(req);
    if (MUTATING.has(method)) {
      const csrf = req.headers['x-csrf-token'];
      if (!safeEqual(session.record.csrf, typeof csrf === 'string' ? csrf : '')) {
        throw httpError(403, 'CSRF 校验失败，请刷新页面后重试');
      }
    }

    if (parts[1] === 'auth') {
      if (parts[2] === 'logout' && method === 'POST') {
        sessions.destroy(req);
        clearSessionCookie(res);
        auditEvent('auth.logout', 'admin', true);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (parts[2] === 'password' && method === 'POST' && parts.length === 3) {
        requireLocal(req);
        const body = await readJson(req);
        const releaseLogin = acquireLogin(req);
        try {
          const valid = await auth.verify(body.currentPassword);
          if (!valid) throw httpError(401, '当前密码错误');
          try { assertPassword(body.newPassword); } catch { throw httpError(400, '新密码格式无效，至少需要 ' + ADMIN_PASSWORD_MIN_LENGTH + ' 个字符'); }
          try { await auth.setPassword(body.newPassword); }
          catch { throw httpError(500, '无法保存管理员密码，请在本机检查密码文件'); }
        } finally { releaseLogin(); }
        sessions.clear();
        authFingerprint = undefined;
        // Refresh the auth fingerprint first; otherwise the new session would be
        // dropped by the rotation check on the next request.
        await authState();
        const fresh = sessions.create(req);
        setSessionCookie(res, fresh.raw, fresh.maxAge);
        auditEvent('auth.password_change', 'admin', true);
        sendJson(res, 200, { ok: true, csrfToken: fresh.csrf, expiresAt: fresh.expiresAt });
        return;
      }
      throw httpError(404, '未知认证接口');
    }

    // Backup downloads can reconstruct the raw config from disk, so they stay
    // console-only even for an authenticated tunnel session.
    if (['backups', 'token-backups'].includes(parts[1]) && parts.length === 4 && parts[3] === 'download') requireLocal(req);

    if (parts[1] === 'groups') {
      if (parts.length === 2) return await groups.handleGroupCollection(req, res);
      return await groups.handleGroups(req, res, parts, url);
    }

    if (parts[1] === 'test' && parts[2] === 'router' && method === 'POST' && parts.length === 3) {
      const body = await readJson(req);
      const result = await routerTest(body);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (await system.handle(req, res, url, parts)) return;
    throw httpError(404, '未知管理接口');
  }

  const serveStatic = createStaticHandler({ publicDir, version: PACKAGE.version, currentAdminPort });

  function handleError(res, error) {
    // end() may still have buffered bytes to flush. A later error must not
    // truncate a complete response that has already been handed to HTTP.
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    let status;
    let message;
    let detail = null;
    let code = null;
    if (error?.status === 429 && error?.type === 'rate_limit_error') {
      status = 429;
      message = '请求过于频繁，请稍后重试';
      code = 'rate_limit_error';
    } else if (error?.code === 'token_usage_unavailable') {
      status = 503;
      message = 'Token 账本暂不可用，请在本机检查文件权限或服务日志';
      code = 'token_usage_unavailable';
    } else if (error instanceof HttpError) {
      status = error.status;
      message = error.message;
      // Raw exception details can contain upstream credentials or config text.
      detail = null;
      code = error.code ?? null;
    } else {
      const friendly = friendlyError(error);
      message = friendly.message;
      detail = friendly.detail;
      const raw = error instanceof Error ? error.message : String(error);
      if (error instanceof SyntaxError) { message = '配置或请求 JSON 无效'; detail = null; status = 400; }
      else if (/(Invalid|requires|Duplicate|Unknown|Unsafe|At least one|must have mode|environment variable|Model has no|Upstream credential|tokenLimits)/.test(raw)) status = 400;
      else if (error?.code === 'ENOENT') status = 404;
      else if (error?.code === 'EEXIST') status = 409;
      else status = 500;
    }
    if (status >= 500) {
      console.error(JSON.stringify({ event: 'admin_error', status, message }));
      detail = null;
    }
    if (error?.retryAfter) res.setHeader('retry-after', String(error.retryAfter));
    sendJson(res, status, { ok: false, error: { message, detail, code, ...(status === 429 ? { type: 'rate_limit_error' } : {}) } });
  }

  async function handle(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    try {
      assertTrustedRequest(req);
      const url = new URL(req.url, 'http://127.0.0.1');
      // Upgrade the document at the trusted public proxy, before an HTTP page
      // can issue module requests with an Origin that is deliberately rejected.
      // This header only selects a redirect to the configured HTTPS origin; it
      // never establishes host/transport trust or bypasses Origin validation.
      if (req[PUBLIC_ORIGIN_REQUEST] && !req.socket.encrypted &&
          req.headers['x-forwarded-proto'] === 'http' &&
          (req.method === 'GET' || req.method === 'HEAD') &&
          (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(308, { location: publicOrigin.origin + url.pathname + url.search, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (url.pathname === '/healthz') { sendJson(res, 200, { status: 'ok', service: 'admin' }); return; }
      if (res.destroyed || res.writableEnded) return;
      const limits = rateLimits.admin;
      const release = limiter.acquire([
        { id: 'admin:requests', maxConcurrent: limits.maxConcurrent, rpm: limits.rpm },
        { id: 'admin:peer:' + peerFor(req), maxConcurrent: limits.perIpMaxConcurrent, rpm: limits.perIpRpm },
      ]);
      // Both events may fire, including on abort; limiter releases are idempotent.
      res.once('finish', release);
      res.once('close', release);
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
  const prune = setInterval(() => sessions.prune(), 10 * 60 * 1000);
  prune.unref?.();
  const closeServer = server.close;
  server.close = function (...args) {
    stopLimitsRefresh();
    clearInterval(prune);
    return closeServer.apply(this, args);
  };
  server.on('close', () => { stopLimitsRefresh(); clearInterval(prune); });
  server.on('close', () => {
    if (!options.tokenUsageStore) void tokenUsageStore.close().catch(() => console.error(JSON.stringify({ event: 'token_usage_close_error' })));
  });
  server.adminAuthPath = authPath;
  server.adminBackupDir = backupDir;
  server.adminMetrics = metrics;
  await authState();
  scheduleLimitsRefresh();
  return server;
}
