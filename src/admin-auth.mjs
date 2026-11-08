import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertPassword(password) {
  if (typeof password !== 'string') throw new Error('Password must be a string');
  if (password.length < MIN_PASSWORD) throw new Error('Password must be at least ' + MIN_PASSWORD + ' characters');
  if (password.length > MAX_PASSWORD) throw new Error('Password is too long');
  if (!password.trim()) throw new Error('Password cannot be blank');
  if (password.includes('\0')) throw new Error('Password contains an invalid character');
}

export function generatePassword() {
  return randomBytes(18).toString('base64url');
}

export async function derivePassword(password, salt, params = SCRYPT) {
  const buffer = await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY });
  return Buffer.from(buffer);
}

export async function hashPassword(password, params = SCRYPT) {
  assertPassword(password);
  const salt = randomBytes(24);
  const hash = await derivePassword(password, salt, params);
  return {
    version: 1,
    algorithm: 'scrypt',
    params: { ...params },
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function parseRecord(text, path) {
  let record;
  try { record = JSON.parse(text); } catch { throw new Error('Admin password file is not valid JSON'); }
  if (!isObject(record) || record.version !== 1 || record.algorithm !== 'scrypt') throw new Error('Unsupported admin password file format');
  const params = record.params;
  if (!isObject(params) || !Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p) || !Number.isInteger(params.keylen)) {
    throw new Error('Admin password file has invalid scrypt parameters');
  }
  if (params.N < 16384 || params.N > 1048576 || params.r < 8 || params.r > 32 || params.p < 1 || params.p > 4 || params.keylen < 32 || params.keylen > 128) {
    throw new Error('Admin password file has unsafe scrypt parameters');
  }
  if (typeof record.salt !== 'string' || typeof record.hash !== 'string') throw new Error('Admin password file is missing salt or hash');
  const salt = Buffer.from(record.salt, 'base64');
  const hash = Buffer.from(record.hash, 'base64');
  if (salt.length < 16 || hash.length < 32) throw new Error('Admin password file has a truncated salt or hash');
  return { ...record, saltBuffer: salt, hashBuffer: hash, sourcePath: path };
}

export class AdminAuth {
  constructor(path) {
    this.path = path;
    this.cached = null;
  }

  async load({ force = false } = {}) {
    let info;
    try { info = await stat(this.path); }
    catch (error) {
      if (error.code === 'ENOENT') { this.cached = null; return null; }
      throw error;
    }
    if (!force && this.cached && this.cached.mtimeMs === info.mtimeMs && this.cached.ctimeMs === info.ctimeMs && this.cached.size === info.size && this.cached.mode === info.mode && this.cached.ino === info.ino) return this.cached.record;
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Admin password file must have mode 0600');
    const text = await readFile(this.path, 'utf8');
    const record = parseRecord(text, this.path);
    record.fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 20);
    record.updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : null;
    this.cached = { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, mode: info.mode, ino: info.ino, record };
    return record;
  }

  async status() {
    const record = await this.load();
    return record ? { configured: true, algorithm: record.algorithm, updatedAt: record.updatedAt, fingerprint: record.fingerprint } : { configured: false };
  }

  async verify(password) {
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) return false;
    const record = await this.load();
    if (!record) return false;
    const params = record.params;
    let derived;
    try {
      derived = await derivePassword(password, record.saltBuffer, { N: params.N, r: params.r, p: params.p, keylen: params.keylen });
    } catch { return false; }
    return derived.length === record.hashBuffer.length && timingSafeEqual(derived, record.hashBuffer);
  }

  async save(record, { exclusive = false } = {}) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const text = JSON.stringify(record, null, 2) + '\n';
    if (exclusive) {
      const handle = await open(this.path, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await chmod(this.path, 0o600);
      this.cached = null;
      return await this.load({ force: true });
    }
    const temporary = join(dirname(this.path), '.' + basename(this.path) + '.' + randomBytes(8).toString('hex') + '.tmp');
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, this.path); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    await chmod(this.path, 0o600);
    this.cached = null;
    return await this.load({ force: true });
  }

  async setPassword(password, { exclusive = false } = {}) {
    assertPassword(password);
    const record = await hashPassword(password);
    const saved = await this.save(record, { exclusive });
    return { configured: true, updatedAt: saved.updatedAt, fingerprint: saved.fingerprint };
  }

  async remove() {
    try { await unlink(this.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.cached = null;
  }
}

export const ADMIN_PASSWORD_MIN_LENGTH = MIN_PASSWORD;
