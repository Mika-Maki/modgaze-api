import { chmod, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { compileConfig } from './router.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEnvRef = value => isObject(value) && typeof value.env === 'string' && !Object.hasOwn(value, '__proto__');

// Open first, then check the same inode. O_NOFOLLOW rejects planted symlinks
// without a check/use race on the final path component.
async function readPrivateFile(path, label, encoding = 'utf8') {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(label + ' must be a regular file');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error(label + ' must have mode 0600');
    return await handle.readFile(encoding);
  } finally { await handle.close(); }
}

export async function readRawConfig(path) {
  return JSON.parse(await readPrivateFile(path, 'Config'));
}

// Recovery needs the original bytes even when they are not valid JSON. Keep
// the same private-file checks as normal configuration reads.
export async function readConfigBytes(path) {
  return await readPrivateFile(path, 'Config', null);
}

export function resolveSecretValue(value) {
  if (isEnvRef(value)) {
    const resolved = process.env[value.env];
    if (!resolved) throw new Error('Required API key environment variable is missing: ' + value.env);
    return resolved;
  }
  return value;
}

// Resolve only the documented credential slots. Model defaults and raw
// extension fields are never scanned, so they stay byte-for-byte untouched.
export function resolveConfigSecrets(raw) {
  const config = structuredClone(raw);
  for (const group of config.groups ?? []) {
    if (Array.isArray(group.apiKeys)) group.apiKeys = group.apiKeys.map(resolveSecretValue);
    if (Array.isArray(group.virtualApiKeys)) group.virtualApiKeys = group.virtualApiKeys.map(resolveSecretValue);
    if (group.upstreamApiKey !== undefined) group.upstreamApiKey = resolveSecretValue(group.upstreamApiKey);
    for (const route of Object.values(group.routes ?? {})) {
      if (route && route.upstreamApiKey !== undefined) route.upstreamApiKey = resolveSecretValue(route.upstreamApiKey);
    }
    for (const model of group.models ?? []) {
      for (const route of Object.values(model.routes ?? {})) {
        if (route && route.upstreamApiKey !== undefined) route.upstreamApiKey = resolveSecretValue(route.upstreamApiKey);
      }
    }
  }
  return config;
}

export function validateConfig(raw) {
  const resolved = resolveConfigSecrets(raw);
  const compiled = compileConfig(resolved).config;
  return { resolved, compiled, summary: configSummary(compiled) };
}

export function configSummary(compiled) {
  const active = compiled.groups.filter(group => group.enabled !== false);
  return {
    groups: compiled.groups.length,
    activeGroups: active.length,
    models: compiled.groups.reduce((total, group) => total + group.models.length, 0),
    virtualKeys: compiled.groups.reduce((total, group) => total + group.virtualApiKeys.length, 0),
    apiKeys: compiled.groups.reduce((total, group) => total + group.apiKeys.length, 0),
    protocols: [...new Set(compiled.groups.flatMap(group => [
      ...Object.keys(group.routes ?? {}),
      ...group.models.flatMap(model => Object.keys(model.routes ?? {})),
    ]))].sort(),
    host: compiled.host,
    port: compiled.port,
  };
}

export async function atomicWriteConfig(path, value) {
  return await atomicWriteConfigBytes(path, JSON.stringify(value, null, 2) + '\n');
}

export async function atomicWriteConfigBytes(path, bytes) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, '.' + basename(path) + '.' + randomBytes(8).toString('hex') + '.tmp');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await chmod(path, 0o600);
}

const BACKUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.json$/;

export function backupPath(directory, name) {
  if (typeof name !== 'string' || !BACKUP_PATTERN.test(name) || name.startsWith('.')) throw new Error('Invalid backup name');
  const target = resolve(directory, name);
  if (dirname(target) !== resolve(directory)) throw new Error('Invalid backup name');
  return target;
}

export async function createBackup(configPath, directory, { label = 'auto' } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const clean = String(label).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'auto';
  const name = 'backup-' + stamp + '-' + clean + '-' + randomBytes(3).toString('hex') + '.json';
  const target = backupPath(directory, name);
  await copyFile(configPath, target);
  await chmod(target, 0o600);
  await pruneBackups(directory, 40);
  return name;
}

async function pruneBackups(directory, keep) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !BACKUP_PATTERN.test(entry.name)) continue;
    try {
      const info = await stat(join(directory, entry.name));
      files.push({ name: entry.name, mtimeMs: info.mtimeMs });
    } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(files.slice(keep).map(file => unlink(join(directory, file.name)).catch(() => {})));
}

export async function listBackups(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !BACKUP_PATTERN.test(entry.name)) continue;
    try {
      const info = await stat(join(directory, entry.name));
      files.push({ name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
    } catch {}
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function readBackup(directory, name) {
  const path = backupPath(directory, name);
  return JSON.parse(await readPrivateFile(path, 'Backup file'));
}

export async function removeBackup(directory, name) {
  const path = backupPath(directory, name);
  await unlink(path);
}
