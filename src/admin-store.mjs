import { createHash } from 'node:crypto';
import {
  atomicWriteConfig, atomicWriteConfigBytes, createBackup, listBackups, readBackup, removeBackup, readRawConfig, readConfigBytes, validateConfig,
} from './config.mjs';
import { PROTOCOLS } from './router.mjs';
import { normalizeGroupRateLimits, normalizeRateLimits } from './rate-limit.mjs';
import { normalizeMRExpiresAt } from './key-expiry.mjs';
import { normalizeAuditConfig } from './request-audit.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

export const httpError = (status, message, detail) => new HttpError(status, message, detail);

export function assertSafeKeys(value, path = 'body', depth = 0) {
  if (depth > 64) throw httpError(400, 'JSON 嵌套层级过深');
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertSafeKeys(value[index], path + '[' + index + ']', depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS.has(key)) throw httpError(400, '请求包含不允许的字段：' + key);
    assertSafeKeys(child, path + '.' + key, depth + 1);
  }
}

export function hashKey(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

export function maskSecret(value) {
  if (value && typeof value === 'object' && typeof value.env === 'string') return 'env:' + value.env;
  if (typeof value !== 'string' || !value) return '';
  if (value.length <= 8) return '•'.repeat(Math.max(4, Math.min(8, value.length)));
  return value.slice(0, 4) + '…' + value.slice(-4);
}

export function describeSecret(value) {
  if (value === undefined || value === null || value === '') return null;
  if (isObject(value) && typeof value.env === 'string') return { set: true, source: 'env', env: value.env, masked: 'env:' + value.env };
  if (typeof value === 'string') return { set: true, source: 'inline', masked: maskSecret(value) };
  return { set: true, source: 'unknown', masked: '••••' };
}

const metaField = field => field === 'virtualApiKeys' ? 'virtualKeyMeta' : 'apiKeyMeta';

export function listGroupKeys(rawGroup, resolvedGroup, field) {
  const rawList = Array.isArray(rawGroup[field]) ? rawGroup[field] : [];
  const resolvedList = Array.isArray(resolvedGroup[field]) ? resolvedGroup[field] : [];
  const meta = isObject(rawGroup[metaField(field)]) ? rawGroup[metaField(field)] : {};
  return rawList.map((entry, index) => {
    const isEnv = isObject(entry) && typeof entry.env === 'string';
    const resolved = resolvedList[index] ?? (typeof entry === 'string' ? entry : '');
    const id = hashKey(resolved);
    const info = isObject(meta[id]) ? meta[id] : {};
    return {
      id,
      source: isEnv ? 'env' : 'inline',
      env: isEnv ? entry.env : null,
      // Virtual keys are the local client credentials and must be copyable.
      // Passthrough keys stay masked in every API response.
      value: field === 'virtualApiKeys' && !isEnv ? entry : null,
      masked: isEnv ? 'env:' + entry.env : maskSecret(resolved),
      label: typeof info.label === 'string' ? info.label : null,
      createdAt: typeof info.createdAt === 'string' ? info.createdAt : null,
      ...(field === 'virtualApiKeys' ? { expiresAt: normalizeMRExpiresAt(info.expiresAt) } : {}),
    };
  });
}

function sanitizeModel(model, group) {
  const routes = {};
  for (const protocol of PROTOCOLS) {
    const route = model.routes?.[protocol];
    if (!route) continue;
    routes[protocol] = {
      baseURL: route.baseURL,
      auth: route.auth ?? null,
      key: describeSecret(route.upstreamApiKey),
    };
  }
  return {
    id: model.id,
    name: model.name ?? null,
    upstreamModel: model.upstreamModel ?? null,
    contextWindow: model.contextWindow ?? null,
    maxOutputTokens: model.maxOutputTokens ?? null,
    input: model.input ?? null,
    reasoningEfforts: model.reasoningEfforts ?? null,
    availableReasoningEfforts: model.availableReasoningEfforts ?? null,
    defaults: model.defaults ?? null,
    metadataSource: model.metadataSource ?? null,
    providerCompat: model.providerCompat ?? null,
    routes,
    effectiveProtocols: PROTOCOLS.filter(protocol => routes[protocol] || group.routes?.[protocol]),
    hasProvenance: Boolean(model.provenance || model.sourceMetadata),
  };
}

export function sanitizeGroup(rawGroup, resolvedGroup) {
  const routes = {};
  for (const protocol of PROTOCOLS) {
    const route = rawGroup.routes?.[protocol];
    if (!route) continue;
    routes[protocol] = {
      baseURL: route.baseURL,
      auth: route.auth ?? (protocol === 'messages' ? 'x-api-key' : 'bearer'),
      key: describeSecret(route.upstreamApiKey),
    };
  }
  const models = (rawGroup.models ?? []).map(model => sanitizeModel(model, rawGroup));
  const virtualKeys = listGroupKeys(rawGroup, resolvedGroup, 'virtualApiKeys');
  const apiKeys = listGroupKeys(rawGroup, resolvedGroup, 'apiKeys');
  const protocols = PROTOCOLS.filter(protocol => routes[protocol] || models.some(model => model.routes[protocol]));
  return {
    id: rawGroup.id,
    name: typeof rawGroup.name === 'string' && rawGroup.name ? rawGroup.name : rawGroup.id,
    note: typeof rawGroup.note === 'string' ? rawGroup.note : '',
    enabled: rawGroup.enabled !== false,
    rateLimits: normalizeGroupRateLimits(rawGroup.rateLimits),
    upstreamKey: describeSecret(rawGroup.upstreamApiKey),
    routes,
    models,
    virtualKeys,
    apiKeys,
    protocols,
    counts: {
      models: models.length,
      routes: Object.keys(routes).length,
      virtualKeys: virtualKeys.length,
      apiKeys: apiKeys.length,
    },
  };
}

export function sanitizeSettings(raw, compiled, runtime = {}) {
  return {
    host: compiled.host,
    port: compiled.port,
    adminPort: runtime.adminPort ?? null,
    configuredAdminPort: Number.isInteger(raw.adminPort) ? raw.adminPort : (runtime.adminPort ?? 8788),
    maxBodyBytes: compiled.maxBodyBytes,
    maxResponseBytes: compiled.maxResponseBytes ?? 256 * 1024 * 1024,
    rateLimits: normalizeRateLimits(compiled.rateLimits ?? raw.rateLimits),
    upstreamTimeoutMs: compiled.upstreamTimeoutMs,
    requestTimeoutMs: compiled.requestTimeoutMs,
    accessLog: compiled.accessLog === true,
    audit: normalizeAuditConfig(compiled.audit ?? raw.audit),
    groups: raw.groups.length,
    activeGroups: raw.groups.filter(group => group.enabled !== false).length,
    models: raw.groups.reduce((total, group) => total + (group.models?.length ?? 0), 0),
    configPath: runtime.configPath ?? null,
    runDir: runtime.runDir ?? null,
    authFile: runtime.authFile ?? null,
  };
}

export function friendlyError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const table = [
    [/At least one key group is required/i, '至少保留一个上游分组'],
    [/Invalid or duplicate group id/i, '分组 ID 为空或重复'],
    [/Invalid group enabled flag/i, '分组启用状态必须是布尔值'],
    [/Group requires apiKeys or virtualApiKeys/i, '分组至少需要一个访问密钥（虚拟 Key 或直通 Key）'],
    [/Invalid MR (?:Expires at|expiry metadata)/i, 'MR Expires at 无效，请提供带时区的日期时间；留空表示永不过期'],
    [/Invalid API key/i, '访问密钥格式无效：不能为空或包含空白字符'],
    [/Duplicate API key across groups/i, '访问密钥与其他分组重复；同一密钥只能属于一个分组'],
    [/Invalid upstreamApiKey/i, '上游 API Key 格式无效'],
    [/Invalid group routes/i, '分组路由格式无效'],
    [/Unknown route protocol/i, '包含未知协议的分组路由'],
    [/Invalid route auth/i, '路由鉴权方式只能是 bearer 或 x-api-key'],
    [/Invalid route upstreamApiKey/i, '路由级上游 Key 格式无效'],
    [/Invalid route/i, '路由格式无效'],
    [/Invalid baseURL/i, '上游 Base URL 格式无效'],
    [/Unsafe baseURL/i, 'Base URL 不安全：只允许 http/https，且不能包含用户名、密码、查询参数或锚点'],
    [/Virtual API keys require an upstreamApiKey on every group route/i, '使用虚拟 Key 时，每个分组路由都必须配置上游 API Key'],
    [/Virtual API keys require an upstreamApiKey on every effective route/i, '使用虚拟 Key 时，每个模型实际使用的路由都必须配置上游 API Key'],
    [/Group requires models/i, '分组至少需要一个模型'],
    [/Invalid or duplicate model id/i, '模型 ID 为空或重复'],
    [/Invalid upstreamModel/i, '上游模型名格式无效'],
    [/Invalid model defaults/i, '模型 defaults 必须是 JSON 对象'],
    [/Invalid protocol defaults/i, '模型 defaults 只能包含 chat/responses/messages，且不能覆盖 model 或路由字段'],
    [/Unknown model route protocol/i, '模型路由包含未知协议'],
    [/Model has no available route/i, '模型没有可用的协议路由'],
    [/Invalid listen address/i, '监听地址或端口无效'],
    [/Invalid maxBodyBytes/i, '最大请求体大小无效'],
    [/Invalid maxResponseBytes/i, '最大响应体大小无效'],
    [/requestAudit\.trustedProxies/i, '审计可信代理必须是精确 IP 地址，不接受 CIDR、主机名或端口'],
    [/requestAudit\.maxEntries/i, '审计内存条数必须在 1–2000 之间'],
    [/requestAudit\.maxPromptChars/i, '审计 System Prompt 字符上限必须在 1–65536 之间'],
    [/requestAudit/i, '审计配置无效：检查字段名称、布尔开关及 IP 来源'],
    [/rateLimits/i, '限流配置无效：仅支持已知字段及有效的非负安全整数'],
    [/Invalid requestTimeoutMs/i, '总请求超时无效'],
    [/Invalid upstreamTimeoutMs/i, '上游空闲超时无效'],
    [/Upstream credential must not be a virtual API key/i, '上游 Key 不能与虚拟 Key 相同'],
    [/Required API key environment variable is missing/i, '密钥环境变量未设置，无法解析配置'],
    [/Config must have mode 0600/i, '配置文件权限必须为 0600（chmod 600 config/local.json）'],
    [/Admin password file must have mode 0600/i, '管理员密码文件权限必须为 0600'],
    [/Invalid configuration JSON/i, '配置文件不是合法 JSON'],
  ];
  for (const [pattern, replacement] of table) {
    const match = raw.match(pattern);
    if (match) return { message: typeof replacement === 'function' ? replacement(match) : replacement, detail: null };
  }
  return { message: '操作失败，请在本机检查配置或服务日志', detail: null };
}

