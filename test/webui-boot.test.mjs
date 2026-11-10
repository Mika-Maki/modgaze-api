import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const asset = path => new URL('../public/' + path, import.meta.url);
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function classList(...initial) {
  const names = new Set(initial);
  return {
    add: (...values) => values.forEach(value => names.add(value)),
    remove: (...values) => values.forEach(value => names.delete(value)),
    contains: value => names.has(value),
  };
}

function clock() {
  let now = 0, sequence = 0;
  const pending = new Map();
  return {
    setTimeout(fn, delay) { const id = ++sequence; pending.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].fn();
      }
      now = until;
    },
    get pending() { return pending.size; },
  };
}

// Run the real classic bootstrap, replacing only its network/module boundary.
async function bootstrap() {
  const source = await readFile(asset('assets/boot.js'), 'utf8');
  assert.equal(source.split("import('./app.js')").length - 1, 1, 'bootstrap must load the real application entry exactly once');
  assert.doesNotMatch(source, /^\s*(?:import\s+|export\s+)/m, 'bootstrap cannot depend on the application module graph');
  const load = deferred(), session = deferred();
  const timers = clock();
  const status = { dataset: { state: 'loading' }, isConnected: true };
  const title = { textContent: '正在连接控制台' };
  const message = { textContent: '正在加载界面并检查登录状态。' };
  const detail = { textContent: '', classList: classList('hidden') };
  const auth = { classList: classList('auth-screen') };
  const nodes = { '#boot-status': status, '#boot-title': title, '#boot-message': message, '#boot-detail': detail, '#auth-screen': auth };
  const errors = [];
  let loads = 0, inits = 0;
  const module = { init() { inits += 1; return session.promise; } };
  vm.runInNewContext(source.replace("import('./app.js')", 'loadApp()'), {
    document: { querySelector: selector => nodes[selector] || null },
    window: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    console: { error: (...args) => errors.push(args) },
    loadApp() { loads += 1; return load.promise; },
  }, { filename: 'boot.js' });
  return { status, title, message, detail, auth, load, session, module, timers, errors,
    get loads() { return loads; }, get inits() { return inits; } };
}

function assertFailure(h, state, phase, error) {
  assert.equal(h.status.dataset.state, state);
  assert.equal(h.status.dataset.phase, phase);
  assert.match(h.title.textContent, /[\u4e00-\u9fff]/);
  assert.match(h.message.textContent, /[\u4e00-\u9fff]/);
  assert.notEqual(h.title.textContent, '正在连接控制台');
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0][0], '[Modgaze boot]');
  assert.equal(h.errors[0][1], phase);
  if (error) assert.equal(h.errors[0][2], error);
}

function tagWithId(html, id) {
  const tag = [...html.matchAll(/<[a-z][^>]*>/gi)].map(match => match[0]).find(value => value.includes('id="' + id + '"'));
  assert.ok(tag, 'missing element ' + id);
  return tag;
}
const attribute = (tag, name) => [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].find(match => match[1] === name)?.[2];

test('initial HTML is visible before JavaScript and includes accessible status, native reload and noscript feedback', async () => {
  const html = await readFile(asset('index.html'), 'utf8');
  const auth = tagWithId(html, 'auth-screen');
  assert.ok(attribute(auth, 'class').split(/\s+/).includes('auth-screen'));
  assert.ok(!attribute(auth, 'class').split(/\s+/).includes('hidden'));
  const panel = tagWithId(html, 'boot-status');
  assert.equal(attribute(panel, 'data-state'), 'loading');
  assert.equal(attribute(panel, 'role'), 'status');
  assert.ok(html.indexOf(panel) > html.indexOf(tagWithId(html, 'auth-card')));
  assert.ok(html.indexOf(panel) < html.indexOf(tagWithId(html, 'auth-reset-hint')));
  for (const id of ['boot-title', 'boot-message']) {
    const tag = tagWithId(html, id);
    const text = html.slice(html.indexOf(tag) + tag.length).split('<')[0].trim();
    assert.match(text, /[\u4e00-\u9fff]/, id + ' needs useful text without script execution');
  }
  const retry = tagWithId(html, 'boot-retry');
  assert.match(retry, /^<a\b/);
  assert.equal(attribute(retry, 'href'), '', 'reload must work without application event handlers');
  assert.doesNotMatch(retry, /\b(?:data-action|onclick)=/);
  assert.match(html, /<noscript\b[^>]*>[\s\S]*?JavaScript[\s\S]*?<\/noscript>/);
});

