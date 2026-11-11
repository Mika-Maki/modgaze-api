import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function browserModule(path, bindings = {}) {
  const source = await readFile(new URL('../public/assets/js/' + path, import.meta.url), 'utf8');
  const names = [...source.matchAll(/export\s*\{([^}]+)\};/g)]
    .flatMap(match => match[1].split(',').map(name => name.trim()));
  const functions = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]);
  const script = source.replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/export\s*\{[^}]+\};/g, '').replace(/export\s+(?=(?:async\s+)?function)/g, '');
  return vm.runInNewContext(script + '\n;({' + [...names, ...functions].join(',') + '});', bindings, { filename: path });
}

const state = { stats: { requests: 42 }, groups: [], settings: {}, configRevision: 1 };
const json = (payload, options) => Response.json(payload, options);
async function harness(responses, overrides = {}) {
  const requests = [], effects = [], failures = [], warnings = [];
  const document = { hidden: false, querySelector: () => null, querySelectorAll: () => [] };
  const core = await browserModule('core.js', {
    document,
    fetch: async (path, options) => {
      requests.push({ path, options });
      assert.ok(responses.length, 'unexpected extra request');
      const response = await responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });
  core.app.authenticated = true;
  core.setUnauthorizedHandler(() => { core.app.authenticated = false; effects.push('unauthorized'); });
  const data = await browserModule('data.js', {
    ...core, document,
    renderLoading() { effects.push('loading'); },
    render() { effects.push('render'); },
    renderFatal(error) { failures.push(error); },
    updateChrome() {}, updateLiveStats() {}, hideOffline() {},
    showOffline() { effects.push('offline'); },
    toast: (...args) => warnings.push(args),
    ...overrides,
  });
  return { ...core, ...data, requests, effects, failures, warnings };
}

for (const [label, body] of [
  ['empty body', ''],
  ['HTML instead of JSON', '<html>Temporary response</html>'],
  ['truncated JSON', '{"stats":'],
  ['JSON null', 'null'],
  ['array', '[]'],
  ['string', '"ok"'],
  ['boolean', 'false'],
  ['number', '0'],
]) {
  test('first state load recovers from ' + label + ' without a manual reload', async () => {
    const h = await harness([new Response(body), json(state)]);
    await h.loadState();
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every(({ path, options }) => path === '/api/state' && options.method === 'GET'));
    assert.deepEqual(h.app.data, state);
    assert.deepEqual(h.app.stats, state.stats);
    assert.equal(h.app.loading, false);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(h.effects, ['loading', 'render']);
  });
}

test('a normal first state response renders once without an extra request', async () => {
  const h = await harness([json(state)]);
  await h.loadState();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.app.data, state);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.effects, ['loading', 'render']);
});

test('persistent invalid state data stops after one retry with a useful error and can be manually reloaded', async () => {
  const h = await harness([new Response(''), json(null), json(state)]);
  await h.loadState();
  assert.equal(h.requests.length, 2);
  assert.equal(h.app.data, null);
  assert.equal(h.app.stats, null);
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0].code, 'invalid_response');
  assert.equal(h.failures[0].status, 200);
  assert.match(h.failures[0].message, /管理服务.*无效/);
  assert.ok(h.failures[0].message.includes('/api/state'));
  assert.doesNotMatch(h.failures[0].message, /Cannot read properties/);
  await h.loadState();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.app.data, state);
  assert.deepEqual(h.effects, ['loading', 'loading', 'render']);
});

test('an invalid refresh preserves the last valid state and stats without automatic retries', async () => {
  const h = await harness([json(state), json(null)]);
  await h.loadState();
  const previousData = h.app.data, previousStats = h.app.stats;
  assert.equal(await h.loadState({ silent: true }), false);
  assert.equal(h.requests.length, 2);
  assert.equal(h.app.data, previousData);
  assert.equal(h.app.stats, previousStats);
  assert.deepEqual(h.failures, []);
  assert.match(h.warnings[0][0], /刷新失败/);
  assert.ok(h.warnings[0][2].includes('/api/state'));
});

test('invalid successful write responses are rejected without replaying the write', async () => {
  const h = await harness([json(null)]);
  await assert.rejects(h.api('/api/stats/reset', { method: 'POST', body: {} }), error => error.code === 'invalid_response' && error.status === 200);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.method, 'POST');
});

for (const status of [401, 429, 500]) {
  test('a non-JSON HTTP ' + status + ' remains an HTTP error without initial-load retries', async () => {
    const h = await harness([new Response('<html>Error</html>', { status, headers: { 'retry-after': '12' } })]);
    await h.loadState();
    assert.equal(h.requests.length, 1);
    if (status === 401) {
      assert.equal(h.app.authenticated, false);
      assert.deepEqual(h.failures, []);
      assert.ok(h.effects.includes('unauthorized'));
    } else {
      assert.equal(h.failures[0].status, status);
      assert.notEqual(h.failures[0].code, 'invalid_response');
      assert.equal(h.failures[0].retryAfter, 12);
      if (status === 429) assert.ok(h.app.adminRetryAt > Date.now());
    }
  });
}

test('network failures retain the offline path without immediate retries', async () => {
  const h = await harness([new TypeError('Failed to fetch')]);
  await h.loadState();
  assert.equal(h.requests.length, 1);
  assert.equal(h.failures[0].network, true);
  assert.ok(h.effects.includes('offline'));
});

test('a retry that loses its session returns to login without further retries or a fatal view', async () => {
  const h = await harness([json(null), new Response('', { status: 401 })]);
  await h.loadState();
  assert.equal(h.requests.length, 2);
  assert.equal(h.app.authenticated, false);
  assert.equal(h.app.data, null);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.effects, ['loading', 'unauthorized']);
});

