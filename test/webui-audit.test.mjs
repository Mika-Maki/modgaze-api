import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run shipped rendering and submit functions at the same DOM boundary as webui-limits.
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
const fields = { requestIp: true, inputTokens: true, outputTokens: true, systemPrompt: false, reasoningTokens: true, model: true, group: true, key: false };
const labels = ['Request IP', 'Input Token', 'Output Token', 'System Prompt', 'Reasoning Token', 'Model', 'Group', 'Key'];
const allFields = enabled => Object.fromEntries(Object.keys(fields).map(name => [name, enabled]));
const plain = value => JSON.parse(JSON.stringify(value));
const classList = () => ({ add() {}, remove() {}, toggle() {} });
async function coreModule() {
  return browserModule('core.js', { document: { hidden: false, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } } });
}
async function renderer(data = {}) {
  const core = await coreModule();
  core.app.data = { settings: {}, ...data };
  const system = await browserModule('views/system.js', core);
  return { core, render: system.systemAuditTab };
}
function inputTag(html, name) {
  const result = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes('name="' + name + '"'));
  assert.ok(result, 'missing input ' + name);
  return result;
}
const record = (extra = {}) => ({ time: '2026-01-01T00:00:00Z', requestId: 'req-one', method: 'POST', protocol: 'chat', status: 200, outcome: 'success', durationMs: 0, ...extra });
const tableRows = html => [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].flatMap(match => [...match[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => cell[1])));

class FormDataStub {
  constructor(form) { this.fields = form.fields; }
  get(name) { return this.fields[name] ?? null; }
}
function formFixture(values = {}, checked = {}) {
  const error = { textContent: '', classList: classList() };
  const button = { disabled: false, classList: classList() };
  const form = {
    dataset: { form: 'settings-audit' },
    fields: { ipSource: 'cloudflare', trustedProxies: '127.0.0.1\n::1', maxEntries: '500', maxPromptChars: '16384', ...values },
    querySelector(selector) {
      if (selector === '.form-error') return error;
      if (selector === '[type="submit"]') return button;
      const name = selector.match(/^\[name="([^"]+)"\]$/)?.[1];
      return name ? { checked: Boolean(checked[name]) } : null;
    },
  };
  return { error, button, event: { target: { closest: () => form }, preventDefault() {} } };
}
async function submitter(overrides = {}) {
  const requests = [];
  const reloads = [];
  const forms = await browserModule('forms.js', {
    ...await coreModule(), FormData: FormDataStub,
    api: async (path, options) => { requests.push(plain({ path, ...options })); return {}; },
    loadState: async () => { reloads.push(true); }, toast() {}, showOffline() {}, ...overrides,
  });
  return { submit: forms.handleSubmit, requests, reloads };
}

test('audit tab defaults are opt-in with all switches, trust guidance and management history below', async () => {
  const { render } = await renderer({ recentAudit: [{ time: '2026-01-01', action: 'auth.login', target: '<admin>', ok: true }] });
  const html = render();
  assert.match(html, /data-form="settings-audit"/);
  assert.doesNotMatch(inputTag(html, 'enabled'), /checked/);
  for (const [name, enabled] of Object.entries(fields)) assert.equal(/checked/.test(inputTag(html, 'fields.' + name)), enabled, name);
  for (const label of labels) assert.ok(html.includes(label));
  assert.match(html, /<option value="cloudflare" selected>/);
  assert.match(html, /<option value="socket">/);
  assert.match(html, /<option value="x-forwarded-for">/);
  assert.match(html, /name="trustedProxies"[^>]*>127\.0\.0\.1\n::1<\/textarea>/);
  assert.match(inputTag(html, 'maxEntries'), /min="1" max="2000" step="1" value="500"/);
  assert.match(inputTag(html, 'maxPromptChars'), /min="1" max="65536" step="1" value="16384"/);
  assert.match(html, /&lt;admin&gt;/);
});

