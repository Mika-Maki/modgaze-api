import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAuth } from '../src/admin-auth.mjs';

async function browserModule(path, bindings) {
  const source = await readFile(new URL('../public/assets/js/' + path, import.meta.url), 'utf8');
  const names = [...source.matchAll(/export\s*\{([^}]+)\};/g)].flatMap(m => m[1].split(',').map(n => n.trim()));
  names.push(...[...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m => m[1]));
  const script = source.replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/export\s*\{[^}]+\};/g, '').replace(/export\s+(?=(?:async\s+)?function)/g, '');
  return vm.runInNewContext(script + '\n;({' + names.join(',') + '});', bindings, { filename: path });
}
const classes = (...initial) => {
  const values = new Set(initial);
  return { add: x => values.add(x), remove: x => values.delete(x), contains: x => values.has(x), toggle() {} };
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('setup, password change and login preserve the same leading and trailing whitespace', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-ui-password-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = new AdminAuth(join(dir, 'auth.json'));
  let password = '  synthetic password  ', entered = 0;
  const error = { textContent: '', classList: classes() };
  const form = { dataset: { form: 'auth-setup' }, reset() {}, querySelector: selector => selector === '.form-error' ? error : null };
  const forms = await browserModule('forms.js', {
    app: {}, FormData: class { get() { return password; } }, toast() {},
    api: async (path, { body }) => {
      if (path === '/api/auth/setup') await auth.setPassword(body.password);
      else if (path === '/api/auth/password') { assert.equal(await auth.verify(body.currentPassword), true); await auth.setPassword(body.newPassword); }
      else assert.equal(await auth.verify(body.password), true, 'login must use exact saved password');
      return { csrfToken: 'synthetic-csrf' };
    },
    enterApp: async () => { entered++; },
  });
  for (const kind of ['auth-setup', 'auth-login', 'change-password', 'auth-login']) {
    form.dataset.form = kind;
    await forms.handleSubmit({ target: { closest: () => form }, preventDefault() {} });
    assert.equal(error.textContent, '', kind);
  }
  assert.equal(entered, 3);
  assert.equal(await auth.verify(password.trim()), false);
});

async function authHarness(fetch = async () => Response.json({ ok: true })) {
  const nodes = Object.fromEntries(['#app', '#auth-screen', '#auth-card', '#auth-reset-hint', '#modal-root', '#view'].map(id => [id, {
    innerHTML: '', classList: classes(), querySelector: () => ({ querySelector: () => null }),
  }]));
  const document = { body: { classList: classes() }, querySelector: s => nodes[s] ?? null, querySelectorAll: () => [] };
  const core = await browserModule('core.js', { document, fetch, setTimeout() {} });
  const auth = await browserModule('auth.js', { ...core, setTimeout() {}, stopPolling() {}, standDownCrt() {}, toast() {} });
  const dialogs = await browserModule('dialogs.js', core);
  core.app.authenticated = true; core.app.csrf = 'old-session';
  core.app.data = { secret: 'synthetic' }; core.app.stats = {}; core.app.pendingImport = { secret: 'synthetic' };
  core.app.reveals.add('synthetic-key-id');
  nodes['#view'].innerHTML = 'revealed synthetic key';
  return { ...core, ...auth, ...dialogs, nodes };
}

test('session expiry closes the actual secret dialog, clears sensitive state and hidden view', async () => {
  const h = await authHarness();
  h.openSecretModal('mr-synthetic', { session: 'old-session' });
  assert.equal(h.app.modalSecret, 'mr-synthetic', 'copy value survives openModal closing the previous dialog');
  assert.ok(h.nodes['#modal-root'].classList.contains('open'));
  h.sessionExpired();
  assert.equal(h.app.authenticated, false);
  assert.equal(h.app.csrf, null);
  for (const field of ['modal', 'modalSecret', 'data', 'stats', 'pendingImport']) assert.equal(h.app[field], null, field);
  assert.equal(h.app.reveals.size, 0);
  assert.equal(h.nodes['#modal-root'].innerHTML, '');
  assert.ok(!h.nodes['#modal-root'].classList.contains('open'));
  assert.equal(h.nodes['#view'].innerHTML, '');
  assert.ok(h.nodes['#app'].classList.contains('hidden'));
});

