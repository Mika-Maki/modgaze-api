import { createHash, timingSafeEqual } from 'node:crypto';
import { assertSafeKeys, httpError } from './admin-store.mjs';

export const COOKIE_NAME = 'mr_admin_session';
export const PUBLIC_ORIGIN_REQUEST = Symbol('publicOriginRequest');
export const BODY_LIMIT = 8 * 1024 * 1024;

export const secureRequest = req => Boolean(req.socket.encrypted || req[PUBLIC_ORIGIN_REQUEST]);
export const cookieName = req => secureRequest(req) ? COOKIE_NAME + '_tls' : COOKIE_NAME;

export function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseCookies(header) {
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

export function setSessionCookie(res, raw, maxAge) {
  res.setHeader('set-cookie', cookieName(res.req) + '=' + raw + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secureRequest(res.req) ? '; Secure' : ''));
}

export function clearSessionCookie(res) {
  res.setHeader('set-cookie', cookieName(res.req) + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (secureRequest(res.req) ? '; Secure' : ''));
}

export function sendJson(res, status, payload, headers = {}) {
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

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const bytes = Buffer.from(text);
  res.writeHead(status, {
    'content-type': type,
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(bytes);
}

export async function readJson(req, limit = BODY_LIMIT) {
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
  if (!isPlainObject(parsed)) throw httpError(400, '请求体必须是 JSON 对象');
  assertSafeKeys(parsed);
  return parsed;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeSegment(value) {
  try { return decodeURIComponent(value); }
  catch { throw httpError(400, 'URL 编码无效'); }
}
