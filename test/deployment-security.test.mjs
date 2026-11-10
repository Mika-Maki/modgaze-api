import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, chown, stat, lstat, symlink, link, rename, rm, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePrivateDirectory, openPrivateFile } from '../scripts/private-files.mjs';

const source = new URL('../', import.meta.url);
const entries = ['service', 'tunnelup', 'quick', 'tunnel'];
const mode = async path => (await stat(path)).mode & 0o777;
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const success = result => assert.equal(result.status, 0, result.stderr + result.stdout + String(result.error ?? ''));
async function until(fn) {
  for (let n = 0; n < 100; n++) { if (await fn()) return; await delay(20); }
  assert.fail('Synthetic child did not become ready');
}

async function fixture(t, entry) {
  const base = await mkdtemp(join(tmpdir(), 'deployment-security-'));
  const root = join(base, "project spaces ' quotes");
  await mkdir(root, { mode: 0o755 });
  const groups = new Set();
  const pidFiles = [];
  t.after(async () => {
    for (const path of pidFiles) {
      try {
        const text = await readFile(path, 'utf8');
        const pid = path.endsWith('service.json') ? JSON.parse(text).pid : Number(text.trim());
        if (Number.isSafeInteger(pid) && pid > 1) groups.add(pid);
      } catch {}
    }
    for (const pid of groups) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
    // Only this freshly allocated fixture is ever removed.
    await rm(base, { recursive: true, force: true });
  });
  for (const dir of ['scripts', 'cf', 'config', 'src', 'fake-bin']) await mkdir(join(root, dir));
  for (const file of ['scripts/service.mjs', 'scripts/private-files.mjs', 'scripts/secure-launch.mjs', 'tunnelup.sh', 'cf/quick.sh', 'cf/tunnel.sh']) {
    await copyFile(new URL(file, source), join(root, file));
  }
  const marker = join(root, 'health-ready');
  const capture = join(root, 'cloud-argv.json');
  await writeFile(join(root, 'config/local.json'), '{}', { mode: 0o600 });
  await writeFile(join(root, 'src/server.mjs'), "import fs from 'node:fs';\nconsole.log('SYNTHETIC_SYSTEM_PROMPT');\nfs.writeFileSync(process.env.FAKE_HEALTH, 'ready');\nsetInterval(() => {}, 1000);\n");
  const binary = join(root, 'fake-bin', "cloud ' quote;touch INJECTED;#");
  await writeFile(binary, '#!' + process.execPath + '\n' + "const fs = require('node:fs');\nfs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), mode: fs.fstatSync(1).mode & 511, regular: fs.fstatSync(1).isFile() }));\nconsole.log('Registered tunnel connection https://synthetic.trycloudflare.com');\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  await copyFile(binary, join(root, 'fake-bin/cloudflared'));
  await writeFile(join(root, 'fake-bin/curl'), '#!/bin/sh\n[ -f "$FAKE_HEALTH" ]\n', { mode: 0o755 });
  const token = join(root, "token ' quote;touch INJECTED;# $(touch SUBSTITUTION)");
  await writeFile(token, 'SYNTHETIC_TOKEN', { mode: 0o600 });
  const shared = join(root, 'shared');
  await mkdir(shared, { mode: 0o755 });
  const env = {
    PATH: join(root, 'fake-bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin',
    HOME: root, FAKE_HEALTH: marker, FAKE_CAPTURE: capture,
    BIN: binary, TARGET: 'http://127.0.0.1:8787/a b;touch INJECTED;# $(touch SUBSTITUTION)',
    TOKEN_FILE: token, TUNNEL_TOKEN_FILE: token, TUNNEL_HOST: 'synthetic.example',
    LOG: join(shared, "log ' quote;touch INJECTED;#"), PIDFILE: join(shared, "pid ' quote"),
  };
  const commands = {
    service: [process.execPath, join(root, 'scripts/service.mjs')],
    tunnelup: ['bash', join(root, 'tunnelup.sh')],
    quick: ['sh', join(root, 'cf/quick.sh')],
    tunnel: ['sh', join(root, 'cf/tunnel.sh')],
  };
  const logs = entry === 'service' ? [join(root, 'run/modgaze.log')]
    : entry === 'tunnelup' ? [join(root, 'run/modgaze-tunnelup.log'), join(root, 'run/cloudflared-tunnelup.log')] : [env.LOG];
  pidFiles.push(...(entry === 'service' ? [join(root, 'run/service.json')]
    : entry === 'tunnelup' ? [join(root, 'run/modgaze-tunnelup.pid'), join(root, 'run/cloudflared-tunnelup.pid')] : [env.PIDFILE]));
  const run = action => spawnSync('bash', ['-c', 'umask 022; exec "$@"', 'fixture', ...commands[entry], action], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  return { base, root, shared, env, run, logs, pidFiles, groups, capture, token, binary };
}

for (const entry of entries) {
  for (const old of [false, true]) test(entry + ': ' + (old ? 'repairs 0755/0644' : 'creates private files under umask 022'), async t => {
    const f = await fixture(t, entry);
    if (old) {
      if (entry === 'service' || entry === 'tunnelup') await mkdir(join(f.root, 'run'), { mode: 0o755 });
      for (const log of f.logs) { await writeFile(log, 'old-log\n'); await chmod(log, 0o644); }
    }
    success(f.run('start'));
    if (entry !== 'service') await until(() => exists(f.capture));
    for (const log of f.logs) {
      assert.equal(await mode(log), 0o600);
      if (old) assert.match(await readFile(log, 'utf8'), /^old-log\n/);
    }
    for (const pid of f.pidFiles) assert.equal(await mode(pid), 0o600);
    if (entry === 'service' || entry === 'tunnelup') assert.equal(await mode(join(f.root, 'run')), 0o700);
    assert.equal(await mode(f.shared), 0o755, 'existing shared parent unchanged');
    assert.equal(await mode(f.root), 0o755, 'project parent unchanged');
    if (entry !== 'service') {
      const captured = JSON.parse(await readFile(f.capture, 'utf8'));
      assert.equal(captured.mode, 0o600);
      assert.equal(captured.regular, true);
      assert.deepEqual(captured.argv, entry === 'quick' ? ['tunnel', '--url', f.env.TARGET, '--no-autoupdate'] : ['tunnel', 'run', '--token-file', f.token]);
      assert.equal(await exists(join(f.root, 'INJECTED')), false);
      assert.equal(await exists(join(f.root, 'SUBSTITUTION')), false);
    }
    success(f.run('stop'));
  });

  for (const kind of ['symlink', 'hardlink', 'fifo', 'directory', 'foreign']) test(entry + ': rejects ' + kind + ' log without touching target', async t => {
    if (kind === 'foreign' && process.geteuid() !== 0) return t.skip('foreign ownership requires root');
    const f = await fixture(t, entry);
    await mkdir(dirname(f.logs[0]), { recursive: true });
    const target = join(f.root, 'untouched');
    await writeFile(target, 'DO_NOT_CHANGE');
    await chmod(target, 0o644);
    const log = f.logs[0];
    if (kind === 'symlink') await symlink(target, log);
    if (kind === 'hardlink') await link(target, log);
    if (kind === 'fifo') success(spawnSync('mkfifo', [log], { encoding: 'utf8' }));
    if (kind === 'directory') await mkdir(log);
    if (kind === 'foreign') { await writeFile(log, 'FOREIGN'); await chown(log, 65534, 65534); await chmod(log, 0o644); }
    const result = f.run('start');
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(result.error, undefined, 'must reject, not block on FIFO');
    assert.equal(await readFile(target, 'utf8'), 'DO_NOT_CHANGE');
    assert.equal(await mode(target), 0o644);
    if (kind === 'foreign') { assert.equal(await mode(log), 0o644); assert.equal((await stat(log)).uid, 65534); }
    assert.equal(await exists(f.capture), false);
    assert.equal(await exists(join(f.root, 'health-ready')), false);
  });
}

for (const entry of ['service', 'tunnelup']) {
  for (const kind of ['symlink', 'file', 'foreign']) test(entry + ': rejects ' + kind + ' run directory', async t => {
    if (kind === 'foreign' && process.geteuid() !== 0) return t.skip('foreign ownership requires root');
    const f = await fixture(t, entry);
    const target = join(f.root, 'untouched-dir');
    await mkdir(target, { mode: 0o755 });
    const run = join(f.root, 'run');
    if (kind === 'symlink') await symlink(target, run);
    if (kind === 'file') await writeFile(run, 'not a directory');
    if (kind === 'foreign') { await mkdir(run, { mode: 0o755 }); await chown(run, 65534, 65534); }
    assert.notEqual(f.run('start').status, 0);
    assert.equal(await mode(target), 0o755);
    if (kind === 'foreign') assert.equal(await mode(run), 0o755);
    assert.equal(await exists(f.capture), false);
  });
}

test('private descriptor stays on validated inode after pathname substitution', async t => {
  const f = await fixture(t, 'quick');
  const log = f.env.LOG;
  const target = join(f.root, 'victim');
  await writeFile(target, 'UNTOUCHED', { mode: 0o644 });
  const handle = await openPrivateFile(log, { create: true, append: true });
  try {
    await rename(log, log + '.original');
    await symlink(target, log);
    const result = spawnSync(process.execPath, ['-e', "process.stdout.write('FD_ONLY')"], { stdio: ['ignore', handle.fd, 'pipe'], encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(log + '.original', 'utf8'), 'FD_ONLY');
    assert.equal(await readFile(target, 'utf8'), 'UNTOUCHED');
    assert.equal(await mode(target), 0o644);
  } finally { await handle.close(); }
});

test('helper rejects ancestor symlinks and creates private missing parents without chmod shared ancestors', async t => {
  const f = await fixture(t, 'quick');
  const sharedMode = await mode(f.shared);
  const nested = join(f.shared, 'new', 'nested', 'private.log');
  await (await openPrivateFile(nested, { create: true })).close();
  assert.equal(await mode(join(f.shared, 'new')), 0o700);
  assert.equal(await mode(join(f.shared, 'new/nested')), 0o700);
  assert.equal(await mode(f.shared), sharedMode);
  const alias = join(f.root, 'alias');
  await symlink(f.shared, alias);
  await assert.rejects(openPrivateFile(join(alias, 'outside.log'), { create: true }));
  await assert.rejects(ensurePrivateDirectory(alias));
  assert.equal(await exists(join(f.shared, 'outside.log')), false);
});

test('other uid cannot read repaired logs even with traversable parents', async t => {
  if (process.geteuid() !== 0) return t.skip('uid separation requires root');
  const f = await fixture(t, 'quick');
  await chmod(f.base, 0o755);
  await writeFile(f.env.LOG, 'SYNTHETIC_SECRET', { mode: 0o644 });
  await (await openPrivateFile(f.env.LOG, { append: true })).close();
  const result = spawnSync('/bin/sh', ['-c', 'exec /bin/cat "$1"', 'read-test', f.env.LOG], { uid: 65534, gid: 65534, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Permission denied/);
  assert.equal(result.stdout, '');
});