test('HTML starts an external deferred classic bootstrap rather than an inline or module entry', async () => {
  const html = await readFile(asset('index.html'), 'utf8');
  const scripts = [...html.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.equal(attribute(scripts[0][1], 'src'), '/assets/boot.js');
  assert.match(scripts[0][1], /\bdefer(?:\s|=|>)/);
  assert.notEqual(attribute(scripts[0][1], 'type'), 'module');
  assert.equal(scripts[0][2].trim(), '', 'CSP must not require inline script execution');
});

test('module load failure reports modules phase and cancels the watchdog', async () => {
  const h = await bootstrap();
  const error = new Error('module request failed');
  assert.equal(h.loads, 1);
  h.load.reject(error);
  await flush();
  assertFailure(h, 'failed', 'modules', error);
  assert.equal(h.inits, 0);
  assert.equal(h.timers.pending, 0);
  h.timers.advance(15000);
  assert.equal(h.errors.length, 1);
});

test('application init failure reports session phase and cancels the watchdog', async () => {
  const h = await bootstrap();
  h.load.resolve(h.module);
  await flush();
  assert.equal(h.inits, 1);
  const error = new Error('session initialization failed');
  h.session.reject(error);
  await flush();
  assertFailure(h, 'failed', 'session', error);
  assert.equal(h.timers.pending, 0);
});

test('a pending module load becomes a visible modules timeout at exactly fifteen seconds', async () => {
  const h = await bootstrap();
  h.timers.advance(14999);
  assert.equal(h.status.dataset.state, 'loading');
  assert.deepEqual(h.errors, []);
  h.timers.advance(1);
  assertFailure(h, 'timeout', 'modules');
  assert.equal(h.loads, 1);
  assert.equal(h.inits, 0);
});

test('a pending application init becomes a session timeout on the same startup deadline', async () => {
  const h = await bootstrap();
  h.timers.advance(9000);
  h.load.resolve(h.module);
  await flush();
  h.timers.advance(5999);
  assert.equal(h.status.dataset.state, 'loading');
  h.timers.advance(1);
  assertFailure(h, 'timeout', 'session');
  assert.equal(h.loads, 1);
  assert.equal(h.inits, 1);
});

test('successful initialization awaits the session promise before clearing its timeout', async () => {
  const h = await bootstrap();
  h.load.resolve(h.module);
  await flush();
  assert.equal(h.inits, 1);
  assert.equal(h.timers.pending, 1, 'import completion alone does not finish startup');
  h.status.isConnected = false; // Real showAuth replaces #auth-card, removing the boot panel.
  h.session.resolve();
  await flush();
  assert.equal(h.timers.pending, 0);
  h.timers.advance(30000);
  assert.equal(h.status.dataset.state, 'loading');
  assert.deepEqual(h.errors, []);
});

test('a module arriving after timeout can still initialize and replace the failure panel', async () => {
  const h = await bootstrap();
  h.timers.advance(15000);
  assertFailure(h, 'timeout', 'modules');
  h.load.resolve(h.module);
  await flush();
  assert.equal(h.inits, 1, 'timeout must not abort a late but usable module');
  h.status.isConnected = false;
  h.session.resolve();
  await flush();
  assert.equal(h.timers.pending, 0);
  assert.equal(h.status.isConnected, false, 'normal auth view owns the card again');
  h.timers.advance(30000);
  assert.equal(h.errors.length, 1);
});

test('a session finishing after timeout can still restore the normal auth view', async () => {
  const h = await bootstrap();
  h.load.resolve(h.module);
  await flush();
  h.timers.advance(15000);
  assertFailure(h, 'timeout', 'session');
  h.status.isConnected = false;
  h.session.resolve();
  await flush();
  assert.equal(h.timers.pending, 0);
  assert.equal(h.loads, 1);
  assert.equal(h.inits, 1);
  assert.equal(h.errors.length, 1);
});

for (const view of ['disconnected boot panel', 'hidden auth screen']) {
  for (const failure of ['timeout', 'rejection']) {
    test(view + ' is never changed by a stale bootstrap ' + failure, async () => {
      const h = await bootstrap();
      if (view === 'disconnected boot panel') h.status.isConnected = false;
      else h.auth.classList.add('hidden');
      if (failure === 'timeout') h.timers.advance(15000);
      else { h.load.reject(new Error('late resource failure')); await flush(); }
      assert.equal(h.status.dataset.state, 'loading');
      assert.equal(h.status.dataset.phase, undefined);
      assert.equal(h.title.textContent, '正在连接控制台');
      assert.deepEqual(h.errors, []);
      assert.equal(h.timers.pending, 0);
    });
  }
}

async function appModule(bootAuth) {
  const source = await readFile(asset('assets/app.js'), 'utf8');
  const names = [...source.matchAll(/export\s*\{([^}]+)\};/g)]
    .flatMap(match => match[1].split(',').map(name => name.trim()));
  assert.ok(names.includes('init'), 'application entry must expose initialization to the bootstrap');
  const script = source
    .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/export\s*\{[^}]+\};/g, '');
  const documentEvents = [], windowEvents = [];
  const app = { theme: 'dark', route: null };
  const bindings = {
    app, bootAuth, sessionExpired() {}, parseRoute: () => ({ name: 'overview' }),
    location: { hash: '#/overview' }, history: { replaceState() {} },
    applyTheme() {}, initEye() {}, setUnauthorizedHandler() {},
    handleClick() {}, handleSubmit() {},
    document: { addEventListener: (...args) => documentEvents.push(args) },
    window: { addEventListener: (...args) => windowEvents.push(args) },
  };
  const module = vm.runInNewContext(script + '\n;({' + names.join(',') + '});', bindings, { filename: 'app.js' });
  return { ...module, app, documentEvents, windowEvents };
}

