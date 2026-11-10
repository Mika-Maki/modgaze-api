#!/usr/bin/env node
// Read-only audit: all runtime files, credentials and listeners are synthetic.
// Run as root to verify access from uid/gid 65534; no real configuration is read.
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, copyFile, writeFile, readFile, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const prefix = join(tmpdir(), 'modgaze-deployment-repro-');
const root = await mkdtemp(prefix);
const originalUmask = process.umask(0o022);
const running = new Set();
const marker = 'SYNTHETIC_SYSTEM_PROMPT_NOT_A_REAL_SECRET';
const clientKey = 'audit-synthetic-client-credential';
const mode = async path => '0' + ((await stat(path)).mode & 0o777).toString(8);
const upstream = http.createServer((req, res) => {
  req.resume();
  req.once('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'synthetic-ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});

async function capture(file, args, options = {}) {
  try { return { exitCode: 0, ...await exec(file, args, { timeout: 15000, ...options }) }; }
  catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function makeProject(name, upstreamPort) {
  const project = join(root, name);
  await mkdir(project, { mode: 0o755 });
  await mkdir(join(project, 'src'));
  await mkdir(join(project, 'scripts'));
  await mkdir(join(project, 'bin'));
  await mkdir(join(project, 'config'), { mode: 0o700 });
  // Copy only public .mjs source, never the repository's config/, run/ or cf/.
  for (const entry of await readdir(join(source, 'src'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) await copyFile(join(source, 'src', entry.name), join(project, 'src', entry.name));
  }
  await copyFile(join(source, 'package.json'), join(project, 'package.json'));
  await copyFile(join(source, 'scripts/service.mjs'), join(project, 'scripts/service.mjs'));
  await copyFile(join(source, 'scripts/private-files.mjs'), join(project, 'scripts/private-files.mjs'));
  await copyFile(join(source, 'scripts/secure-launch.mjs'), join(project, 'scripts/secure-launch.mjs'));
  await copyFile(join(source, 'tunnelup.sh'), join(project, 'tunnelup.sh'));
  const config = {
    host: '127.0.0.1', port: 0, accessLog: false,
    audit: { enabled: true, fields: { systemPrompt: true } },
    groups: [{ id: 'synthetic-group', virtualApiKeys: [clientKey], upstreamApiKey: 'synthetic-upstream-credential',
      routes: { chat: { baseURL: 'http://127.0.0.1:' + upstreamPort } }, models: [{ id: 'synthetic-model' }] }],
  };
  const configPath = join(project, 'config/local.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const log = join(project, 'run', name === 'tunnelup' ? 'modgaze-tunnelup.log' : 'modgaze.log');
  // No real 8787 requests: emulate only tunnelup's fixed-port readiness check.
  await writeFile(join(project, 'bin/curl'), "#!/bin/sh\n/usr/bin/grep -q '\"event\":\"listening\"' \"$AUDIT_LOG\" 2>/dev/null\n", { mode: 0o755 });
  const env = { PATH: join(project, 'bin') + ':/usr/bin:/bin', HOME: project,
    MODGAZE_ADMIN: '0', MODGAZE_CONFIG: configPath, AUDIT_LOG: log,
    TUNNEL_TOKEN_FILE: join(project, 'nonexistent-synthetic-token') };
  return { project, configPath, log, env };
}

async function verifyLog(name, fixture) {
  const { project, configPath, log } = fixture;
  const started = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(record => record.event === 'listening');
  assert.ok(started?.port > 0);
  // The only real curl request is loopback to the ephemeral temporary router.
  const url = 'http://127.0.0.1:' + started.port + '/v1/chat/completions';
  const args = ['--noproxy', '*', '-fsS', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}',
    '-H', 'Authorization: Bearer ' + clientKey, '-H', 'Content-Type: application/json',
    '--data-binary', JSON.stringify({ model: 'synthetic-model', messages: [{ role: 'system', content: marker }, { role: 'user', content: 'synthetic hello' }] }), url];
  const response = await capture('/usr/bin/curl', args, { env: { PATH: '/usr/bin:/bin' } });
  assert.equal(response.exitCode, 0);
  assert.equal(response.stdout, '200');
  const text = await readFile(log, 'utf8');
  assert.ok(text.includes(marker));
  assert.ok(!text.includes(clientKey));
  const readerCode = [
    "const fs = require('node:fs');",
    'const result = { uid: process.getuid(), gid: process.getgid() };',
    "try { const s = fs.readFileSync(process.argv[1], 'utf8'); result.logReadable = true; result.containsSyntheticSystemPrompt = s.includes(process.argv[3]); } catch(e) { result.logReadError = e.code; }",
    'try { fs.readFileSync(process.argv[2]); result.configReadable = true; } catch(e) { result.configReadError = e.code; }',
    'console.log(JSON.stringify(result));',
  ].join('\n');
  let otherAccount = { skipped: 'run as root to drop uid/gid to 65534' };
  if (process.getuid?.() === 0) {
    const read = spawnSync(process.execPath, ['-e', readerCode, log, configPath, marker], { uid: 65534, gid: 65534, encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(read.status, 0, read.stderr);
    otherAccount = JSON.parse(read.stdout);
    assert.equal(otherAccount.uid, 65534);
    assert.equal(otherAccount.logReadable, undefined);
    assert.equal(otherAccount.logReadError, 'EACCES');
    assert.equal(otherAccount.configReadError, 'EACCES');
  }
  console.log(JSON.stringify({ case: name, tempProject: project, umask: '0022', accessLog: false,
    projectMode: await mode(project), runMode: await mode(join(project, 'run')), logMode: await mode(log),
    configMode: await mode(configPath), curlExitCode: response.exitCode, httpStatus: Number(response.stdout),
    auditEventHasPrompt: true, rawClientKeyInLog: false, otherAccount }));
}

try {
  // Model a world-traversable checkout such as /opt/modgaze, not /root.
  await chmod(root, 0o755);
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen));
  const upstreamPort = upstream.address().port;
  const tunnel = await makeProject('tunnelup', upstreamPort);
  const started = await capture('/bin/bash', [join(tunnel.project, 'tunnelup.sh'), 'start'], { cwd: tunnel.project, env: tunnel.env });
  // Expected: app starts, then missing synthetic token blocks cloudflared.
  assert.equal(started.exitCode, 1);
  assert.match(started.stderr, /missing token/);
  const tunnelPid = Number((await readFile(join(tunnel.project, 'run/modgaze-tunnelup.pid'), 'utf8')).trim());
  assert.ok(Number.isSafeInteger(tunnelPid) && tunnelPid > 1);
  running.add(tunnelPid);
  console.log(JSON.stringify({ case: 'tunnelup-launch', exitCode: started.exitCode, expectedMissingSyntheticToken: true, cloudflaredExecuted: false, realPort8787Contacted: false }));
  await verifyLog('tunnelup-default-new-log', tunnel);

  const service = await makeProject('service', upstreamPort);
  await mkdir(join(service.project, 'run'), { mode: 0o755 });
  await writeFile(service.log, '', { mode: 0o644 });
  const serviceStarted = await capture(process.execPath, [join(service.project, 'scripts/service.mjs'), 'start'], { cwd: service.project, env: service.env });
  assert.equal(serviceStarted.exitCode, 0, serviceStarted.stderr);
  const state = JSON.parse(await readFile(join(service.project, 'run/service.json'), 'utf8'));
  running.add(state.pid);
  await verifyLog('service-preserves-existing-0644-log', service);
  const stopped = await capture(process.execPath, [join(service.project, 'scripts/service.mjs'), 'stop'], { cwd: service.project, env: service.env });
  assert.equal(stopped.exitCode, 0, stopped.stderr);
  running.delete(state.pid);
  process.kill(tunnelPid, 'SIGTERM');
  running.delete(tunnelPid);
  console.log(JSON.stringify({ verified: true, liveConfigurationRead: false, liveNetworkContacted: false }));
} finally {
  for (const pid of running) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  upstream.closeAllConnections();
  await new Promise(resolveClose => upstream.close(resolveClose));
  process.umask(originalUmask);
  assert.ok(resolve(root) === root && root.startsWith(prefix) && root !== prefix);
  await rm(root, { recursive: true, force: true });
}
