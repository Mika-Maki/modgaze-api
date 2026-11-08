#!/usr/bin/env node
/**
 * Create a minimal config/local.json without any preparation document.
 * Run: node scripts/init-config.mjs [--force]
 *
 * The generated config is valid but inert: one placeholder group points at an
 * unreachable example host. Replace baseURL, keys and model ids (or manage them
 * in the admin WebUI) before routing real traffic. An existing config is left
 * untouched unless --force is given; --force keeps a backup in run/backups.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileConfig } from '../src/router.mjs';
import { createBackup } from '../src/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(ROOT, 'config/local.json');
const backupDir = resolve(ROOT, 'run/backups');
const args = process.argv.slice(2);
let force = false;
for (const arg of args) {
  if (arg === '--force') force = true;
  else {
    console.error(JSON.stringify({ event: 'config_create_failed', code: 'unknown-option', hint: 'usage: node scripts/init-config.mjs [--force]' }));
    process.exit(2);
  }
}

function fail(code) { throw Object.assign(new Error(code), { code }); }

function buildConfig() {
  return {
    host: '127.0.0.1',
    port: 8787,
    adminPort: 8788,
    maxBodyBytes: 67108864,
    upstreamTimeoutMs: 120000,
    requestTimeoutMs: 600000,
    accessLog: false,
    groups: [{
      id: 'default',
      name: 'Placeholder provider',
      enabled: true,
      apiKeys: ['sk-local-' + randomBytes(24).toString('hex')],
      routes: {
        chat: { baseURL: 'https://example.invalid/v1', auth: 'bearer' },
      },
      models: [{ id: 'example-model' }],
    }],
  };
}

async function writeConfig(text) {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('unsafe-output-directory');
  let exists = false;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) fail('unsafe-output-file');
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (exists && !force) return { created: false, backup: null };
  const backup = exists ? await createBackup(target, backupDir, { label: 'config-init' }) : null;
  await chmod(parent, 0o700);
  const temporary = resolve(parent, '.local.' + randomBytes(8).toString('hex') + '.tmp');
  let handle;
  let created = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
  return { created: true, backup };
}

try {
  const config = buildConfig();
  compileConfig(config);
  const result = await writeConfig(JSON.stringify(config, null, 2) + '\n');
  if (!result.created) {
    console.log(JSON.stringify({ event: 'config_exists', file: 'config/local.json', hint: 'delete it or rerun with --force to regenerate (a backup is kept)' }));
  } else {
    console.log(JSON.stringify({ event: 'config_created', file: 'config/local.json', groups: config.groups.length, models: 1, apiKey: config.groups[0].apiKeys[0], ...(result.backup ? { backup: result.backup } : {}) }));
  }
} catch (error) {
  const known = error?.code === 'unsafe-output-directory' || error?.code === 'unsafe-output-file';
  const code = known ? error.code
    : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'output-permission-denied'
      : 'config-write-failed';
  console.error(JSON.stringify({ event: 'config_create_failed', code }));
  process.exitCode = 1;
}