export function assertGroupId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw httpError(400, '分组 ID 只能包含字母、数字、点、下划线和短横线，长度 1-64，且不能以符号开头');
  }
  return id;
}

export function assertModelId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id) || /\s/.test(id)) {
    throw httpError(400, '模型 ID 不能为空、不能包含空白或控制字符，长度不超过 200');
  }
  return id;
}

export function assertLabel(label) {
  if (label === undefined || label === null) return null;
  if (typeof label !== 'string' || label.length > 80) throw httpError(400, '标签必须是不超过 80 字符的文本');
  return label.trim();
}

export function assertNote(note) {
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string' || note.length > 4000) throw httpError(400, '备注不能超过 4000 字符');
  return note;
}

export function normalizeSecret(value, name = '密钥') {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'string') {
    if (value.length > 4096 || /[\r\n\u0000]/.test(value)) throw httpError(400, name + '格式无效');
    return value;
  }
  if (isObject(value) && typeof value.env === 'string') {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.env)) throw httpError(400, '环境变量名无效');
    return { env: value.env };
  }
  throw httpError(400, name + '必须是字符串、{env: "NAME"} 或 null');
}

export function normalizeRoute(route, existing, name = '路由') {
  if (route === null) return null;
  if (!isObject(route)) throw httpError(400, name + '必须是 JSON 对象');
  const merged = existing ? structuredClone(existing) : {};
  if (route.baseURL !== undefined) {
    if (typeof route.baseURL !== 'string' || !route.baseURL.trim()) throw httpError(400, 'Base URL 不能为空');
    merged.baseURL = route.baseURL.trim();
  }
  if (route.auth !== undefined) {
    if (route.auth === null) delete merged.auth;
    else if (route.auth === 'bearer' || route.auth === 'x-api-key') merged.auth = route.auth;
    else throw httpError(400, '鉴权方式只能是 bearer 或 x-api-key');
  }
  const key = normalizeSecret(route.upstreamApiKey, '路由级上游 Key');
  if (key !== undefined) {
    if (key === null) delete merged.upstreamApiKey;
    else merged.upstreamApiKey = key;
  }
  if (!merged.baseURL) throw httpError(400, '路由必须包含 Base URL');
  return merged;
}

