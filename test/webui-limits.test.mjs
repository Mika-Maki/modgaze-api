import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the shipped render/form functions with small DOM boundaries, not a browser
// or a second implementation of the serializer. No npm dependencies are required.
async function browserModule(path, bindings = {}) {
  const source = await readFile(new URL('../public/assets/js/' + path, import.meta.url), 'utf8');
  const named = [...source.matchAll(/export\s*\{([^}]+)\};/g)].flatMap(match => match[1].split(',').map(name => name.trim()));
  const functions = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]);
  const script = source
    .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/export\s*\{[^}]+\};/g, '')
    .replace(/export\s+(?=(?:async\s+)?function)/g, '');
  return vm.runInNewContext(script + '\n;({' + [...named, ...functions].join(',') + '});', bindings, { filename: path });
}
const plain = value => JSON.parse(JSON.stringify(value));
const classList = () => ({ add() {}, remove() {}, toggle() {} });
const blankDocument = () => ({ hidden: false, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } });
const coreModule = bindings => browserModule('core.js', { document: blankDocument(), ...bindings });

function inputTag(html, name) {
  const tag = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes('name="' + name + '"'));
  assert.ok(tag, 'missing input ' + name);
  return tag;
}
function inputValue(html, name) {
  return inputTag(html, name).match(/\bvalue="([^"]*)"/)?.[1];
}
function adminValues(value) {
  return { maxConcurrent: value, rpm: value, perIpMaxConcurrent: value, perIpRpm: value, loginMaxConcurrent: value, loginRpm: value };
}