test('late management response and late secret display cannot revive an expired session', async () => {
  const pending = deferred();
  const h = await authHarness(() => pending.promise);
  const request = h.api('/api/groups/g/virtual-keys', { method: 'POST', body: {} });
  h.sessionExpired();
  pending.resolve(Response.json({ key: 'mr-late-secret' }));
  await assert.rejects(request, error => error.code === 'stale_session');
  h.openSecretModal('mr-late-secret', { session: 'old-session' });
  assert.equal(h.app.modal, null);
  h.app.authenticated = true; h.app.csrf = 'new-session';
  h.openSecretModal('mr-late-secret', { session: 'old-session' });
  assert.equal(h.app.modal, null, 'a continuation from the prior session cannot open in the new session');
  h.openSecretModal('mr-current-secret', { session: 'new-session' });
  assert.equal(h.app.modalSecret, 'mr-current-secret');
});

function form(kind, group, control = { type: 'text', value: 'draft', defaultValue: 'saved' }) {
  return { dataset: { form: kind, ...(group ? { group } : {}) }, elements: [control], contains: node => node === control };
}
async function draftHarness(initial, next, onRead = async () => {}) {
  let visible = initial;
  const document = { hidden: false, activeElement: initial[0]?.elements[0], querySelector: () => null, querySelectorAll: () => visible };
  const core = await browserModule('core.js', { document });
  Object.assign(core.app, { authenticated: true, csrf: 'session', data: { configRevision: 0 }, route: { name: 'group', id: 'g', tab: 'overview' } });
  const data = await browserModule('data.js', {
    ...core, document,
    api: async path => { await onRead(path); return { configRevision: 1, stats: {} }; },
    updateChrome() {}, updateLiveStats() {}, hideOffline() {}, toast() {}, renderFatal(error) { throw error; },
    render() { visible = next.map((item, index) => ({ ...item, replaceWith: draft => { visible[index] = draft; } })); },
  });
  return { ...data, app: core.app, document, get visible() { return visible; }, set visible(value) { visible = value; } };
}

test('revision polling retains multiple dirty page forms, refreshes clean forms and restores focus', async () => {
  let focused = 0;
  const note = form('group-note', 'g'); note.elements[0].focus = () => { focused++; };
  const limits = form('group-limits', 'g', { type: 'checkbox', checked: false, defaultChecked: true });
  const clean = form('upstream-key', 'g', { value: '', defaultValue: '' });
  const h = await draftHarness([note, limits, clean], [form('group-note', 'g'), form('group-limits', 'g'), form('upstream-key', 'g')]);
  await h.pollStats();
  assert.equal(h.visible[0], note);
  assert.equal(h.visible[1], limits);
  assert.notEqual(h.visible[2], clean);
  assert.equal(focused, 1);
  assert.equal(h.app.data.configRevision, 1);
  await h.loadState();
  assert.notEqual(h.visible[0], note, 'successful save refresh accepts server values');
});

test('silent refresh protects runtime and admin limit drafts, including edits during the request', async () => {
  const settings = form('settings', null, { value: '8787', defaultValue: '8787' });
  const limits = form('settings-admin-limits');
  const h = await draftHarness([settings, limits], [form('settings'), form('settings-admin-limits')], async () => { settings.elements[0].value = '9999'; });
  h.document.activeElement = null;
  await h.loadState({ silent: true });
  assert.equal(h.visible[0], settings);
  assert.equal(h.visible[0].elements[0].value, '9999');
  assert.equal(h.visible[1], limits);
});

test('drafts are not restored to a different target or a removed group', async () => {
  for (const next of [[], [form('group-note', 'other')]]) {
    const draft = form('group-note', 'removed');
    const h = await draftHarness([draft], next);
    h.document.activeElement = null;
    await h.loadState({ silent: true });
    assert.ok(!h.visible.includes(draft));
  }
});

test('navigation during state fetch preserves only the new page draft', async () => {
  const pending = deferred(), old = form('group-note', 'old'), current = form('group-note', 'new');
  const h = await draftHarness([old], [form('group-note', 'new')], () => pending.promise);
  h.document.activeElement = null;
  const loading = h.loadState({ silent: true });
  h.visible = [current]; h.app.route.id = 'new';
  pending.resolve(); await loading;
  assert.equal(h.visible[0], current);
});