export function normalizeModel(body, existing = null) {
  assertSafeKeys(body);
  if (!isObject(body)) throw httpError(400, '模型必须是一个 JSON 对象');
  const model = existing ? structuredClone(existing) : {};
  if (body.id !== undefined) model.id = assertModelId(body.id);
  else if (!existing) throw httpError(400, '模型 ID 不能为空');

  const optionalStrings = ['name', 'upstreamModel', 'metadataSource'];
  for (const field of optionalStrings) {
    if (body[field] === undefined) continue;
    if (body[field] === null || body[field] === '') delete model[field];
    else if (typeof body[field] !== 'string' || body[field].length > 500) throw httpError(400, field + ' 必须是不超过 500 字符的文本');
    else model[field] = body[field];
  }
  for (const field of ['contextWindow', 'maxOutputTokens']) {
    if (body[field] === undefined) continue;
    if (body[field] === null) delete model[field];
    else if (!Number.isSafeInteger(body[field]) || body[field] <= 0) throw httpError(400, field + ' 必须是正整数，或留空表示不限制');
    else model[field] = body[field];
  }
  if (body.input !== undefined) {
    if (body.input === null) delete model.input;
    else if (!Array.isArray(body.input) || body.input.some(item => typeof item !== 'string' || !item)) throw httpError(400, 'input 必须是字符串数组');
    else model.input = [...new Set(body.input)];
  }
  for (const field of ['reasoningEfforts', 'availableReasoningEfforts', 'providerCompat', 'provenance', 'sourceMetadata']) {
    if (body[field] === undefined) continue;
    if (body[field] === null) delete model[field];
    else if (!isObject(body[field]) && !Array.isArray(body[field])) throw httpError(400, field + ' 必须是 JSON 对象或数组');
    else model[field] = structuredClone(body[field]);
  }
  if (body.defaults !== undefined) {
    if (body.defaults === null) delete model.defaults;
    else if (!isObject(body.defaults)) throw httpError(400, 'defaults 必须是 JSON 对象');
    else model.defaults = structuredClone(body.defaults);
  }
  if (body.routes !== undefined) {
    if (!isObject(body.routes)) throw httpError(400, 'routes 必须是 JSON 对象');
    for (const [protocol, route] of Object.entries(body.routes)) {
      if (!PROTOCOLS.includes(protocol)) throw httpError(400, '未知协议：' + protocol);
      if (route === null) {
        if (model.routes) delete model.routes[protocol];
      } else {
        model.routes ??= {};
        model.routes[protocol] = normalizeRoute(route, model.routes[protocol], protocol + ' 路由');
      }
    }
    if (model.routes && !Object.keys(model.routes).length) delete model.routes;
  }
  return model;
}

