import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function browserModule(path, bindings) {
  const source = await readFile(new URL('../public/assets/js/' + path, import.meta.url), 'utf8');
  const names = [...source.matchAll(/export\s*\{([^}]+)\};/g)].flatMap(match => match[1].split(',').map(name => name.trim()));
  const functions = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]);
  const script = source.replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/export\s*\{[^}]+\};/g, '').replace(/export\s+(?=(?:async\s+)?function)/g, '');
  return vm.runInNewContext(script + '\n;({' + [...names, ...functions].join(',') + '});', bindings, { filename: path });
}
function classList(...initial) {
  const names = new Set(initial);
  return { add: (...values) => values.forEach(value => names.add(value)), remove: (...values) => values.forEach(value => names.delete(value)), contains: name => names.has(name), toggle(name, value) { if (value) names.add(name); else names.delete(name); } };
}
async function authHarness(status) {
  const app = { authenticated: false, csrf: 'login-response-csrf' };
  const nodes = { '#app': { classList: classList('hidden') }, '#auth-screen': { classList: classList() } };
  const requests = [], effects = [];
  const auth = await browserModule('auth.js', {
    app, $: selector => nodes[selector],
    api: async (path, options) => { requests.push({ path, options }); return typeof status === 'function' ? status() : status; },
    primeCrt() { effects.push('crt'); }, startPolling() { effects.push('polling'); }, loadState: async () => { effects.push('state'); },
  });
  return { ...auth, app, nodes, requests, effects };
}

test('login does not show the app or start polling when its cookie was not returned', async () => {
  const h = await authHarness({ authenticated: false, csrfToken: null });
  await assert.rejects(h.enterApp({ verifySession: true }), error => error.code === 'session_cookie_missing' && error.message.includes('Cookie'));
  assert.equal(h.app.authenticated, false);
  assert.equal(h.app.csrf, null);
  assert.ok(h.nodes['#app'].classList.contains('hidden'));
  assert.ok(!h.nodes['#auth-screen'].classList.contains('hidden'));
  assert.deepEqual(h.effects, []);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, '/api/auth/status');
  assert.equal(h.requests[0].options.csrf, false);
});

test('login waits for a real session round trip and uses its confirmed CSRF token', async () => {
  const h = await authHarness({ authenticated: true, csrfToken: 'confirmed-csrf' });
  await h.enterApp({ verifySession: true });
  assert.equal(h.app.authenticated, true);
  assert.equal(h.app.csrf, 'confirmed-csrf');
  assert.deepEqual(h.effects, ['crt', 'polling', 'state']);
  assert.ok(!h.nodes['#app'].classList.contains('hidden'));
  assert.ok(h.nodes['#auth-screen'].classList.contains('hidden'));
});

test('a failed session check does not grant a provisional authenticated state', async () => {
  const error = new Error('status request failed');
  const h = await authHarness(() => { throw error; });
  await assert.rejects(h.enterApp({ verifySession: true }), actual => actual === error);
  assert.equal(h.app.authenticated, false);
  assert.deepEqual(h.effects, []);
});

test('restoring an already confirmed session does not make a redundant auth request', async () => {
  const h = await authHarness({ authenticated: true });
  await h.enterApp();
  assert.equal(h.requests.length, 0);
  assert.equal(h.app.authenticated, true);
});

async function submitHarness(kind, enterError) {
  const app = {};
  const fieldError = { textContent: '', classList: classList() };
  const button = { disabled: false, classList: classList() };
  const form = { dataset: { form: kind }, querySelector: selector => selector === '.form-error' ? fieldError : selector === '[type="submit"]' ? button : null };
  const calls = [];
  const forms = await browserModule('forms.js', {
    app, FormData: class { get() { return 'test-login-password'; } },
    api: async () => ({ csrfToken: 'login-response-csrf' }),
    enterApp: async options => { calls.push(options); if (enterError) throw enterError; },
  });
  const submit = () => forms.handleSubmit({ target: { closest: () => form }, preventDefault() {} });
  return { submit, app, calls, fieldError, button };
}
for (const kind of ['auth-login', 'auth-setup']) {
  test(kind + ' confirms the cookie before entering the app', async () => {
    const h = await submitHarness(kind);
    await h.submit();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.verifySession, true);
    assert.equal(h.button.disabled, false);
  });
}

test('missing-cookie errors remain in the login form instead of a login/logout flash', async () => {
  const h = await submitHarness('auth-login', Object.assign(new Error('请允许本站 Cookie 后重新登录'), { code: 'session_cookie_missing' }));
  await h.submit();
  assert.ok(h.fieldError.textContent.includes('Cookie'));
  assert.ok(h.fieldError.classList.contains('show'));
  assert.equal(h.button.disabled, false);
});