class FormDataStub {
  constructor(form) { this.fields = form.fields; }
  get(name) { const value = this.fields[name]; return Array.isArray(value) ? value[0] : value ?? null; }
  getAll(name) { const value = this.fields[name]; return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
}
function formFixture(kind, fields = {}, dataset = {}, checked = {}) {
  const error = { textContent: '', classList: classList() };
  const button = { disabled: false, classList: classList() };
  const form = {
    fields, dataset: { form: kind, ...dataset }, error, button,
    querySelector(selector) {
      if (selector === '.form-error') return error;
      if (selector === '[type="submit"]') return button;
      const name = selector.match(/^\[name="([^"]+)"\]$/)?.[1];
      return name ? { checked: Boolean(checked[name]) } : null;
    },
  };
  const event = { target: { closest: () => form }, preventDefault() {} };
  return { form, event };
}
async function formModule(core, overrides = {}) {
  const requests = [];
  const forms = await browserModule('forms.js', {
    ...core, FormData: FormDataStub,
    api: async (path, options) => { requests.push(plain({ path, ...options })); return { group: { id: 'demo', models: [] } }; },
    loadState: async () => {}, enterApp: async () => {}, navigate() {}, showOffline() {}, openSecretModal() {}, closeModal() {}, toast() {},
    ...overrides,
  });
  return { ...forms, requests };
}

const runningSettings = {
  host: '127.0.0.1', port: 8787, configuredAdminPort: 8788,
  upstreamTimeoutMs: 120000, requestTimeoutMs: 600000,
};

test('system rendering separates admin scopes, defaults to 256 MiB and keeps zero unlimited', async () => {
  const core = await coreModule();
  const system = await browserModule('views/system.js', core);
  core.app.data = { settings: { ...runningSettings }, runtime: { routerPort: 8787, adminPort: 8788 } };
  let html = system.systemGeneralTab();
  assert.equal(inputValue(html, 'maxResponseMiB'), '256');
  for (const [name, value] of Object.entries({ maxConcurrent: 64, rpm: 600, perIpMaxConcurrent: 32, perIpRpm: 300, loginMaxConcurrent: 2, loginRpm: 10 })) {
    assert.equal(inputValue(html, 'admin.' + name), String(value));
  }
  assert.doesNotMatch(html, /name="api[.]/);
  assert.equal(inputValue(html, 'port'), '8787');
  assert.equal(core.routerBase(), 'http://127.0.0.1:8787');
  core.app.data.settings.rateLimits = { admin: adminValues(0) };
  core.app.data.settings.maxResponseBytes = 1572864;
  html = system.systemGeneralTab();
  assert.equal(inputValue(html, 'maxResponseMiB'), '1.5');
  for (const name of Object.keys(adminValues(0))) {
    assert.equal(inputValue(html, 'admin.' + name), '0');
    assert.match(inputTag(html, 'admin.' + name), /min="0" max="100000" step="1"/);
  }
  assert.match(html, /<option value="0" label="无上限">无上限<\/option>/);
  assert.equal(core.formatRateLimit(0), '无上限');
  assert.equal(core.formatRateLimit(undefined), '无上限');
  assert.equal(core.formatRateLimit(12), '12');
});

test('create/edit dialogs and group detail use the same zero-safe group limits', async () => {
  const core = await coreModule();
  core.app.data = { groups: [] };
  let modal;
  const dialogs = await browserModule('dialogs.js', { ...core, openModal: options => { modal = options; } });
  dialogs.openCreateGroupModal();
  for (const name of ['rateMaxConcurrent', 'rateRpm']) assert.equal(inputValue(modal.body, name), '0');
  dialogs.openEditGroupModal({ id: 'demo', name: 'Demo', enabled: true, rateLimits: { maxConcurrent: 0, rpm: 123 } });
  assert.equal(inputValue(modal.body, 'rateMaxConcurrent'), '0');
  assert.equal(inputValue(modal.body, 'rateRpm'), '123');
  const detail = await browserModule('views/group-detail.js', core);
  const group = { id: 'demo', name: 'Demo', routes: {}, protocols: ['chat'], virtualKeys: [], apiKeys: [], models: [] };
  const html = detail.groupOverviewTab(group, { requests: 0, errors: 0 });
  assert.match(html, /当前并发：<b>无上限<\/b>；RPM：<b>无上限<\/b>/);
  assert.match(html, /data-form="group-limits"/);
  assert.equal(inputValue(html, 'rateMaxConcurrent'), '0');
});

test('settings form serializes MiB exactly and admin form sends only nested admin limits', async () => {
  const core = await coreModule();
  const forms = await formModule(core);
  const fixture = formFixture('settings', { host: '127.0.0.1', port: '8787', adminPort: '8788', maxBodyMiB: '64', maxResponseMiB: '1.5', upstreamTimeoutMs: '120000', requestTimeoutMs: '600000' });
  await forms.handleSubmit(fixture.event);
  assert.equal(fixture.form.error.textContent, '');
  assert.equal(forms.requests[0].path, '/api/settings');
  assert.equal(forms.requests[0].method, 'PATCH');
  assert.equal(forms.requests[0].body.maxResponseBytes, 1572864);
  assert.equal(forms.requests[0].body.port, 8787);
  const admin = formFixture('settings-admin-limits', Object.fromEntries(Object.keys(adminValues(0)).map(name => ['admin.' + name, '0'])));
  await forms.handleSubmit(admin.event);
  assert.equal(admin.form.error.textContent, '');
  assert.deepEqual(forms.requests[1], { path: '/api/settings', method: 'PATCH', body: { rateLimits: { admin: adminValues(0) } } });
  assert.equal(admin.form.button.disabled, false);
});

test('group create/edit/detail submit group-scoped limits and preserve unlimited after reload', async () => {
  const core = await coreModule();
  const forms = await formModule(core);
  const fixtures = [
    formFixture('create-group', { id: 'demo', name: 'Demo', protocols: ['chat'], baseURL: 'https://example.com/v1', upstreamApiKey: 'sk-demo', models: 'demo-model', rateMaxConcurrent: '0', rateRpm: '0' }),
    formFixture('group-basic', { newId: 'demo', name: 'Demo', rateMaxConcurrent: '3', rateRpm: '100000' }, { group: 'demo' }, { enabled: true }),
    formFixture('group-limits', { rateMaxConcurrent: '0', rateRpm: '0' }, { group: 'demo' }),
  ];
  for (const fixture of fixtures) { await forms.handleSubmit(fixture.event); assert.equal(fixture.form.error.textContent, ''); }
  assert.deepEqual(forms.requests[0].body.rateLimits, { maxConcurrent: 0, rpm: 0 });
  assert.deepEqual(forms.requests[1].body.rateLimits, { maxConcurrent: 3, rpm: 100000 });
  assert.deepEqual(forms.requests[2], { path: '/api/groups/demo', method: 'PATCH', body: { rateLimits: { maxConcurrent: 0, rpm: 0 } } });
  const detail = await browserModule('views/group-detail.js', core);
  const html = detail.groupOverviewTab({ id: 'demo', routes: {}, protocols: [], virtualKeys: [], apiKeys: [], rateLimits: forms.requests[2].body.rateLimits }, { requests: 0, errors: 0 });
  assert.match(html, /当前并发：<b>无上限<\/b>；RPM：<b>无上限<\/b>/);
});

test('submitted limits survive the real state reload and re-render path', async () => {
  const core = await coreModule();
  const stored = {
    settings: { ...runningSettings, maxResponseBytes: 268435456, rateLimits: { admin: adminValues(12) } },
    runtime: { routerPort: 8787, adminPort: 8788 },
    groups: [{ id: 'demo', routes: {}, protocols: [], virtualKeys: [], apiKeys: [], rateLimits: { maxConcurrent: 8, rpm: 60 } }],
  };
  core.app.data = plain(stored);
  const system = await browserModule('views/system.js', core);
  const detail = await browserModule('views/group-detail.js', core);
  let html = '';
  let stateReads = 0;
  const data = await browserModule('data.js', {
    ...core,
    api: async () => { stateReads += 1; return plain(stored); },
    render: () => { html = system.systemGeneralTab() + detail.groupOverviewTab(core.app.data.groups[0], { requests: 0, errors: 0 }); },
    renderLoading() {}, renderFatal(error) { throw error; }, showOffline() {}, hideOffline() {}, updateChrome() {},
  });
  const forms = await formModule(core, {
    api: async (path, { body }) => {
      if (path === '/api/settings') stored.settings.rateLimits.admin = plain(body.rateLimits.admin);
      else stored.groups[0].rateLimits = plain(body.rateLimits);
      return {};
    },
    loadState: data.loadState,
  });
  const admin = formFixture('settings-admin-limits', Object.fromEntries(Object.keys(adminValues(0)).map(name => ['admin.' + name, '0'])));
  await forms.handleSubmit(admin.event);
  assert.equal(admin.form.error.textContent, '');
  for (const name of Object.keys(adminValues(0))) assert.equal(inputValue(html, 'admin.' + name), '0');
  const group = formFixture('group-limits', { rateMaxConcurrent: '0', rateRpm: '0' }, { group: 'demo' });
  await forms.handleSubmit(group.event);
  assert.equal(group.form.error.textContent, '');
  assert.equal(stateReads, 2);
  assert.equal(inputValue(html, 'rateMaxConcurrent'), '0');
  assert.equal(inputValue(html, 'rateRpm'), '0');
  assert.match(html, /当前并发：<b>无上限<\/b>；RPM：<b>无上限<\/b>/);
});

test('invalid group/admin limits and nonintegral response bytes never send requests', async () => {
  const core = await coreModule();
  const forms = await formModule(core);
  for (const invalid of ['', '-1', '1.5', '100001', 'NaN', 'Infinity']) {
    const fixture = formFixture('group-limits', { rateMaxConcurrent: invalid, rateRpm: '0' }, { group: 'demo' });
    await forms.handleSubmit(fixture.event);
    assert.match(fixture.form.error.textContent, /0–100000/);
    assert.equal(fixture.form.button.disabled, false);
  }
  const admin = formFixture('settings-admin-limits', Object.fromEntries(Object.keys(adminValues(0)).map(name => ['admin.' + name, name === 'loginRpm' ? '-1' : '0'])));
  await forms.handleSubmit(admin.event);
  assert.match(admin.form.error.textContent, /0–100000/);
  for (const invalid of ['', '0', '-1', '0.0000001', '100000000000000']) {
    const fixture = formFixture('settings', { maxResponseMiB: invalid });
    await forms.handleSubmit(fixture.event);
    assert.match(fixture.form.error.textContent, /最大响应/);
  }
  assert.equal(forms.requests.length, 0);
});

test('api exposes Retry-After seconds and HTTP dates without retrying writes', async () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  let calls = 0;
  let raw = '7';
  const core = await coreModule({ Date: class extends Date { static now() { return now; } }, fetch: async () => {
    calls += 1;
    return { ok: false, status: 429, headers: { get: () => raw }, json: async () => ({ error: { message: '慢一点', code: 'rate_limited' } }) };
  } });
  await assert.rejects(core.api('/api/settings', { method: 'PATCH', body: { rateLimits: { admin: { rpm: 0 } } } }), error => error.status === 429 && error.retryAfter === 7 && error.code === 'rate_limited');
  assert.equal(calls, 1);
  assert.equal(core.app.adminRetryAt, now + 7000);
  raw = new Date(now + 12000).toUTCString();
  await assert.rejects(core.api('/api/stats'), error => error.retryAfter === 12);
  assert.equal(calls, 2);
  for (const invalid of [null, '', '-1', 'Infinity', 'not-a-date']) assert.equal(core.retryAfterSeconds(invalid), null);
  assert.equal(core.retryAfterSeconds(new Date(now - 1000).toUTCString()), 0);
});

async function pollingModule(api) {
  const core = await coreModule();
  const document = blankDocument();
  const now = { value: 1000 };
  const offline = [];
  core.app.authenticated = true;
  const data = await browserModule('data.js', {
    ...core, api, document, Date: class extends Date { static now() { return now.value; } },
    render() {}, renderLoading() {}, renderFatal() {}, updateChrome() {}, updateLiveStats() {}, hideOffline() {}, showOffline: text => offline.push(text),
  });
  return { ...data, app: core.app, now, document, offline };
}

test('stats polling does not reenter while a request is in flight and always releases its lock', async () => {
  let calls = 0;
  let finish;
  const deferred = new Promise(resolve => { finish = resolve; });
  const polling = await pollingModule(async () => { calls += 1; return deferred; });
  const pending = polling.pollStats();
  await polling.pollStats();
  assert.equal(calls, 1);
  assert.equal(polling.app.pollStatsInFlight, true);
  finish({ stats: { requests: 3 } });
  await pending;
  assert.equal(polling.app.pollStatsInFlight, false);
  assert.equal(polling.app.stats.requests, 3);
  await polling.pollStats();
  assert.equal(calls, 2);
  polling.document.hidden = true;
  await polling.pollStats();
  polling.document.hidden = false;
  polling.app.authenticated = false;
  await polling.pollStats();
  assert.equal(calls, 2);
});

test('stats 429 respects server backoff and shared admin cooldown without false offline state', async () => {
  let calls = 0;
  const polling = await pollingModule(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('limited'), { status: 429, retryAfter: 15 });
    return { stats: { requests: 1 } };
  });
  await polling.pollStats();
  assert.equal(polling.app.pollStatsInFlight, false);
  assert.equal(polling.app.pollStatsRetryAt, 16000);
  assert.equal(polling.offline.length, 0);
  polling.now.value = 15999;
  await polling.pollStats();
  assert.equal(calls, 1);
  polling.now.value = 16000;
  await polling.pollStats();
  assert.equal(calls, 2);
  assert.equal(polling.app.pollStatsRetryAt, 0);
  polling.app.adminRetryAt = 30000;
  await polling.pollStats();
  assert.equal(calls, 2);
  polling.now.value = 30000;
  await polling.pollStats();
  assert.equal(calls, 3);
});

test('stats missing Retry-After uses a bounded fallback and network failures release lock', async () => {
  let calls = 0;
  const polling = await pollingModule(async () => {
    calls += 1;
    throw Object.assign(new Error('failed'), calls === 1 ? { status: 429, retryAfter: null } : { network: true });
  });
  await polling.pollStats();
  assert.equal(polling.app.pollStatsRetryAt, 5000);
  polling.now.value = 5000;
  await polling.pollStats();
  assert.equal(polling.app.pollStatsInFlight, false);
  assert.equal(polling.offline.length, 1);
});