export function groupById(raw, id) {
  const group = (raw.groups ?? []).find(item => item.id === id);
  if (!group) throw httpError(404, '分组不存在：' + id);
  return group;
}

export function resolvedGroupById(resolved, id) {
  return (resolved.groups ?? []).find(item => item.id === id) ?? null;
}

export function groupPayload(result, id) {
  const rawGroup = result.raw.groups.find(item => item.id === id);
  if (!rawGroup) return null;
  const resolvedGroup = resolvedGroupById(result.resolved, id) ?? rawGroup;
  return sanitizeGroup(rawGroup, resolvedGroup);
}

export function findKeyEntry(rawGroup, resolvedGroup, field, keyId) {
  const rawList = Array.isArray(rawGroup[field]) ? rawGroup[field] : [];
  const resolvedList = Array.isArray(resolvedGroup[field]) ? resolvedGroup[field] : [];
  const index = rawList.findIndex((entry, position) => hashKey(resolvedList[position] ?? (typeof entry === 'string' ? entry : '')) === keyId);
  if (index === -1) throw httpError(404, '访问密钥不存在或已被轮换');
  return { index, entry: rawList[index], resolved: resolvedList[index] };
}

export function setKeyLabel(rawGroup, field, keyId, label) {
  const metaName = metaField(field);
  rawGroup[metaName] ??= {};
  if (label) rawGroup[metaName][keyId] = { ...(rawGroup[metaName][keyId] ?? {}), label, createdAt: rawGroup[metaName][keyId]?.createdAt ?? new Date().toISOString() };
  else if (rawGroup[metaName][keyId]) delete rawGroup[metaName][keyId].label;
  if (!Object.keys(rawGroup[metaName]).length) delete rawGroup[metaName];
}

