import { randomBytes } from 'node:crypto';
import { hashKey, httpError, normalizeSecret, recordKeyMeta } from './admin-store.mjs';
import { PROTOCOLS } from './router.mjs';
import { normalizeNewMRExpiresAt } from './key-expiry.mjs';
import { normalizeTokenLimits } from './token-usage.mjs';

export function assertProtocol(protocol) {
  if (!PROTOCOLS.includes(protocol)) throw httpError(400, '未知协议：' + protocol);
  return protocol;
}

export function modelFrom(value) {
  return typeof value === 'string' ? { id: value } : value;
}

export function addAccessKey(group, field, value, label, expiresAt, tokenLimits) {
  const normalized = normalizeSecret(value, '访问密钥');
  if (!normalized) throw httpError(400, '访问密钥不能为空');
  if (field !== 'virtualApiKeys' && expiresAt !== undefined) throw httpError(400, 'MR Expires at 仅适用于 MR 虚拟 Key');
  const deadline = field === 'virtualApiKeys' ? normalizeNewMRExpiresAt(expiresAt) : null;
  const limits = field === 'virtualApiKeys' ? normalizeTokenLimits(tokenLimits) : null;
  group[field] ??= [];
  group[field].push(normalized);
  const resolved = typeof normalized === 'string' ? normalized : process.env[normalized.env];
  if (resolved) {
    recordKeyMeta(group, field, resolved, label);
    if (field === 'virtualApiKeys') Object.assign(group.virtualKeyMeta[hashKey(resolved)], { expiresAt: deadline, tokenLimits: limits });
  }
}

export function addGeneratedVirtualKey(group, label = '默认密钥', expiresAt, tokenLimits) {
  const key = 'mr-' + randomBytes(32).toString('hex');
  addAccessKey(group, 'virtualApiKeys', key, label, expiresAt, tokenLimits);
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
