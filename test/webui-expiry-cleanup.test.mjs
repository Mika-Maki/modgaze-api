import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('stats revision reloads deleted keys into WebUI without overwriting an open modal', async () => {
  const source = await readFile(new URL('../public/assets/js/data.js', import.meta.url), 'utf8');
  const app = { authenticated: true, data: { configRevision: 0, groups: [{ virtualKeys: ['synthetic'] }] }, modal: null, pollStatsInFlight: false, pollStatsRetryAt: 0, adminRetryAt: 0 };
  let stateReads = 0, renders = 0;
  const { pollStats } = vm.runInNewContext(source.replace(/^import.*$/gm, '').replace(/export \{[^}]*\};/g, '') + '\n;({pollStats});', {
    app, document: { hidden: false }, setInterval, clearInterval,
    api: async path => path === '/api/stats' ? { configRevision: 1, stats: {} } : (stateReads++, { configRevision: 1, groups: [{ virtualKeys: [] }], stats: {} }),
    render: () => renders++, hideOffline() {}, updateLiveStats() {}, updateChrome() {},
    renderLoading() {}, showOffline() {}, renderFatal() {},
  });
  app.modal = {};
  await pollStats();
  assert.equal(stateReads, 0);
  assert.equal(app.data.groups[0].virtualKeys.length, 1);
  app.modal = null;
  await pollStats();
  assert.equal(stateReads, 1);
  assert.equal(renders, 1);
  assert.equal(app.data.groups[0].virtualKeys.length, 0);
  await pollStats();
  assert.equal(stateReads, 1);
});
