import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.mjs';
const path = fileURLToPath(new URL('../config/local.json', import.meta.url));
const exportPath = fileURLToPath(new URL('../config/virtual-keys.private.json', import.meta.url));
try {
  const config = JSON.parse(await readFile(path, 'utf8'));
  for (const group of config.groups) {
    if (!group.upstreamApiKey) {
      if (group.apiKeys?.length !== 1) throw new Error('ambiguous');
      group.upstreamApiKey = group.apiKeys[0];
    }
    if (!group.virtualApiKeys?.length) group.virtualApiKeys = ['mr-' + randomBytes(32).toString('hex')];
  }
  // Resolve environment credentials for validation only; preserve references
  // in the configuration and client export written below.
  validateConfig(config);
  const temporary = path + '.virtual.tmp';
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
  const clients = config.groups.map(g => ({ group: g.id, virtualApiKeys: g.virtualApiKeys, models: g.models.map(m => m.id) }));
  await writeFile(exportPath, JSON.stringify(clients, null, 2) + '\n', { mode: 0o600 });
  await chmod(exportPath, 0o600);
  console.log(JSON.stringify({ updated: config.groups.length, keys: '[REDACTED]', clientFile: 'config/virtual-keys.private.json', restartRequired: true }));
} catch { console.error('Virtual key setup failed; check configuration and temporary file. No credentials printed.'); process.exitCode = 1; }
