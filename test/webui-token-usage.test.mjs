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
const plain = value => JSON.parse(JSON.stringify(value));
const limits = { totalTokens: 1000, inputTokens: 600, outputTokens: 400, cachedTokens: 200, dayTokens: 500 };
const emptyLimits = Object.fromEntries(Object.keys(limits).map(name => [name, 0]));
const usage = { day: '2026-11-11', timeZone: 'Asia/Singapore', today: { inputTokens: 12, outputTokens: 8, cachedTokens: 5, totalTokens: 20, requests: 2 }, total: { inputTokens: 120, outputTokens: 80, cachedTokens: 50, totalTokens: 200, requests: 20 } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function usageHarness() {
  const document = { querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } };
  const core = await browserModule('core.js', { document });
  Object.assign(core.app, { authenticated: true, csrf: 'session', viewSequence: 1 });
  const node = { innerHTML: '' };
  const dashboard = await browserModule('views/dashboard.js', { ...core, $$: () => [node] });
  const calls = [], replies = [];
  const data = await browserModule('data.js', { ...core, document, updateTokenUsage: dashboard.updateTokenUsage, api: async path => { calls.push(path); const response = await replies.shift(); if (response instanceof Error) throw response; return response; } });
  return { ...core, ...dashboard, ...data, node, calls, replies };
}

test('homepage requests persisted usage on every visit and displays server day, In, Out and Cached without double counting', async () => {
  const h = await usageHarness();
  assert.match(h.renderTokenUsage(), /DayToken/);
  assert.match(h.renderTokenUsage(), /TotalToken/);
  assert.doesNotMatch(h.renderTokenUsage(), /<strong>0<\/strong>/);
  h.replies.push({ usage });
  assert.equal(await h.loadTokenUsage(), true);
  assert.deepEqual(h.calls, ['/api/token-usage']);
  for (const label of ['DayToken', 'TotalToken', 'In', 'Out', 'Cached', 'Asia/Singapore', '2026-11-11', 'Total = In + Out']) assert.ok(h.node.innerHTML.includes(label));
  assert.match(h.node.innerHTML, /<strong>20<\/strong>/);
  assert.match(h.node.innerHTML, /<strong>200<\/strong>/);
  h.app.route = { name: 'keys' };
  assert.equal(await h.loadTokenUsage(), false);
  h.app.route = { name: 'overview' }; h.app.viewSequence += 1;
  h.replies.push({ usage: { ...usage, total: { ...usage.total, totalTokens: 201 } } });
  assert.equal(await h.loadTokenUsage(), true);
  assert.equal(h.calls.length, 2);
  assert.match(h.node.innerHTML, /<strong>201<\/strong>/);
});

test('usage failures preserve the last successful values and unknown usage remains dashes', async () => {
  const h = await usageHarness();
  h.replies.push(new Error('offline'));
  assert.equal(await h.loadTokenUsage(), false);
  assert.match(h.node.innerHTML, /暂时无法加载用量/);
  assert.match(h.node.innerHTML, /<strong>—<\/strong>/);
  h.replies.push({ usage }); await h.loadTokenUsage();
  h.replies.push({ usage: { ...usage, total: {} } });
  assert.equal(await h.loadTokenUsage(), false);
  assert.match(h.node.innerHTML, /保留上次用量/);
  assert.equal(h.app.tokenUsage, usage);
});

test('late usage reads cannot affect another route, a newer visit, or a new login', async () => {
  for (const change of ['route', 'visit', 'session']) {
    const h = await usageHarness(), pending = deferred();
    h.replies.push(pending.promise); const request = h.loadTokenUsage();
    if (change === 'route') h.app.route = { name: 'keys' };
    if (change === 'visit') h.app.viewSequence += 1;
    if (change === 'session') h.app.csrf = 'new-session';
    pending.resolve({ usage });
    assert.equal(await request, false);
    assert.equal(h.app.tokenUsage, null);
  }
  const h = await usageHarness(), pending = deferred();
  h.replies.push(pending.promise, { usage });
  const old = h.loadTokenUsage(); await h.loadTokenUsage();
  pending.resolve({ usage: { ...usage, day: 'stale' } }); await old;
  assert.equal(h.app.tokenUsage.day, usage.day);
});