export function recordKeyMeta(rawGroup, field, resolvedKey, label) {
  const metaName = metaField(field);
  rawGroup[metaName] ??= {};
  rawGroup[metaName][hashKey(resolvedKey)] = {
    ...(rawGroup[metaName][hashKey(resolvedKey)] ?? {}),
    ...(label ? { label } : {}),
    createdAt: new Date().toISOString(),
  };
}

export function removeKeyMeta(rawGroup, field, keyId) {
  const metaName = metaField(field);
  if (rawGroup[metaName]?.[keyId]) {
    delete rawGroup[metaName][keyId];
    if (!Object.keys(rawGroup[metaName]).length) delete rawGroup[metaName];
  }
}

export class ConfigStore {
  constructor({ configPath, backupDir, reload }) {
    this.configPath = configPath;
    this.backupDir = backupDir;
    this.reload = reload;
    this.chain = Promise.resolve();
    this.revision = 0;
    this.lastApplied = null;
  }

  async read() {
    const raw = await readRawConfig(this.configPath);
    const validated = validateConfig(raw);
    const snapshot = { raw, resolved: validated.resolved, compiled: validated.compiled, summary: validated.summary };
    // The first read initializes the running configuration. Later disk reads
    // may contain external edits that have not been applied to the router.
    this.lastApplied ??= structuredClone(snapshot);
    return snapshot;
  }

  readVersioned() {
    // Wait for writes (including reload/rollback) and capture the revision in
    // the same queue slot as the configuration it describes.
    return this.enqueue(async () => ({ ...await this.read(), revision: this.revision }));
  }

  reloadCurrent() {
    return this.enqueue(async () => {
      const snapshot = await this.read();
      await this.reload(snapshot.resolved);
      this.lastApplied = structuredClone(snapshot);
      this.revision += 1;
      return { ...snapshot, revision: this.revision };
    });
  }

  enqueue(task) {
    const next = this.chain.then(task, task);
    this.chain = next.then(() => {}, () => {});
    return next;
  }