test('invalid stats polling preserves the last snapshot and releases its lock for the next poll', async () => {
  const h = await harness([json(null), json({ stats: { requests: 43 } })]);
  h.app.data = state;
  h.app.stats = state.stats;
  await h.pollStats();
  assert.equal(h.app.stats, state.stats);
  assert.equal(h.app.pollStatsInFlight, false);
  assert.equal(h.requests.length, 1);
  await h.pollStats();
  assert.equal(h.requests.length, 2);
  assert.equal(h.app.stats.requests, 43);
  assert.equal(h.app.pollStatsInFlight, false);
  assert.deepEqual(h.failures, []);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const older of ['success', 'invalid', 'HTTP error']) {
  test('a late ' + older + ' from an older refresh cannot replace the latest state or view', async () => {
    const pending = deferred();
    const latest = { ...state, configRevision: 2, groups: [{ id: 'cloned' }] };
    const h = await harness([pending.promise, json(latest)]);
    h.app.data = state;
    const first = h.loadState({ silent: true });
    assert.equal(await h.loadState(), true);
    pending.resolve(older === 'success' ? json(state) : older === 'invalid' ? json(null) : new Response('', { status: 500 }));
    assert.equal(await first, false);
    assert.deepEqual(h.app.data, latest);
    assert.deepEqual(h.effects, ['render']);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(h.warnings, []);
    assert.equal(h.requests.length, 2);
  });
}

for (const kind of ['state', 'stats', 'unauthorized']) {
  test('a late ' + kind + ' response from a previous login cannot affect the new session', async () => {
    const pending = deferred();
    const h = await harness([pending.promise]);
    h.app.data = state;
    h.app.stats = state.stats;
    h.app.csrf = 'old-session';
    const request = kind === 'stats' ? h.pollStats() : h.loadState();
    h.app.csrf = 'new-session';
    pending.resolve(kind === 'unauthorized' ? new Response('', { status: 401 }) : json({ ...state, stats: { requests: 0 } }));
    await request;
    assert.equal(h.app.authenticated, true);
    assert.equal(h.app.data, state);
    assert.equal(h.app.stats, state.stats);
    assert.deepEqual(h.effects, []);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(h.warnings, []);
  });
}

const originalGroup = { id: 'original', name: 'Original', models: [], virtualKeys: [] };
const changedGroup = { id: 'changed', name: 'Changed', models: [], virtualKeys: [{ value: 'mr-synthetic-clone-key' }] };
for (const kind of ['create-group', 'group-basic', 'clone-group']) {
  for (const refreshOk of [true, false]) {
    test(kind + ' navigates only after a successful refresh and never renders the obsolete route (refresh ' + refreshOk + ')', async () => {
      const result = { group: changedGroup, generatedKey: 'mr-synthetic-created-key' };
      const next = { ...state, configRevision: 2, groups: kind === 'group-basic' ? [changedGroup] : [originalGroup, changedGroup] };
      const rendered = [];
      const h = await harness([json(result), refreshOk ? json(next) : json(null)], { render() { rendered.push('obsolete route'); } });
      h.app.data = { ...state, groups: [originalGroup] };
      h.app.route = { name: 'group', id: originalGroup.id };
      const fields = { id: changedGroup.id, newId: changedGroup.id, name: changedGroup.name, protocols: ['chat'], baseURL: 'http://127.0.0.1:1', models: 'test-model', upstreamApiKey: 'synthetic-upstream', rateMaxConcurrent: '0', rateRpm: '0' };
      const classList = { add() {}, remove() {}, toggle() {} };
      const error = { textContent: '', classList }, button = { disabled: false, classList };
      const form = { dataset: { form: kind, group: originalGroup.id }, querySelector: selector => selector === '.form-error' ? error : selector === '[type="submit"]' ? button : { checked: true } };
      const navigations = [], secrets = [], notices = [];
      const forms = await browserModule('forms.js', {
        ...h,
        FormData: class { get(name) { return fields[name] ?? ''; } getAll(name) { return fields[name] ?? []; } },
        closeModal() {}, toast: text => notices.push(text),
        navigate(hash) { assert.ok(h.findGroup(changedGroup.id), 'the target must exist before navigation'); navigations.push(hash); },
        openSecretModal: secret => secrets.push(secret),
      });
      await forms.handleSubmit({ target: { closest: () => form }, preventDefault() {} });
      assert.equal(h.requests.length, 2, 'the mutation is never replayed');
      assert.equal(h.requests[0].options.method, kind === 'group-basic' ? 'PATCH' : 'POST');
      assert.equal(h.requests[1].path, '/api/state');
      assert.equal(navigations.length, refreshOk ? 1 : 0);
      assert.deepEqual(rendered, [], 'renaming must not render the old now-missing group before navigation');
      assert.deepEqual(h.failures, [], 'a refresh failure must not replace a usable view');
      assert.equal(h.warnings.length, refreshOk ? 0 : 1);
      assert.equal(secrets.length, kind === 'group-basic' ? 0 : 1, 'a committed generated key remains available even if refresh fails');
      assert.equal(notices.length, 1, 'the committed mutation is still reported as successful');
      assert.equal(error.textContent, '');
      assert.equal(button.disabled, false);
    });
  }
}

test('manual refresh does not announce success when fetching state fails', async () => {
  const h = await harness([json(null)]);
  h.app.data = state;
  const notices = [];
  const actions = await browserModule('actions.js', { ...h, toast: (...args) => notices.push(args) });
  await actions.handleClick({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'refresh' } } : null }, preventDefault() {} });
  assert.deepEqual(notices, []);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.app.data, state);
});
