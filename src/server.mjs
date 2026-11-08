import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRawConfig, validateConfig } from './config.mjs';
import { createRouter } from './router.mjs';
import { createMetrics } from './metrics.mjs';
import { createAdmin } from './admin.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runDir = resolve(root, 'run');
const args = process.argv.slice(2);
let configPath = process.env.MODGAZE_CONFIG ?? process.env.MODELROUTER_CONFIG ?? 'config/local.json';
let check = false;
const adminEnv = process.env.MODGAZE_ADMIN ?? process.env.MODELROUTER_ADMIN;
let adminEnabled = adminEnv !== '0';
let adminPortArg;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check') check = true;
  else if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
  else if (args[i] === '--admin-port' && args[i + 1]) adminPortArg = Number(args[++i]);
  else if (args[i] === '--no-admin') adminEnabled = false;
  else {
    console.error('Usage: node src/server.mjs [--config path] [--check] [--admin-port 8788] [--no-admin]');
    process.exit(2);
  }
}

function resolveAdminPort(raw) {
  const adminPortEnv = process.env.MODGAZE_ADMIN_PORT ?? process.env.MODELROUTER_ADMIN_PORT;
  const candidate = adminPortArg ?? (adminPortEnv ? Number(adminPortEnv) : undefined) ?? raw.adminPort ?? 8788;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 65535) throw new Error('Invalid admin port');
  return candidate;
}

try {
  const path = resolve(configPath);
  const raw = await readRawConfig(path);
  const { resolved, compiled } = validateConfig(raw);
  const adminPort = adminEnabled ? resolveAdminPort(raw) : null;
  if (check) {
    console.log(JSON.stringify({ valid: true, groups: compiled.groups.length, models: compiled.groups.reduce((n, g) => n + g.models.length, 0), adminPort: adminEnabled ? adminPort : null }));
  } else {
    const metrics = createMetrics();
    let currentCompiled = compiled;
    const logger = record => { if (currentCompiled.accessLog === true) console.log(JSON.stringify(record)); };
    const server = createRouter(resolved, { logger, onRequest: metrics.record });
    async function reload(next) {
      const result = server.reload(next);
      currentCompiled = result.compiled;
      return { groups: result.groups, models: result.models };
    }

    let admin = null;
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      try { admin?.closeAllConnections?.(); admin?.close(); } catch {}
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 10000).unref();
    };

    server.on('error', error => { console.error(JSON.stringify({ event: 'listen_error', code: error.code ?? 'UNKNOWN' })); process.exitCode = 1; });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(compiled.port, compiled.host, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    console.log(JSON.stringify({ event: 'listening', host: compiled.host, port: server.address().port, groups: compiled.groups.length }));

    if (adminEnabled) {
      if (adminPort === compiled.port) {
        console.error(JSON.stringify({ event: 'admin_error', code: 'PORT_CONFLICT', message: 'Admin port equals router port' }));
      } else {
        try {
          admin = await createAdmin({
            configPath: path,
            runDir,
            projectRoot: root,
            adminPort,
            routerPort: () => server.address()?.port ?? compiled.port,
            reload,
            metrics,
          });
          await new Promise((resolveListen, rejectListen) => {
            admin.once('error', rejectListen);
            admin.listen(adminPort, '127.0.0.1', () => {
              admin.off('error', rejectListen);
              resolveListen();
            });
          });
          console.log(JSON.stringify({ event: 'admin_listening', host: '127.0.0.1', port: admin.address().port }));
        } catch (error) {
          console.error(JSON.stringify({ event: 'admin_error', code: error.code ?? 'UNKNOWN' }));
          try { admin?.close(); } catch {}
          admin = null;
        }
      }
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
} catch (error) {
  // JSON parser messages can include secret source snippets; never print them.
  console.error(JSON.stringify({ event: 'startup_error', message: error instanceof SyntaxError ? 'Invalid configuration JSON' : error.code === 'ENOENT' ? 'Config missing; run npm run import first' : 'Invalid or unreadable configuration; check schema and secret references' }));
  process.exitCode = 1;
}
