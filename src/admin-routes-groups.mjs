import { createHash, randomBytes } from 'node:crypto';
import { PROTOCOLS } from './router.mjs';
import {
  assertGroupId, assertLabel, assertNote, findKeyEntry, groupById, httpError,
  normalizeModel, normalizeRoute, normalizeSecret, recordKeyMeta, removeKeyMeta,
  resolvedGroupById, sanitizeGroup, setKeyLabel,
} from './admin-store.mjs';
import { addAccessKey, addGeneratedVirtualKey, assertProtocol, keyCount, modelFrom } from './admin-keys.mjs';
import { normalizeGroupRateLimits } from './rate-limit.mjs';
import { normalizeMRExpiresAt } from './key-expiry.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Group, model, route and access-key management. Configuration writes go through
// the shared ConfigStore transaction; these handlers only validate and shape payloads.
export function createGroupRoutes({ store, readJson, sendJson, auditEvent, groupPayload, groupTest }) {
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
        rateLimits: normalizeGroupRateLimits(body.rateLimits),
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
          if (body.rateLimits !== undefined) {
            normalizeGroupRateLimits(body.rateLimits);
            group.rateLimits = normalizeGroupRateLimits({ ...normalizeGroupRateLimits(group.rateLimits), ...body.rateLimits });
          }
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
          if (body.rateLimits !== undefined) {
            normalizeGroupRateLimits(body.rateLimits);
            clone.rateLimits = normalizeGroupRateLimits({ ...normalizeGroupRateLimits(source.rateLimits), ...body.rateLimits });
          }
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
          if (Object.hasOwn(body, 'label')) setKeyLabel(group, 'virtualApiKeys', keyId, assertLabel(body.label));
          if (Object.hasOwn(body, 'expiresAt')) {
            const expiresAt = normalizeMRExpiresAt(body.expiresAt);
            group.virtualKeyMeta ??= {};
            group.virtualKeyMeta[keyId] = { ...(group.virtualKeyMeta[keyId] ?? {}), expiresAt };
          }
          return true;
        }, { label: 'key.update' });
        auditEvent(method === 'DELETE' ? 'key.delete' : 'key.update', id + '/virtual/' + keyId, true);
        sendJson(res, 200, { ok: true, summary: result.summary, backup: result.backup, group: groupPayload(result, id) });
        return;
      }
      if (parts[3] === 'api-keys' && (method === 'PATCH' || method === 'DELETE')) {
        const keyId = parts[4];
        const body = method === 'PATCH' ? await readJson(req) : {};
        if (Object.hasOwn(body, 'expiresAt')) throw httpError(400, 'MR Expires at 仅适用于 MR 虚拟 Key');
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
        const expiresAt = normalizeMRExpiresAt(group.virtualKeyMeta?.[keyId]?.expiresAt);
        newKey = 'mr-' + randomBytes(32).toString('hex');
        group.virtualApiKeys[found.index] = newKey;
        removeKeyMeta(group, 'virtualApiKeys', keyId);
        recordKeyMeta(group, 'virtualApiKeys', newKey, label);
        const newKeyId = createHash('sha256').update(newKey).digest('hex').slice(0, 16);
        group.virtualKeyMeta[newKeyId].expiresAt = expiresAt;
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

  return { handleGroupCollection, handleGroups };
}
