import { randomBytes } from 'node:crypto';
import { cookieName, digest, parseCookies, secureRequest } from './admin-http.mjs';

export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create(req) {
    const raw = randomBytes(32).toString('hex');
    const record = {
      secureTransport: secureRequest(req),
      csrf: randomBytes(32).toString('hex'),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      expiresAt: Math.min(Date.now() + SESSION_ABSOLUTE_MS, Date.now() + SESSION_IDLE_MS),
    };
    this.sessions.set(digest(raw), record);
    return { raw, ...record, maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000) };
  }

  fromRequest(req) {
    const raw = parseCookies(req.headers.cookie)[cookieName(req)];
    if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) return null;
    const hash = digest(raw);
    const record = this.sessions.get(hash);
    if (!record || record.secureTransport !== secureRequest(req)) return null;
    const now = Date.now();
    if (now > record.expiresAt || now - record.lastSeen > SESSION_IDLE_MS) {
      this.sessions.delete(hash);
      return null;
    }
    record.lastSeen = now;
    record.expiresAt = Math.min(record.createdAt + SESSION_ABSOLUTE_MS, now + SESSION_IDLE_MS);
    return { raw, hash, record };
  }

  destroy(req) {
    const raw = parseCookies(req.headers.cookie)[cookieName(req)];
    if (raw) this.sessions.delete(digest(raw));
  }

  clear() {
    this.sessions.clear();
  }

  prune() {
    const now = Date.now();
    for (const [hash, record] of this.sessions) {
      if (now > record.expiresAt || now - record.lastSeen > SESSION_IDLE_MS) this.sessions.delete(hash);
    }
  }
}
