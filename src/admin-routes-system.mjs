import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { assertLabel, friendlyError, httpError, sanitizeSettings } from './admin-store.mjs';
import { readJson, sendJson, sendText } from './admin-http.mjs';
import { readBackup as readBackupFile, validateConfig } from './config.mjs';
import { normalizeAuditConfig } from './request-audit.mjs';
import { normalizeRateLimits } from './rate-limit.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Runtime settings, config import/export, backups and service control.
// Read-only dashboards and mutating system actions share the same session/CSRF gate.
export function createSystemRoutes(context) {
  const {
    store, metrics, requestAudit, audit, auditEvent, serviceStatus, statePayload, runtimeInfo,
    currentAdminPort, routerPort, configWarnings, incomingConfig,
    redactedConfig, restartRequired, projectRoot, backupDir, auth, acquireLogin,
  } = context;

  async function handle(req, res, url, parts) {
    const method = req.method;
    if (parts.length === 2) {
      if (parts[1] === 'state' && method === 'GET') { sendJson(res, 200, await statePayload()); return true; }
      if (parts[1] === 'stats' && method === 'GET') { sendJson(res, 200, { ok: true, now: Date.now(), configRevision: store.revision, stats: metrics.snapshot() }); return true; }
      if (parts[1] === 'requests' && method === 'GET') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
        sendJson(res, 200, { ok: true, requests: metrics.snapshot().recent.slice(0, limit) });
        return true;
      }
      if (parts[1] === 'audit' && method === 'GET') { sendJson(res, 200, { ok: true, audit: audit.slice(0, 200) }); return true; }
      if (parts[1] === 'request-audit' && method === 'GET') {
        sendJson(res, 200, { ok: true, ...requestAudit.snapshot(url.searchParams.has('ip') ? { ip: url.searchParams.get('ip') } : {}) });
        return true;
      }
      if (parts[1] === 'backups' && method === 'GET') { sendJson(res, 200, { ok: true, backups: await store.listBackups() }); return true; }
      if (parts[1] === 'settings' && method === 'GET') {
        const snapshot = await store.readVersioned();
        sendJson(res, 200, { ok: true, settings: sanitizeSettings(snapshot.raw, snapshot.compiled, runtimeInfo()), summary: snapshot.summary });
        return true;
      }
    }

    if (parts[1] === 'stats' && parts[2] === 'reset' && method === 'POST' && parts.length === 3) {
      metrics.reset();
      auditEvent('stats.reset', 'metrics', true);
      sendJson(res, 200, { ok: true, stats: metrics.snapshot() });
      return true;
    }

    if (parts[1] === 'settings' && method === 'PATCH' && parts.length === 2) {
      const body = await readJson(req);
      const allowed = new Set(['host', 'port', 'adminPort', 'maxBodyBytes', 'maxResponseBytes', 'rateLimits', 'upstreamTimeoutMs', 'requestTimeoutMs', 'accessLog', 'audit']);
      for (const key of Object.keys(body)) if (!allowed.has(key)) throw httpError(400, '未知设置项：' + key);
      if (body.host !== undefined && (typeof body.host !== 'string' || !body.host.trim() || body.host.length > 255)) throw httpError(400, '监听地址无效');
      if (body.port !== undefined && (!Number.isSafeInteger(body.port) || body.port < 1 || body.port > 65535)) throw httpError(400, '路由端口必须在 1-65535 之间');
      if (body.adminPort !== undefined && (!Number.isSafeInteger(body.adminPort) || body.adminPort < 1 || body.adminPort > 65535)) throw httpError(400, '管理台端口必须在 1-65535 之间');
      if (body.maxBodyBytes !== undefined && (!Number.isSafeInteger(body.maxBodyBytes) || body.maxBodyBytes < 1024 || body.maxBodyBytes > 1024 * 1024 * 1024)) throw httpError(400, '最大请求体必须在 1 KiB 到 1 GiB 之间');
      for (const field of ['upstreamTimeoutMs', 'requestTimeoutMs']) {
        if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 1000 || body[field] > 24 * 60 * 60 * 1000)) throw httpError(400, field + ' 必须在 1 秒到 24 小时之间');
      }
      if (body.maxResponseBytes !== undefined && (!Number.isSafeInteger(body.maxResponseBytes) || body.maxResponseBytes <= 0)) throw httpError(400, 'maxResponseBytes 必须是正安全整数');
      if (body.accessLog !== undefined && typeof body.accessLog !== 'boolean') throw httpError(400, 'accessLog 必须是布尔值');
      const effectiveAdminPort = body.adminPort ?? currentAdminPort();
      if (body.port !== undefined && Number(body.port) === Number(effectiveAdminPort)) throw httpError(400, '路由端口与管理台端口不能相同');
      let beforeCompiled = null;
      let adminBefore = null;
      const result = await store.update((raw, before) => {
        beforeCompiled = before.compiled;
        adminBefore = Number.isInteger(raw.adminPort) ? raw.adminPort : currentAdminPort();
        for (const key of allowed) if (!['rateLimits', 'audit'].includes(key) && body[key] !== undefined) raw[key] = body[key];
        if (body.audit !== undefined) {
          if (!isObject(body.audit)) throw httpError(400, 'audit 必须是 JSON 对象');
          // Validate the patch before merging; null/unknown fields must not be hidden.
          normalizeAuditConfig(body.audit);
          const current = before.compiled.audit;
          raw.audit = normalizeAuditConfig({ ...current, ...body.audit, fields: { ...current.fields, ...body.audit.fields } });
        }
        if (body.rateLimits !== undefined) {
          if (!isObject(body.rateLimits)) throw httpError(400, 'rateLimits 必须是 JSON 对象');
          const merged = structuredClone(before.compiled.rateLimits ?? normalizeRateLimits(raw.rateLimits));
          for (const [section, patch] of Object.entries(body.rateLimits)) {
            if (!Object.hasOwn(merged, section) || !isObject(patch)) throw httpError(400, 'rateLimits 配置项无效');
            Object.assign(merged[section], patch);
          }
          raw.rateLimits = normalizeRateLimits(merged);
        }
        const effectivePort = raw.port ?? before.compiled.port;
        const effectiveAdmin = raw.adminPort ?? currentAdminPort();
        if (effectivePort === effectiveAdmin) throw httpError(400, '路由端口与管理台端口不能相同');
        return true;
      }, { label: 'settings.update' });
      requestAudit.configure(result.compiled.audit);
      auditEvent('settings.update', Object.keys(body).join(','), true);
      const restart = restartRequired({ compiled: beforeCompiled }, result, adminBefore, Number.isInteger(result.raw.adminPort) ? result.raw.adminPort : currentAdminPort());
      sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, settings: sanitizeSettings(result.raw, result.compiled, runtimeInfo()), restartRequired: restart });
      return true;
    }

    if (parts[1] === 'config') {
      if (parts[2] === 'validate' && method === 'POST' && parts.length === 3) {
        const body = await readJson(req);
        const config = incomingConfig(body.config);
        let validated;
        try { validated = validateConfig(config); }
        catch (error) { const friendly = friendlyError(error); throw httpError(400, friendly.message, friendly.detail); }
        sendJson(res, 200, { ok: true, dryRun: true, summary: validated.summary, warnings: configWarnings(config, validated.compiled) });
        return true;
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
        if (body.dryRun === true) { sendJson(res, 200, { ok: true, dryRun: true, summary: validated.summary, warnings }); return true; }
        const result = await store.replace(config, { label: 'import' });
        auditEvent('config.import', 'config/local.json', true);
        const restart = restartRequired(result.before, result, Number.isInteger(result.before?.raw.adminPort) ? result.before.raw.adminPort : currentAdminPort(), Number.isInteger(result.raw.adminPort) ? result.raw.adminPort : currentAdminPort());
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, warnings, restartRequired: restart });
        return true;
      }
      if (parts[2] === 'reload' && method === 'POST' && parts.length === 3) {
        const snapshot = await store.reloadCurrent();
        auditEvent('config.reload', 'config/local.json', true);
        sendJson(res, 200, { ok: true, summary: snapshot.summary, warnings: configWarnings(snapshot.raw, snapshot.compiled) });
        return true;
      }
      if (parts[2] === 'export' && parts.length === 3) {
        if (method === 'GET') {
          const mode = url.searchParams.get('mode') === 'raw' || url.searchParams.get('redacted') === '0' ? 'raw' : 'redacted';
          if (mode === 'raw') {
            const error = httpError(403, '下载完整配置需要重新验证管理员密码');
            error.code = 'step_up_required';
            throw error;
          }
          const snapshot = await store.readVersioned();
          const config = redactedConfig(snapshot.raw);
          if (url.searchParams.get('download') === '1') {
            sendText(res, 200, JSON.stringify(config, null, 2) + '\n', 'application/json; charset=utf-8', {
              'content-disposition': 'attachment; filename="modgaze-config-redacted.json"',
            });
          } else {
            sendJson(res, 200, { ok: true, redacted: true, config });
          }
          return true;
        }
        if (method === 'POST') {
          const body = await readJson(req);
          if (body.mode !== 'raw' && body.mode !== 'redacted') throw httpError(400, '导出模式无效');
          if (typeof body.password !== 'string' || !body.password) throw httpError(400, '请输入管理员密码');
          // Raw exports are step-up protected and share the login brute-force budget.
          const release = acquireLogin(req);
          let valid;
          try { valid = await auth.verify(body.password); }
          finally { release(); }
          if (!valid) {
            auditEvent('config.export_denied', body.mode, false);
            throw httpError(401, '管理员密码错误');
          }
          const snapshot = await store.readVersioned();
          const config = body.mode === 'raw' ? structuredClone(snapshot.raw) : redactedConfig(snapshot.raw);
          auditEvent('config.export', body.mode, true);
          sendJson(res, 200, { ok: true, redacted: body.mode === 'redacted', config });
          return true;
        }
        throw httpError(405, '不支持的方法');
      }
    }

    if (parts[1] === 'backups') {
      if (parts.length === 2 && method === 'POST') {
        const body = await readJson(req);
        const name = await store.createBackup(assertLabel(body.label) || 'manual');
        auditEvent('backup.create', name, true);
        sendJson(res, 200, { ok: true, name, backups: await store.listBackups() });
        return true;
      }
      if (parts.length === 4 && parts[3] === 'download' && method === 'GET') {
        const name = parts[2];
        let raw;
        try { raw = await readBackupFile(backupDir, name); }
        catch { throw httpError(400, '备份不存在或不可读'); }
        // Downloads are for inspection and sharing; credentials never leave the
        // server through this route. Restore still reads the raw file locally.
        const config = redactedConfig(raw);
        const filename = name.replace(/\.json$/i, '') + '.redacted.json';
        auditEvent('backup.download', name, true);
        sendText(res, 200, JSON.stringify(config, null, 2) + '\n', 'application/json; charset=utf-8', {
          'content-disposition': 'attachment; filename="' + filename.replace(/[^A-Za-z0-9._-]/g, '_') + '"',
        });
        return true;
      }
      if (parts.length === 4 && parts[3] === 'restore' && method === 'POST') {
        const name = parts[2];
        const result = await store.restoreBackup(name);
        auditEvent('backup.restore', name, true);
        sendJson(res, 200, { ok: true, restoredFrom: name, summary: result.summary, backup: result.backup });
        return true;
      }
      if (parts.length === 3 && method === 'DELETE') {
        const name = parts[2];
        await store.removeBackup(name);
        auditEvent('backup.delete', name, true);
        sendJson(res, 200, { ok: true, backups: await store.listBackups() });
        return true;
      }
      if (parts.length === 2 && method === 'GET') { sendJson(res, 200, { ok: true, backups: await store.listBackups() }); return true; }
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
      return true;
    }

    return false;
  }

  return { handle };
}
