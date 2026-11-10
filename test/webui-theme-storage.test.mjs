import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function themeModule(mode) {
  const source = await readFile(new URL('../public/assets/js/core.js', import.meta.url), 'utf8');
  const document = { documentElement: { dataset: {} }, querySelector: () => null, querySelectorAll: () => [] };
  const calls = [];
  let legacy = mode === 'legacy' || mode === 'remove-denied' ? 'light' : null;
  const denied = () => { throw new DOMException('Access is denied for this document.', 'SecurityError'); };
  const storage = {
    getItem(key) { calls.push(['get', key]); if (mode === 'get-denied') denied(); return legacy; },
    removeItem(key) { calls.push(['remove', key]); if (mode === 'remove-denied') denied(); legacy = null; },
  };
  const bindings = { document };
  if (mode === 'property-denied') Object.defineProperty(bindings, 'localStorage', { get: denied });
  else if (mode !== 'absent') bindings.localStorage = storage;
  const script = source.replace(/export\s*\{[^}]+\};/g, '');
  const core = vm.runInNewContext(script + '\n;({ app, applyTheme, toggleTheme, updateChrome });', bindings, { filename: 'core.js' });
  return { ...core, document, calls };
}

for (const mode of ['property-denied', 'get-denied', 'remove-denied', 'absent', 'legacy', 'empty']) {
  test('fixed dark theme does not block startup or chrome when storage is ' + mode, async () => {
    const h = await themeModule(mode);
    h.app.theme = 'light';
    assert.doesNotThrow(() => h.applyTheme());
    assert.equal(h.app.theme, 'dark');
    assert.equal(h.document.documentElement.dataset.theme, 'dark');
    assert.doesNotThrow(() => h.toggleTheme());
    assert.doesNotThrow(() => h.updateChrome());
    assert.ok(h.calls.every(([, key]) => key === 'mr-theme'), 'only the obsolete theme preference is touched');
    if (mode === 'legacy') assert.equal(h.calls.filter(([operation]) => operation === 'remove').length, 1);
    if (mode === 'empty') assert.equal(h.calls.filter(([operation]) => operation === 'remove').length, 0);
  });
}
