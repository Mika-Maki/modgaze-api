import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRawConfig, readBackup } from '../src/config.mjs';
test('private config and backup readers reject symlink final components', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-private-files-'));
  const source = join(root, 'outside.json');
  await writeFile(source, '{"synthetic":true}', { mode: 0o600 });
  const config = join(root, 'config.json');
  const backups = join(root, 'backups');
  await mkdir(backups);
  await symlink(source, config);
  await symlink(source, join(backups, 'backup.json'));
  await assert.rejects(() => readRawConfig(config), error => error.code === 'ELOOP');
  await assert.rejects(() => readBackup(backups, 'backup.json'), error => error.code === 'ELOOP');
  assert.deepEqual(await readRawConfig(source), { synthetic: true });
});
