import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function browserModule(path, bindings = {}) {
  const source = await readFile(new URL('../public/assets/js/' + path, import.meta.url), 'utf8');
  const names = [...source.matchAll(/export\s*\{([^}]+)\};/g)].flatMap(match => match[1].split(',').map(name => name.trim()));
  names.push(...[...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]));
  const script = source.replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*$/gm, '').replace(/export\s*\{[^}]+\};/g, '').replace(/export\s+(?=(?:async\s+)?function)/g, '');
  return vm.runInNewContext(script + '\n;({' + names.join(',') + '});', { Date, Intl, ...bindings }, { filename: path });
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const backup = { name: 'manual-token.sqlite', size: 4096, mtimeMs: 1700000000000 };
async function harness(hostname = 'localhost') {
  const node = { innerHTML: '' };
  const document = { querySelector: () => node, querySelectorAll: () => [] };
  const core = await browserModule('core.js', { document });
  Object.assign(core.app, { authenticated: true, csrf: 'session', viewSequence: 1, route: { name: 'system', tab: 'backups' } });
  const system = await browserModule('views/system.js', { ...core, document, location: { hostname } });
  const calls = [], replies = [];
  const data = await browserModule('data.js', { ...core, ...system, document, toast() {}, api: async (path, options) => { calls.push({ path, options }); const result = await replies.shift(); if (result instanceof Error) throw result; return result; } });
  return { ...core, ...system, ...data, node, calls, replies };
}
test('backup list loads on backup page and manual backup refreshes it using fixed API and empty body', async () => {
  const h = await harness();
  h.replies.push({ backups: [backup] });
  assert.equal(await h.loadTokenBackups(), true);
  assert.match(h.node.innerHTML, /manual-token.sqlite/);
  h.replies.push({ backup }, { backups: [backup] });
  assert.equal(await h.createTokenBackup(), true);
  assert.equal(h.calls[1].options.method, 'POST');
  assert.equal(JSON.stringify(h.calls[1].options.body), '{}');
  assert.deepEqual(h.calls.map(call => call.path), Array(3).fill('/api/token-backups'));
  assert.doesNotMatch(h.node.innerHTML, /data-action="restore-token/);
});
test('backup failures preserve previous list and display escaped errors', async () => {
  const h = await harness();
  h.replies.push({ backups: [backup] }); await h.loadTokenBackups();
  h.replies.push(new Error('<offline>'));
  assert.equal(await h.loadTokenBackups(), false);
  assert.match(h.node.innerHTML, /&lt;offline&gt;/);
  assert.match(h.node.innerHTML, /manual-token.sqlite/);
  h.replies.push(new Error('disk full'));
  assert.equal(await h.createTokenBackup(), false);
  assert.match(h.node.innerHTML, /创建失败/);
  assert.equal(h.app.tokenBackupCreating, false);
});
test('backup reads stay on backup page and stale route, visit and session responses are ignored', async () => {
  for (const change of ['route', 'visit', 'session']) {
    const h = await harness(), pending = deferred();
    h.replies.push(pending.promise); const request = h.loadTokenBackups();
    if (change === 'route') h.app.route = { name: 'overview' };
    if (change === 'visit') h.app.viewSequence++;
    if (change === 'session') h.app.csrf = 'new';
    pending.resolve({ backups: [backup] });
    assert.equal(await request, false); assert.equal(h.app.tokenBackups, null);
  }
  const h = await harness(); h.app.route = { name: 'system', tab: 'general' };
  assert.equal(await h.loadTokenBackups(), false); assert.equal(h.calls.length, 0);
});
test('download links are restricted to the same local hostnames as configuration backups', async () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'remote.example', 'localhost.example']) {
    const h = await harness(hostname);
    h.replies.push({ backups: [backup] }); await h.loadTokenBackups();
    if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) assert.match(h.node.innerHTML, /href="\/api\/token-backups\/manual-token.sqlite\/download"/);
    else { assert.doesNotMatch(h.node.innerHTML, /<a[^>]+href=/); assert.match(h.node.innerHTML, /aria-disabled="true"/); }
  }
});
