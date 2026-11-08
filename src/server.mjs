import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRawConfig, validateConfig } from './config.mjs';
import { createRouter } from './router.mjs';
import { createMetrics } from './metrics.mjs';
import { createAdmin } from './admin.mjs';
import { loadTLS, createTLSListener } from './tls.mjs';

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
  const adminHost = raw.adminHost ?? '127.0.0.1';
  if (typeof adminHost !== 'string' || !adminHost.trim() || adminHost.length > 255) throw new Error('Invalid admin host');
  const tls = await loadTLS(raw.https, path);
  const adminTLS = adminEnabled ? await loadTLS(raw.adminHttps, path) : null;
  const ports = [compiled.port, adminPort, tls?.port, adminTLS?.port].filter(p => p !== null && p !== undefined && p !== 0);
  if (new Set(ports).size !== ports.length) throw new Error('Listener port conflict');
  if (check) {
    console.log(JSON.stringify({ valid: true, groups: compiled.groups.length, models: compiled.groups.reduce((n, g) => n + g.models.length, 0), adminPort: adminEnabled ? adminPort : null, httpsPort: tls?.port ?? null, adminHttpsPort: adminTLS?.port ?? null }));
  } else {
    const metrics = createMetrics();
    let currentCompiled = compiled;
    const logger = record => { if (currentCompiled.accessLog === true) console.log(JSON.stringify(record)); };
    const server = createRouter(resolved, { logger, onRequest: metrics.record });
    const secureServer = tls ? createTLSListener(server, tls) : null;
    async function reload(next) {
      const result = server.reload(next);
      currentCompiled = result.compiled;
      if (secureServer) { secureServer.requestTimeout = server.requestTimeout; secureServer.headersTimeout = server.headersTimeout; }
      return { groups: result.groups, models: result.models };
    }

    let admin = null;
    let secureAdmin = null;
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      const listeners = [server, secureServer, admin, secureAdmin].filter(Boolean);
      Promise.all(listeners.map(s => new Promise(resolveClose => s.close(resolveClose)))).then(() => process.exit(0));
      for (const listener of listeners) listener.closeIdleConnections();
      setTimeout(() => { for (const listener of listeners) listener.closeAllConnections(); process.exit(0); }, 10000).unref();
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

    if (secureServer) {
      try {
        await new Promise((resolveListen, rejectListen) => {
          secureServer.once('error', rejectListen);
          secureServer.listen(tls.port, tls.host, () => { secureServer.off('error', rejectListen); resolveListen(); });
        });
        secureServer.on('error', error => console.error(JSON.stringify({ event: 'https_error', code: error.code ?? 'UNKNOWN' })));
        console.log(JSON.stringify({ event: 'https_listening', host: tls.host, port: secureServer.address().port }));
      } catch {
        server.closeAllConnections(); server.close();
        secureServer.closeAllConnections(); secureServer.close();
        throw new Error('HTTPS startup failed');
      }
    }

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
            tlsAllowedHosts: raw.adminHttps?.allowedHosts ?? [],
            allowedHosts: raw.adminAllowedHosts ?? [],
            routerPort: () => server.address()?.port ?? compiled.port,
            reload,
            metrics,
          });
          await new Promise((resolveListen, rejectListen) => {
            admin.once('error', rejectListen);
            admin.listen(adminPort, adminHost, () => {
              admin.off('error', rejectListen);
              resolveListen();
            });
          });
          console.log(JSON.stringify({ event: 'admin_listening', host: adminHost, port: admin.address().port }));
          if (adminTLS) {
            secureAdmin = createTLSListener(admin, adminTLS);
            await new Promise((resolveListen, rejectListen) => {
              secureAdmin.once('error', rejectListen);
              secureAdmin.listen(adminTLS.port, adminTLS.host, () => { secureAdmin.off('error', rejectListen); resolveListen(); });
            });
            secureAdmin.on('error', error => console.error(JSON.stringify({ event: 'admin_https_error', code: error.code ?? 'UNKNOWN' })));
            console.log(JSON.stringify({ event: 'admin_https_listening', host: adminTLS.host, port: secureAdmin.address().port }));
          }
        } catch (error) {
          console.error(JSON.stringify({ event: 'admin_error', code: error.code ?? 'UNKNOWN' }));
          try { admin?.closeAllConnections(); admin?.close(); } catch {}
          try { secureAdmin?.closeAllConnections(); secureAdmin?.close(); } catch {}
          admin = null; secureAdmin = null;
          if (adminTLS) {
            server.closeAllConnections(); server.close();
            secureServer?.closeAllConnections(); secureServer?.close();
            throw new Error('Admin HTTPS startup failed');
          }
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
