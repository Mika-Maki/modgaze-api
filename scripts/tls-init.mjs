import { mkdir, access, chmod, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { readRawConfig, atomicWriteConfig } from '../src/config.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = resolve(root, 'config/local.json');
const directory = resolve(root, 'config/tls');
try {
  const config = await readRawConfig(configPath);
  if (config.https) throw new Error('HTTPS is already configured; existing certificates were not changed');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const name of ['ca.key', 'ca.crt', 'server.key', 'server.crt', 'server.csr', 'extensions.cnf']) {
    try { await access(join(directory, name)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    throw new Error('TLS files already exist; refusing to overwrite');
  }
  const previous = process.umask(0o077);
  try {
    const openssl = args => execFileSync('openssl', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    openssl(['req','-x509','-newkey','rsa:3072','-nodes','-sha256','-days','3650','-keyout','ca.key','-out','ca.crt','-subj','/CN=Modgaze Local Development CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
    openssl(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-keyout','server.key','-out','server.csr','-subj','/CN=localhost']);
    await writeFile(join(directory,'extensions.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n', { mode: 0o600, flag: 'wx' });
    openssl(['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-set_serial','0x'+(await import('node:crypto')).randomBytes(16).toString('hex'),'-out','server.crt','-days','365','-sha256','-extfile','extensions.cnf']);
  } finally { process.umask(previous); }
  config.https = { host: '127.0.0.1', port: 8443, keyFile: 'tls/server.key', certFile: 'tls/server.crt' };
  await atomicWriteConfig(configPath, config);
  console.log(JSON.stringify({ https: 'https://127.0.0.1:8443', caFile: 'config/tls/ca.crt', restartRequired: true, trustedAutomatically: false }));
} catch { console.error('TLS setup failed. Check config, openssl, and existing TLS files. No secrets printed.'); process.exitCode = 1; }