test('request entries are grouped by exact IP with server summary counts and unknown IP bucket', async () => {
  const { render } = await renderer({
    requestAudit: {
      entries: [record({ requestId: 'one', requestIp: '203.0.113.1' }), record({ requestId: 'two', requestIp: '2001:db8::1', status: 502 }), record({ requestId: 'three', requestIp: '203.0.113.1' }), record({ requestId: 'four' })],
      byIp: [{ ip: '203.0.113.1', requests: 2, errors: 0 }, { ip: '2001:db8::1', requests: 1, errors: 1 }], total: 4,
    },
  });
  const html = render();
  assert.equal((html.match(/data-audit-ip=/g) || []).length, 3);
  assert.match(html, /<details[^>]*data-audit-ip="203\.0\.113\.1"[^>]*>[\s\S]*?2 请求 · 0 错误/);
  assert.match(html, /data-audit-ip="2001:db8::1"[^>]*>[\s\S]*?1 请求 · 1 错误/);
  assert.match(html, /未记录 IP/);
  assert.equal(tableRows(html).length, 4);
  assert.deepEqual(tableRows(html).map(row => row[1]), ['one', 'three', 'two', 'four']);
  assert.match(html, /class="table-wrap"/);
});

test('missing and null usage are dashes while real zero remains zero', async () => {
  const { render } = await renderer({ requestAudit: { entries: [record({ requestId: 'zero', inputTokens: 0, outputTokens: null, reasoningTokens: 0 }), record({ requestId: 'missing' })] } });
  const rows = tableRows(render());
  assert.equal(rows[0][6], '0 ms');
  assert.deepEqual(rows[0].slice(8, 11), ['0', '—', '0']);
  assert.deepEqual(rows[1].slice(8, 11), ['—', '—', '—']);
});

