import { spawn } from 'node:child_process';
import { ensurePrivateDirectory, openPrivateFile, readPrivateFile, removePrivateFile } from './private-files.mjs';

process.umask(0o077);
const [action, ...args] = process.argv.slice(2);
try {
  if (action === 'directory') {
    for (const path of args) await ensurePrivateDirectory(path);
  } else if (action === 'prepare') {
    for (const path of args) await (await openPrivateFile(path, { create: true })).close();
  } else if (action === 'check') {
    for (const path of args) {
      try { await (await openPrivateFile(path)).close(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } else if (action === 'pid') {
    const text = (await readPrivateFile(args[0]) ?? '').trim();
    if (/^[0-9]+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 1) process.stdout.write(text);
  } else if (action === 'read') {
    process.stdout.write(await readPrivateFile(args[0]) ?? '');
  } else if (action === 'remove') {
    await removePrivateFile(args[0]);
  } else if (action === 'launch') {
    const [logPath, pidPath, mode, command, ...argv] = args;
    if (!command || !['once', 'loop'].includes(mode)) throw new Error('Invalid launch arguments');
    const log = await openPrivateFile(logPath, { create: true, append: true });
    let pidFile;
    let child;
    try {
      pidFile = await openPrivateFile(pidPath, { create: true });
      // The script is constant. Every environment-derived value is a positional
      // argument, and the child inherits the already validated log descriptor.
      const executable = mode === 'loop' ? '/bin/sh' : command;
      const parameters = mode === 'loop'
        ? ['-c', 'while :; do "$@"; sleep 5; done', 'modgaze-tunnel', command, ...argv]
        : argv;
      child = spawn(executable, parameters, { detached: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      await pidFile.truncate(0);
      await pidFile.writeFile(String(child.pid) + '\n');
      child.unref();
    } catch (error) {
      if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      throw error;
    } finally { await log.close(); await pidFile?.close(); }
  } else { throw new Error('Unknown secure-launch operation'); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
