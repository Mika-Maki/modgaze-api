import { mkdir, open, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = resolve(root, 'run');
const stateFile = resolve(dir, 'service.json');
const lockFile = resolve(dir, 'service.lock');
const serverPath = resolve(root, 'src/server.mjs');
const configPath = resolve(root, 'config/local.json');
const action = process.argv[2] ?? 'status';
if (!['start', 'stop', 'restart', 'status'].includes(action)) { console.error('Usage: node scripts/service.mjs start|stop|restart|status'); process.exit(2); }
await mkdir(dir, { recursive: true, mode: 0o700 });
let lock;
try { lock = await open(lockFile, 'wx', 0o600); }
catch { console.error('Service operation locked; inspect run/service.lock before removing a stale lock.'); process.exit(1); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function identity(pid) {
  try {
    const text = await readFile('/proc/' + pid + '/stat', 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    const cmd = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0');
    return fields[0] !== 'Z' && cmd.includes(serverPath) ? fields[19] : null;
  } catch { return null; }
}
async function state() {
  try {
    const stored = JSON.parse(await readFile(stateFile, 'utf8'));
    return Number.isSafeInteger(stored.pid) && stored.pid > 1 && typeof stored.start === 'string' && stored.start === await identity(stored.pid) ? stored : null;
  } catch { return null; }
}
async function stop() {
  const current = await state();
  if (!current) { console.log('Modgaze is not running'); return; }
  process.kill(current.pid, 'SIGTERM');
  for (let n = 0; n < 120; n++) {
    if (!await state()) { await unlink(stateFile).catch(() => {}); console.log('Modgaze stopped'); return; }
    await pause(100);
  }
  throw new Error('Graceful stop timed out; process was not force-killed');
}
async function start() {
  const current = await state();
  if (current) { console.log('Modgaze already running: pid=' + current.pid); return; }
  const info = await stat(configPath);
  if (info.mode & 0o077) throw new Error('Config must have mode 0600');
  const log = await open(resolve(dir, 'modgaze.log'), 'a', 0o600);
  const child = spawn(process.execPath, [serverPath, '--config', configPath], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  await log.close();
  const started = await identity(child.pid);
  if (!started) throw new Error('Startup failed; inspect run/modgaze.log');
  await writeFile(stateFile, JSON.stringify({ pid: child.pid, start: started }) + '\n', { mode: 0o600 });
  await pause(400);
  if (!await state()) throw new Error('Startup failed; inspect run/modgaze.log');
  console.log('Modgaze started: pid=' + child.pid + '; log=run/modgaze.log');
}
try {
  if (action === 'stop' || action === 'restart') await stop();
  if (action === 'start' || action === 'restart') await start();
  if (action === 'status') {
    const current = await state();
    console.log(current ? 'Modgaze running: pid=' + current.pid : 'Modgaze is not running');
    if (!current) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await lock.close(); await unlink(lockFile); }
