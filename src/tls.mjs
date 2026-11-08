import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSecureContext } from 'node:tls';

export async function loadTLS(config, configPath) {
  if (config === undefined || config === false || config?.enabled === false) return null;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid HTTPS configuration');
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 8443;
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTPS listener');
  if (typeof config.keyFile !== 'string' || typeof config.certFile !== 'string') throw new Error('HTTPS requires keyFile and certFile');
  const keyPath = resolve(dirname(configPath), config.keyFile);
  const certPath = resolve(dirname(configPath), config.certFile);
  const info = await stat(keyPath);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('TLS private key must have mode 0600');
  const options = { key: await readFile(keyPath), cert: await readFile(certPath), minVersion: 'TLSv1.2' };
  createSecureContext(options); // Fail startup on invalid/mismatched credentials, never fall back silently.
  return { host, port, options };
}

export function createTLSListener(router, tls) {
  const listener = https.createServer(tls.options, (req, res) => router.emit('request', req, res));
  listener.requestTimeout = router.requestTimeout;
  listener.headersTimeout = router.headersTimeout;
  listener.keepAliveTimeout = router.keepAliveTimeout;
  return listener;
}
