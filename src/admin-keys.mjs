import { randomBytes } from 'node:crypto';
import { httpError, normalizeSecret, recordKeyMeta } from './admin-store.mjs';
import { PROTOCOLS } from './router.mjs';

export function assertProtocol(protocol) {
  if (!PROTOCOLS.includes(protocol)) throw httpError(400, '未知协议：' + protocol);
  return protocol;
}

export function modelFrom(value) {
  return typeof value === 'string' ? { id: value } : value;
}

export function addAccessKey(group, field, value, label) {
  const normalized = normalizeSecret(value, '访问密钥');
  if (!normalized) throw httpError(400, '访问密钥不能为空');
  group[field] ??= [];
  group[field].push(normalized);
  if (typeof normalized === 'string') recordKeyMeta(group, field, normalized, label);
  else if (process.env[normalized.env]) recordKeyMeta(group, field, process.env[normalized.env], label);
}

export function addGeneratedVirtualKey(group, label = '默认密钥') {
  const key = 'mr-' + randomBytes(32).toString('hex');
  group.virtualApiKeys ??= [];
  group.virtualApiKeys.push(key);
  recordKeyMeta(group, 'virtualApiKeys', key, label);
  return key;
}

export function keyCount(group) {
  return (group.apiKeys?.length ?? 0) + (group.virtualApiKeys?.length ?? 0);
}

export function fileToDisplay(projectRoot, path) {
  if (!path) return null;
  if (path.startsWith(projectRoot)) return path.slice(projectRoot.length).replace(/^\/+/, '');
  return path;
}