  async apply(raw, before, label, previousBytes) {
    if (raw.adminPort !== undefined && (!Number.isSafeInteger(raw.adminPort) || raw.adminPort < 1 || raw.adminPort > 65535)) {
      throw httpError(400, '管理台端口必须在 1-65535 之间');
    }
    const effectiveRouterPort = raw.port ?? 8787;
    if (raw.adminPort !== undefined && effectiveRouterPort === raw.adminPort) {
      throw httpError(400, '管理台端口不能与路由端口相同');
    }
    const { resolved, compiled, summary } = validateConfig(raw);
    const backup = await createBackup(this.configPath, this.backupDir, { label }).catch(error => {
      throw httpError(500, '无法创建配置备份，已取消写入');
    });
    await atomicWriteConfig(this.configPath, raw);
    try {
      await this.reload(resolved);
    } catch (error) {
      let rolledBack = true;
      try {
        if (previousBytes !== undefined) await atomicWriteConfigBytes(this.configPath, previousBytes);
        else await atomicWriteConfig(this.configPath, before.raw);
      } catch { rolledBack = false; }
      if (before) {
        try { await this.reload(before.resolved); } catch { rolledBack = false; }
      }
      throw httpError(500, rolledBack ? '配置已回滚：路由热重载失败' : '路由热重载失败，配置回滚未完成，请在本机检查备份与服务状态');
    }
    this.lastApplied = structuredClone({ raw, resolved, compiled, summary });
    this.revision += 1;
    return { raw, resolved, compiled, summary, backup };
  }

  update(mutator, { label = 'update' } = {}) {
    return this.enqueue(async () => {
      const before = await this.read();
      const raw = structuredClone(before.raw);
      const result = await mutator(raw, before);
      if (result === false) return { unchanged: true, before };
      const saved = await this.apply(raw, before, label);
      return { ...saved, before };
    });
  }

  async removeExpiredMRKeys(now = Date.now()) {
    if (!Number.isFinite(now)) throw new Error('Invalid MR expiry cleanup time');
    const removed = [];
    const result = await this.update((raw, before) => {
      for (const group of raw.groups) {
        const resolved = resolvedGroupById(before.resolved, group.id);
        for (let index = (group.virtualApiKeys?.length ?? 0) - 1; index >= 0; index--) {
          const key = resolved?.virtualApiKeys?.[index];
          if (typeof key !== 'string') continue;
          const keyId = hashKey(key);
          const expiry = normalizeMRExpiresAt(group.virtualKeyMeta?.[keyId]?.expiresAt);
          if (expiry === null || Date.parse(expiry) > now) continue;
          group.virtualApiKeys.splice(index, 1);
          removeKeyMeta(group, 'virtualApiKeys', keyId);
          removed.push({ group: group.id, keyId });
        }
        // Delete the expired credential, not its routes/models or the whole group.
        // Empty groups remain manageable but cannot accept traffic until re-enabled.
        if (!(group.apiKeys?.length || group.virtualApiKeys?.length)) group.enabled = false;
      }
      return removed.length > 0;
    }, { label: 'key.expire' });
    return { ...result, removed };
  }

  replace(raw, { label = 'replace' } = {}) {
    return this.enqueue(async () => {
      // IO, permissions and symlink errors must still fail closed. Only parsing
      // and validation may fall back to the last applied configuration.
      const previousBytes = await readConfigBytes(this.configPath);
      let before;
      try {
        const previousRaw = JSON.parse(previousBytes.toString('utf8'));
        before = { raw: previousRaw, ...validateConfig(previousRaw) };
      } catch { before = this.lastApplied; }
      const saved = await this.apply(raw, before, label, previousBytes);
      return { ...saved, before };
    });
  }

  async snapshot() {
    return await this.readVersioned();
  }

  async listBackups() {
    return await listBackups(this.backupDir);
  }

  async createBackup(label = 'manual') {
    return await this.enqueue(() => createBackup(this.configPath, this.backupDir, { label }));
  }

  async readBackup(name) {
    const raw = await readBackup(this.backupDir, name);
    const validated = validateConfig(raw);
    return { raw, ...validated };
  }

  async restoreBackup(name) {
    const backup = await this.readBackup(name);
    const saved = await this.replace(backup.raw, { label: 'restore' });
    return { ...saved, restoredFrom: name };
  }

  async removeBackup(name) {
    await removeBackup(this.backupDir, name);
  }
}
