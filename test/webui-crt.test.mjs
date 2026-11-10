import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the shipped auth, hub mount and CRT functions at their DOM boundary.
async function browserModule(path, bindings) {
  const source = await readFile(new URL('../public/assets/js/' + path, import.meta.url), 'utf8');
  const names = [...source.matchAll(/export\s*\{([^}]+)\};/g)]
    .flatMap(match => match[1].split(',').map(name => name.trim()));
  const script = source
    .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/export\s*\{[^}]+\};/g, '');
  return vm.runInNewContext(script + '\n;({' + names.join(',') + '});', bindings, { filename: path });
}

function classList(...initial) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
  };
}

function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

function stageFixture() {
  let built;
  const shell = { classList: classList() };
  const stage = {
    classList: classList(), dataset: {}, isConnected: true, shell,
    querySelector(selector) {
      if (selector === '.eye-shell') return shell;
      if (selector === '.abyss-eye--built') return built;
      return null;
    },
  };
  built = { remove() { built = null; } };
  return stage;
}

async function harness({ reduced = false, restored = false } = {}) {
  const timers = clock();
  const elements = new Map(['#app', '#auth-screen', '#auth-card', '#auth-reset-hint'].map(id => [id, { classList: classList('hidden'), innerHTML: '' }]));
  const body = { classList: classList() };
  let stage = null;
  const document = {
    body,
    querySelector(selector) {
      if (selector === '#hub-stage') return stage;
      if (selector === '.eye-shell') return stage?.shell || null;
      return elements.get(selector) || null;
    },
  };
  const bindings = {
    document, window: { matchMedia: () => ({ matches: reduced }), setTimeout: timers.setTimeout },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    $: selector => document.querySelector(selector), app: { authenticated: false, data: null, csrf: null },
    icon: () => '', esc: value => String(value), toast() {},
  };
  const crt = await browserModule('crt.js', bindings);
  const hub = await browserModule('views/hub.js', { ...bindings, ...crt, initOrbit() {} });
  function mount() {
    if (stage) stage.isConnected = false;
    stage = stageFixture();
    hub.mountHub();
    return stage;
  }
  const auth = await browserModule('auth.js', {
    ...bindings, ...crt, stopPolling() {}, startPolling() {}, loadState: async () => { mount(); },
    api: async () => ({ configured: true, authenticated: restored, csrfToken: 'restored-csrf' }),
  });
  return { ...bindings, ...timers, ...crt, ...auth, mount, get stage() { return stage; } };
}

function assertSignal(h) {
  assert.equal(h.stage.dataset.initPhase, 'signal');
  assert.ok(h.stage.classList.contains('is-init'));
  assert.ok(h.document.body.classList.contains('crt-init'));
  assert.ok(h.stage.querySelector('.abyss-eye--built'));
}

function assertSettled(h) {
  assert.equal(h.stage.dataset.initPhase, 'idle');
  assert.ok(!h.stage.classList.contains('is-init'));
  assert.ok(!h.document.body.classList.contains('crt-init'));
  assert.ok(!h.document.body.classList.contains('crt-ui'));
  assert.equal(h.stage.querySelector('.abyss-eye--built'), null);
  assert.ok(h.stage.shell.classList.contains('is-final'));
}

test('first login mounts CRT before the hub is painted and runs every beat without animation callbacks', async () => {
  const h = await harness();
  await h.bootAuth();
  assert.ok(!h.document.body.classList.contains('crt-init'));
  await h.enterApp();
  assertSignal(h);
  for (const [delay, phase] of [[450, 'skeleton'], [600, 'material'], [800, 'imaging'], [400, 'control']]) {
    h.advance(delay);
    assert.equal(h.stage.dataset.initPhase, phase);
  }
  h.advance(710);
  assertSettled(h);
});

test('logout and login in the same document rearm the completed CRT sequence', async () => {
  const h = await harness();
  h.showAuth('login');
  await h.enterApp();
  h.advance(3000);
  assertSettled(h);
  h.showAuth('login');
  assert.ok(!h.document.body.classList.contains('crt-init'));
  await h.enterApp();
  assertSignal(h);
  h.advance(450);
  assert.equal(h.stage.dataset.initPhase, 'skeleton');
  h.advance(2510);
  assertSettled(h);
});

test('session expiry cancels the old build and login starts a fresh full timeline', async () => {
  const h = await harness();
  await h.enterApp();
  h.advance(1200);
  const oldStage = h.stage;
  h.sessionExpired();
  assert.equal(oldStage.dataset.initPhase, 'idle');
  assert.ok(!h.document.body.classList.contains('crt-init'));
  h.advance(250);
  await h.enterApp();
  assertSignal(h);
  h.advance(2000); // Old settle would have fired by now if not cancelled.
  assert.equal(h.stage.dataset.initPhase, 'imaging');
  assert.ok(h.document.body.classList.contains('crt-init'));
  h.advance(960);
  assertSettled(h);
});

test('normal in-session navigation does not replay CRT after returning to the homepage', async () => {
  const h = await harness();
  await h.enterApp();
  h.advance(3000);
  h.standDownCrt(); // The router uses this when opening a console module.
  h.mount();
  assertSettled(h);
  h.advance(3000);
  assertSettled(h);
});

test('leaving during CRT does not rearm it until the next login', async () => {
  const h = await harness();
  await h.enterApp();
  h.advance(500);
  h.standDownCrt();
  h.mount();
  assertSettled(h);
  h.showAuth('login');
  await h.enterApp();
  assertSignal(h);
});

test('a refresh replacing the hub mid-build transfers CRT to the new stage', async () => {
  const h = await harness();
  await h.enterApp();
  h.advance(1000);
  const oldStage = h.stage;
  h.mount();
  assertSignal(h);
  assert.equal(oldStage.isConnected, false);
  h.advance(450);
  assert.equal(h.stage.dataset.initPhase, 'skeleton');
  h.advance(2510);
  assertSettled(h);
  h.mount(); // Refresh after completion stays static.
  assertSettled(h);
});

test('reduced-motion login and relogin retain the short sequence and timer cleanup', async () => {
  const h = await harness({ reduced: true });
  for (let login = 0; login < 2; login += 1) {
    h.showAuth('login');
    await h.enterApp();
    assertSignal(h);
    assert.ok(h.stage.classList.contains('crt-still'));
    h.advance(850);
    assert.equal(h.stage.dataset.initPhase, 'control');
    h.advance(550);
    assertSettled(h);
  }
});

test('restoring an authenticated session also plays CRT on its first homepage mount', async () => {
  const h = await harness({ restored: true });
  await h.bootAuth();
  assert.equal(h.app.csrf, 'restored-csrf');
  assertSignal(h);
  h.advance(2960);
  assertSettled(h);
});
