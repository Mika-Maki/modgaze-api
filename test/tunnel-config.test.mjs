import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);

test('tunnel host template is sanitized and local overrides take precedence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'modgaze-tunnel-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'cf'));
  await writeFile(join(directory, 'tunnelup.sh'), await readFile(new URL('tunnelup.sh', root)));
  const template = await readFile(new URL('cf/tunnel.host', root), 'utf8');
  assert.equal(template.trim(), 'api.example.com');
  await writeFile(join(directory, 'cf/tunnel.host'), template);
  const env = { ...process.env };
  for (const key of ['TUNNEL_HOST', 'TUNNEL_HOST_FILE']) delete env[key];
  const url = extra => execFileSync('bash', [join(directory, 'tunnelup.sh'), 'url'], { env: { ...env, ...extra }, encoding: 'utf8' }).trim();
  assert.equal(url(), 'https://api.example.com');
  await writeFile(join(directory, 'cf/tunnel.host.private'), 'api.private.example\n', { mode: 0o600 });
  assert.equal(url(), 'https://api.private.example');
  assert.equal(url({ TUNNEL_HOST: 'api.env.example' }), 'https://api.env.example');
  const custom = join(directory, 'custom.host');
  await writeFile(custom, 'api.custom.example\n');
  assert.equal(url({ TUNNEL_HOST_FILE: custom }), 'https://api.custom.example');
});

test('publication ignore rules protect local hosts and Cloudflare credentials', () => {
  const paths = ['cf/tunnel.host.private', 'cf/token.json', 'cf/hosts', 'hosts', 'hosts.local', 'config/local.json', 'run/capture.pcap'];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', ...paths], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(ignored, paths);
});
