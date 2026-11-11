import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the shipped functions at the DOM/API boundary, as in webui-limits.test.mjs.
async function browserModule(path, bindings = {}) {
  const source = await readFile(new URL('../public/assets/js/' + path, import.meta.url), 'utf8');
  const named = [...source.matchAll(/export\s*\{([^}]+)\};/g)].flatMap(match => match[1].split(',').map(name => name.trim()));
  const functions = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]);
  const script = source
    .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/export\s*\{[^}]+\};/g, '')
    .replace(/export\s+(?=(?:async\s+)?function)/g, '');
  return vm.runInNewContext(script + '\n;({' + [...named, ...functions].join(',') + '});', { Date, Intl, ...bindings }, { filename: path });
}
const plain = value => JSON.parse(JSON.stringify(value));
const classList = () => ({ add() {}, remove() {}, toggle() {} });
const coreModule = () => browserModule('core.js', {
  document: { hidden: false, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } },
});
async function inTimezone(timezone, run) {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
function inputTag(html, name) {
  return [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes('name="' + name + '"'));
}
const attribute = (tag, name) => [...(tag || '').matchAll(/([\w-]+)="([^"]*)"/g)].find(match => match[1] === name)?.[2];
function modalForm(modal, changes = {}, dataset = {}) {
  const formTag = modal.body.match(/<form\b[^>]*>/)?.[0];
  const fields = {};
  for (const match of modal.body.matchAll(/<input\b[^>]*>/g)) fields[attribute(match[0], 'name')] = attribute(match[0], 'value') || '';
  const expiry = inputTag(modal.body, 'expiresAt');
  return formFixture({ ...fields, ...changes }, {
    group: attribute(formTag, 'data-group'), source: attribute(formTag, 'data-source'), keyId: attribute(formTag, 'data-key-id'), ...dataset,
  }, expiry ? { dataset: { originalLocal: attribute(expiry, 'data-original-local'), originalExpiresAt: attribute(expiry, 'data-original-expires-at') }, validity: { valid: true } } : null);
}
function formFixture(fields, dataset = {}, expiry = { dataset: {}, validity: { valid: true } }) {
  const error = { textContent: '', classList: classList() };
  const button = { disabled: false, classList: classList() };
  const form = {
    fields, error, button, expiry, dataset: { form: 'key-label', group: 'demo', source: 'virtual', keyId: 'key-1', ...dataset },
    querySelector(selector) {
      if (selector === '.form-error') return error;
      if (selector === '[type="submit"]') return button;
      if (selector === '[name="expiresAt"]') return expiry;
      return null;
    },
  };
  return { form, event: { target: { closest: () => form }, preventDefault() {} } };
}
class FormDataStub {
  constructor(form) { this.fields = form.fields; }
  get(name) { return this.fields[name] ?? null; }
}
async function harness() {
  const core = await coreModule();
  let modal;
  const dialogs = await browserModule('dialogs.js', { ...core, openModal: value => { modal = value; } });
  const requests = [];
  let reloads = 0;
  let closes = 0;
  const forms = await browserModule('forms.js', {
    ...core, FormData: FormDataStub,
    api: async (path, options) => { requests.push(plain({ path, ...options })); return {}; },
    loadState: async () => { reloads += 1; }, closeModal() { closes += 1; }, toast() {}, showOffline() {},
  });
  return { core, dialogs, forms, requests, get modal() { return modal; }, get reloads() { return reloads; }, get closes() { return closes; } };
}

test('existing MR edit modal exposes exact expiry label, seconds and actual browser timezone only for virtual keys', async () => {
  await inTimezone('Asia/Singapore', async () => {
    const h = await harness();
    h.dialogs.openKeyLabelModal({ id: 'mr-1', label: 'Client', expiresAt: '2037-07-08T12:34:56+05:30' }, 'virtual', 'demo');
    const html = h.modal.body;
    assert.ok(html.includes('<label for="key-expires-at">MR Expires at</label>'));
    const tag = inputTag(html, 'expiresAt');
    assert.equal(attribute(tag, 'type'), 'datetime-local');
    assert.equal(attribute(tag, 'step'), '1');
    assert.equal(attribute(tag, 'value'), '2037-07-08T15:04:56');
    assert.match(html, /留空表示永不过期/);
    assert.ok(html.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
    assert.match(html, /data-form="key-label"/);
    h.dialogs.openKeyLabelModal({ id: 'mr-1', expiresAt: null }, 'virtual', 'demo');
    assert.equal(attribute(inputTag(h.modal.body, 'expiresAt'), 'value'), '');
    for (const source of ['api', 'env', undefined]) {
      h.dialogs.openKeyLabelModal({ id: 'direct-1', expiresAt: '2037-07-08T00:00:00Z' }, source, 'demo');
      assert.equal(inputTag(h.modal.body, 'expiresAt'), undefined);
      assert.doesNotMatch(h.modal.body, /MR Expires at/);
    }
  });
});

test('MR edit form submits label with future UTC ISO, clearing sends null, direct keys never send expiry', async () => {
  await inTimezone('Asia/Singapore', async () => {
    const h = await harness();
    h.dialogs.openKeyLabelModal({ id: 'key/1', label: 'Before', expiresAt: null }, 'virtual', 'demo/west');
    const future = modalForm(h.modal, { label: ' After ', expiresAt: '2037-07-08T12:34:56' });
    await h.forms.handleSubmit(future.event);
    assert.equal(future.form.error.textContent, '');
    assert.deepEqual(h.requests[0], { path: '/api/groups/demo%2Fwest/virtual-keys/key%2F1', method: 'PATCH', body: { label: 'After', expiresAt: '2037-07-08T04:34:56.000Z' } });
    h.dialogs.openKeyLabelModal({ id: 'key-1', label: 'Never', expiresAt: '2037-01-01T00:00:00Z' }, 'virtual', 'demo');
    const clear = modalForm(h.modal, { expiresAt: '' });
    await h.forms.handleSubmit(clear.event);
    assert.equal(clear.form.error.textContent, '');
    assert.deepEqual(h.requests[1].body, { label: 'Never', expiresAt: null });
    h.dialogs.openKeyLabelModal({ id: 'direct-1', label: 'Direct' }, 'api', 'demo');
    const direct = modalForm(h.modal, { expiresAt: 'invalid-injected-field' });
    await h.forms.handleSubmit(direct.event);
    assert.deepEqual(h.requests[2], { path: '/api/groups/demo/api-keys/direct-1', method: 'PATCH', body: { label: 'Direct' } });
    assert.equal(h.reloads, 3);
    assert.equal(h.closes, 3);
    for (const fixture of [future, clear, direct]) assert.equal(fixture.form.button.disabled, false);
  });
});

test('shipped render and submit functions round-trip offsets, seconds and DST instants without drift', async () => {
  for (const [timezone, original, expected] of [
    ['UTC', '2037-07-08T12:34:56+05:30', '2037-07-08T07:04:56'],
    ['Asia/Singapore', '2037-07-08T12:34:56+05:30', '2037-07-08T15:04:56'],
    ['Asia/Kathmandu', '2037-07-08T12:34:56+05:30', '2037-07-08T12:49:56'],
    ['America/New_York', '2037-07-08T12:34:56+05:30', '2037-07-08T03:04:56'],
    ['America/New_York', '2037-01-08T12:34:56+05:30', '2037-01-08T02:04:56'],
    ['America/New_York', '2037-11-01T06:30:17.123Z', '2037-11-01T01:30:17'],
    ['Asia/Singapore', '2037-07-08T04:00:00.123Z', '2037-07-08T12:00:00'],
  ]) {
    await inTimezone(timezone, async () => {
      const h = await harness();
      h.dialogs.openKeyLabelModal({ id: 'mr-1', label: 'Round trip', expiresAt: original }, 'virtual', 'demo');
      assert.equal(attribute(inputTag(h.modal.body, 'expiresAt'), 'value'), expected, timezone);
      // Browsers may normalize zero seconds away in datetime-local values.
      const submitted = expected.endsWith(':00') ? expected.slice(0, -3) : expected;
      const fixture = modalForm(h.modal, { expiresAt: submitted });
      await h.forms.handleSubmit(fixture.event);
      assert.equal(fixture.form.error.textContent, '', timezone);
      assert.equal(h.requests[0].body.expiresAt, new Date(original).toISOString(), timezone);
    });
  }
});

test('changed local values convert using the selected date DST offset, never the current offset', async () => {
  await inTimezone('America/New_York', async () => {
    const h = await harness();
    for (const [local, utc] of [
      ['2037-01-08T12:34:56', '2037-01-08T17:34:56.000Z'],
      ['2037-07-08T12:34:56', '2037-07-08T16:34:56.000Z'],
      ['2037-07-08T12:34', '2037-07-08T16:34:00.000Z'],
    ]) {
      const fixture = formFixture({ label: 'DST', expiresAt: local });
      await h.forms.handleSubmit(fixture.event);
      assert.equal(fixture.form.error.textContent, '');
      assert.equal(h.requests.at(-1).body.expiresAt, utc);
    }
  });
});

test('invalid local dates and browser-invalid input show form errors without API calls', async () => {
  await inTimezone('America/New_York', async () => {
    const h = await harness();
    for (const expiresAt of ['invalid', '2037-02-29T12:34:56', '2036-02-30T12:34:56', '2037-13-01T12:34:56', '2037-07-08T24:00:00', '2037-07-08T12:60:00', '2037-07-08T12:34:60', '2037-07-08', '2037-07-08T12:34:56Z', '2037-07-08T12:34:56+08:00', '2037-03-08T02:30:00']) {
      const fixture = formFixture({ label: 'Invalid', expiresAt });
      await h.forms.handleSubmit(fixture.event);
      assert.match(fixture.form.error.textContent, /MR Expires at.*有效/, expiresAt);
      assert.equal(fixture.form.button.disabled, false);
    }
    const invalidBrowser = formFixture({ label: 'Invalid', expiresAt: '' }, {}, { dataset: {}, validity: { valid: false } });
    await h.forms.handleSubmit(invalidBrowser.event);
    assert.match(invalidBrowser.form.error.textContent, /MR Expires at.*有效/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.reloads, 0);
    assert.equal(h.closes, 0);
  });
});