test('the shipped hub render starts a separate usage refresh on each entry', async () => {
  const h = await usageHarness();
  h.app.data = {};
  const view = {}; let refreshes = 0;
  const router = await browserModule('router.js', { ...h, document: { body: { dataset: {} } }, $: selector => selector === '#view' ? view : null, updateChrome() {}, renderHub: () => 'hub', mountHub() {}, applyKeyReveals() {}, filterGroups() {}, filterKeys() {}, updateLiveStats() {}, loadTokenUsage() { refreshes += 1; }, setTimeout() {} });
  router.render(); router.render();
  assert.equal(refreshes, 2);
  assert.equal(h.app.viewSequence, 3);
});

async function formHarness() {
  const core = await browserModule('core.js', { document: { querySelector() {}, querySelectorAll: () => [] } });
  core.app.data = { groups: [{ id: 'demo', name: 'Demo', models: [], virtualKeys: [] }] };
  let modal; const calls = [];
  const dialogs = await browserModule('dialogs.js', { ...core, openModal: options => { modal = options; } });
  const forms = await browserModule('forms.js', { ...core, FormData: class { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name] ?? ''; } getAll() { return ['chat']; } }, api: async (path, options) => { calls.push(plain({ path, ...options })); return { group: { id: 'created', models: [], virtualKeys: [] } }; }, closeModal() {}, loadState: async () => true, navigate() {}, toast() {}, openSecretModal() {} });
  async function submit(kind, overrides = {}, source = 'virtual') {
    const error = { textContent: '', classList: { add() {}, remove() {} } };
    const form = { dataset: { form: kind, source, keyId: 'key-1', group: 'demo' }, fields: { id: 'created', group: 'demo', baseURL: 'http://127.0.0.1:1', upstreamApiKey: 'synthetic', models: 'model', rateRpm: '0', rateMaxConcurrent: '0', ...overrides }, querySelector: selector => selector === '.form-error' ? error : null };
    await forms.handleSubmit({ target: { closest: () => form }, preventDefault() {} });
    return error.textContent;
  }
  return { core, dialogs, calls, submit, get modal() { return modal; } };
}

test('MR creation, clone and edit forms expose five limits and submit them alongside expiry', async () => {
  const h = await formHarness();
  for (const open of [() => h.dialogs.openVirtualKeyModal('demo'), () => h.dialogs.openCreateGroupModal(), () => h.dialogs.openCloneModal(h.core.app.data.groups[0]), () => h.dialogs.openKeyLabelModal({ id: 'key-1', tokenLimits: limits }, 'virtual', 'demo')]) {
    open();
    for (const name of Object.keys(limits)) assert.ok(h.modal.body.includes('name="tokenLimit_' + name + '"'));
    assert.match(h.modal.body, /服务器本地时区/);
    assert.match(h.modal.body, /MR Expires at/);
  }
  const fields = Object.fromEntries(Object.entries(limits).map(([name, amount]) => ['tokenLimit_' + name, String(amount)]));
  for (const kind of ['virtual-key', 'create-group', 'clone-group', 'key-label']) {
    assert.equal(await h.submit(kind, fields), '');
    assert.deepEqual(h.calls.at(-1).body.tokenLimits, limits);
    assert.equal(h.calls.at(-1).body.expiresAt, null);
    assert.equal(await h.submit(kind), '');
    assert.deepEqual(h.calls.at(-1).body.tokenLimits, emptyLimits);
  }
  h.dialogs.openKeyLabelModal({ id: 'direct' }, 'api', 'demo');
  assert.doesNotMatch(h.modal.body, /tokenLimit_/);
  assert.equal(await h.submit('key-label', fields, 'api'), '');
  assert.equal(h.calls.at(-1).body.tokenLimits, undefined);
});

test('negative, fractional, unsafe and nonnumeric MR limits fail before any request', async () => {
  const h = await formHarness();
  for (const name of Object.keys(limits)) for (const value of ['-1', '0.5', '9007199254740992', 'NaN', 'Infinity', 'invalid']) {
    assert.match(await h.submit('virtual-key', { ['tokenLimit_' + name]: value }), /非负安全整数/);
  }
  assert.equal(h.calls.length, 0);
});