test('all optional values and grouped IP attributes are escaped; prompts are collapsible', async () => {
  const hostile = '<img src=x onerror="evil()">&\'';
  const { core, render } = await renderer({ settings: { audit: { enabled: true, fields: allFields(true) } }, requestAudit: { entries: [record({ ...Object.fromEntries(Object.keys(fields).map(name => [name, hostile])), requestId: hostile, method: hostile, protocol: hostile, status: hostile, outcome: hostile })] } });
  let html = render();
  assert.doesNotMatch(html, /<img|onerror="evil/);
  assert.match(html, /&lt;img src=x onerror=&quot;evil\(\)&quot;&gt;&amp;&#39;/);
  assert.match(html, /<details><summary>System Prompt<\/summary><pre class="codeblock">&lt;img/);
  for (const label of labels) assert.ok(html.includes('<th>' + label + '</th>'));
  core.app.data.settings.audit.fields = allFields(false);
  html = render();
  assert.doesNotMatch(html, /data-audit-ip=/);
  for (const label of labels) assert.ok(!html.includes('<th>' + label + '</th>'));
  assert.doesNotMatch(html, /<summary>System Prompt/);
  assert.equal(tableRows(html)[0].length, 7);
});

test('IP opt-out hides historical IPs and disabled optional field values even in stale state', async () => {
  const { render } = await renderer({ settings: { audit: { fields: allFields(false) } }, requestAudit: { entries: [record({ requestIp: '203.0.113.99', systemPrompt: 'secret-prompt', key: 'key-fingerprint', model: 'hidden-model', group: 'hidden-group' })], byIp: [{ ip: '203.0.113.99', requests: 1, errors: 0 }] } });
  const html = render();
  for (const hidden of ['203.0.113.99', 'secret-prompt', 'key-fingerprint', 'hidden-model', 'hidden-group', 'data-audit-ip=']) assert.ok(!html.includes(hidden));
  assert.match(html, /不进行 IP 分组/);
});

test('audit submit serializes every unchecked switch as false and only patches audit', async () => {
  const { submit, requests, reloads } = await submitter();
  const fixture = formFixture();
  await submit(fixture.event);
  assert.equal(fixture.error.textContent, '');
  assert.equal(fixture.button.disabled, false);
  assert.deepEqual(requests, [{ path: '/api/settings', method: 'PATCH', body: { audit: { enabled: false, fields: allFields(false), ipSource: 'cloudflare', trustedProxies: ['127.0.0.1', '::1'], maxEntries: 500, maxPromptChars: 16384 } } }]);
  assert.equal(reloads.length, 1);
});

test('audit submit keeps mixed switches, parses newline/comma proxies and accepts bounds', async () => {
  const { submit, requests } = await submitter();
  const checked = { enabled: true, 'fields.requestIp': true, 'fields.systemPrompt': true, 'fields.key': true };
  for (const ipSource of ['socket', 'x-forwarded-for']) {
    const fixture = formFixture({ ipSource, trustedProxies: ' 127.0.0.1, ::1\n 192.0.2.1,\n', maxEntries: '2000', maxPromptChars: '1' }, checked);
    await submit(fixture.event);
    assert.equal(fixture.error.textContent, '');
    const audit = requests.at(-1).body.audit;
    assert.deepEqual(audit.fields, { ...allFields(false), requestIp: true, systemPrompt: true, key: true });
    assert.equal(audit.enabled, true);
    assert.equal(audit.ipSource, ipSource);
    assert.deepEqual(audit.trustedProxies, ['127.0.0.1', '::1', '192.0.2.1']);
    assert.equal(audit.maxEntries, 2000);
    assert.equal(audit.maxPromptChars, 1);
  }
});

test('audit submit rejects invalid bounded values and source before sending', async () => {
  const { submit, requests } = await submitter();
  for (const values of [{ maxEntries: '' }, { maxEntries: '0' }, { maxEntries: '2001' }, { maxEntries: '1.5' }, { maxPromptChars: '-1' }, { maxPromptChars: '0' }, { maxPromptChars: '65537' }, { maxPromptChars: 'NaN' }, { ipSource: 'forwarded' }]) {
    const fixture = formFixture(values);
    await submit(fixture.event);
    assert.ok(fixture.error.textContent, JSON.stringify(values));
    assert.equal(fixture.button.disabled, false);
  }
  assert.equal(requests.length, 0);
});

test('audit submit displays backend validation errors and does not reload state', async () => {
  const { submit, reloads } = await submitter({ api: async () => { throw new Error('trustedProxies must contain exact IPs'); } });
  const fixture = formFixture({ trustedProxies: 'invalid.example' });
  await submit(fixture.event);
  assert.equal(fixture.error.textContent, 'trustedProxies must contain exact IPs');
  assert.equal(fixture.button.disabled, false);
  assert.equal(reloads.length, 0);
});

test('existing refresh action fetches new audit entries while retaining dirty audit controls and focus', async () => {
  for (const control of [
    { type: 'checkbox', checked: false, defaultChecked: true },
    { tagName: 'TEXTAREA', value: '192.0.2.1', defaultValue: '127.0.0.1' },
    { tagName: 'SELECT', options: [{ selected: false, defaultSelected: true }, { selected: true, defaultSelected: false }] },
  ]) {
    const core = await coreModule();
    core.app.data = { settings: {}, requestAudit: { entries: [] } };
    core.app.route = { name: 'system', tab: 'audit' };
    let focusCalls = 0, stateReads = 0, rendered = '';
    control.focus = () => { focusCalls++; };
    const draft = { dataset: { form: 'settings-audit' }, elements: [control], contains: element => element === control };
    let currentForm = draft;
    const system = await browserModule('views/system.js', core);
    const data = await browserModule('data.js', {
      ...core, document: { activeElement: control },
      $: selector => selector === 'form[data-form="settings-audit"]' ? currentForm : null,
      $$: () => [currentForm],
      api: async path => {
        assert.equal(path, '/api/state'); stateReads++;
        return { settings: {}, stats: {}, requestAudit: { entries: [record({ requestId: 'fresh-request' })] } };
      },
      render: () => { rendered = system.systemAuditTab(); currentForm = { dataset: draft.dataset, replaceWith: form => { currentForm = form; } }; },
      updateChrome() {}, hideOffline() {}, renderLoading() {}, renderFatal(error) { throw error; }, showOffline() {},
    });
    const actions = await browserModule('actions.js', { ...core, loadState: data.loadState, toast() {} });
    await actions.handleClick({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'refresh' } } : null }, preventDefault() {} });
    assert.equal(stateReads, 1);
    assert.match(rendered, /fresh-request/);
    assert.equal(currentForm, draft);
    assert.equal(focusCalls, 1);
  }
});