test('the real exported app init does not auto-run and stays pending until bootAuth finishes', async () => {
  const auth = deferred();
  let authCalls = 0;
  const module = await appModule(() => { authCalls += 1; return auth.promise; });
  assert.equal(authCalls, 0, 'importing app.js must not initialize a second time');
  assert.deepEqual(module.documentEvents, []);
  const initialized = module.init();
  assert.equal(typeof initialized?.then, 'function');
  assert.equal(authCalls, 1);
  assert.equal(module.app.route.name, 'overview');
  assert.deepEqual(module.documentEvents.map(([name]) => name), ['click', 'submit', 'input', 'change', 'keydown', 'visibilitychange']);
  assert.deepEqual(module.windowEvents.map(([name]) => name), ['hashchange']);
  let settled = false;
  initialized.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false, 'boot promise must cover the asynchronous authentication check');
  auth.resolve();
  await initialized;
  assert.equal(settled, true);
});

test('the real exported app init propagates bootAuth failure to the independent bootstrap', async () => {
  const error = new Error('auth bootstrap rejected');
  const module = await appModule(async () => { throw error; });
  await assert.rejects(module.init(), actual => actual === error);
});

test('module failure exposes its original browser error as bounded plain text', async () => {
  const h = await bootstrap();
  const hostile = '<img src=x onerror=evil()>' + 'x'.repeat(800);
  h.load.reject(new TypeError(hostile));
  await flush();
  assert.equal(h.status.dataset.code, 'BOOT_MODULE');
  assert.ok(!h.detail.classList.contains('hidden'));
  assert.ok(h.detail.textContent.startsWith('BOOT_MODULE [modules] TypeError: <img'));
  assert.ok(h.detail.textContent.length < 450);
  assert.equal(h.detail.innerHTML, undefined, 'error text must never be assigned as markup');
});

test('init failure exposes its exact exception instead of mislabelling every failure as network', async () => {
  const h = await bootstrap();
  h.load.resolve(h.module);
  await flush();
  const error = Object.assign(new Error('Storage denied'), { name: 'SecurityError' });
  h.session.reject(error);
  await flush();
  assert.equal(h.status.dataset.code, 'BOOT_INIT');
  assert.equal(h.detail.textContent, 'BOOT_INIT [session] SecurityError: Storage denied');
  assert.ok(!h.message.textContent.includes('请检查网络'));
});

test('startup timeout includes the phase and diagnostic code in visible details', async () => {
  const h = await bootstrap();
  h.timers.advance(15000);
  assert.equal(h.status.dataset.code, 'BOOT_TIMEOUT');
  assert.ok(h.detail.textContent.includes('[modules]'));
  assert.ok(h.detail.textContent.includes('15 秒'));
  assert.ok(!h.detail.classList.contains('hidden'));
});
