import { $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "./core.js";
import { render, renderLoading, renderFatal, showOffline, hideOffline } from "./router.js";
import { updateLiveStats, updateTokenUsage } from "./views/dashboard.js";
import { updateTokenBackups } from './views/system.js';
let stateRequestSequence = 0;
function formIdentity(form) {
  return JSON.stringify(Object.keys(form.dataset).sort().map(key => [key, form.dataset[key]]));
}
function formIsDirty(form) {
  return Array.from(form.elements).some(input => {
    if (input.type === 'checkbox' || input.type === 'radio') return input.checked !== input.defaultChecked;
    if (input.tagName === 'SELECT') return Array.from(input.options).some(option => option.selected !== option.defaultSelected);
    return input.defaultValue !== undefined && input.value !== input.defaultValue;
  });
}
async function loadState({ silent = false, renderPage = true } = {}) {
  const requestSequence = ++stateRequestSequence;
  const session = app.csrf;
  const superseded = () => requestSequence !== stateRequestSequence || session !== app.csrf;
  const initialLoad = !app.data;
  if (initialLoad && !silent) renderLoading();
  try {
    let data;
    try { data = await api('/api/state'); }
    catch (error) {
      // Recover once from a transient invalid startup response. Keep retries
      // local to this read; writes and HTTP/network errors are never replayed.
      if (superseded()) return false;
      if (!initialLoad || app.data || !app.authenticated || error.code !== 'invalid_response') throw error;
      if (Date.now() < Math.max(app.adminRetryAt, app.pollStatsRetryAt)) throw error;
      data = await api('/api/state');
    }
    // A refresh started after a mutation owns the view. An older poll must not
    // put a deleted/renamed group back or remove a newly cloned group.
    if (superseded()) return false;
    app.data = data;
    app.stats = data.stats;
    app.loading = false;
    app.offline = false;
    hideOffline();
    updateChrome();
    if (!renderPage) return true;
    // Capture the currently displayed drafts after the request, so edits and
    // navigation while it was in flight are respected. Match both form kind
    // and target; a removed group must not inherit another group's draft.
    const drafts = silent ? $$('#view form[data-form]').filter(formIsDirty) : [];
    const focused = drafts.some(form => form.contains(document.activeElement)) ? document.activeElement : null;
    render();
    const replacements = new Map($$('#view form[data-form]').map(form => [formIdentity(form), form]));
    for (const draft of drafts) {
      const replacement = replacements.get(formIdentity(draft));
      if (!replacement) continue;
      replacement.replaceWith(draft);
      if (focused && draft.contains(focused)) focused.focus({ preventScroll: true });
    }
    return true;
  } catch (error) {
    if (superseded()) return false;
    if (error.network) {
      showOffline('无法连接管理服务，正在重试…');
      if (!app.data) renderFatal(error);
      return false;
    }
    if (error.status === 401) return false;
    if (app.data) toast('数据刷新失败，暂时保留上次加载的数据', 'error', error.message);
    else renderFatal(error);
    return false;
  }
}
let pollingGeneration = 0;
let pollingActive = false;
let pollingDelay = 4000;
let pollingFlight = null;
let visibilityBound = false;
function clearPollTimer() {
  if (app.polling != null) clearTimeout(app.polling);
  app.polling = null;
}
function schedulePoll(delay = pollingDelay) {
  clearPollTimer();
  if (!pollingActive || !app.authenticated || document.hidden || pollingFlight) return;
  const retryAt = Math.max(app.pollStatsRetryAt || 0, app.adminRetryAt || 0);
  app.polling = setTimeout(() => { app.polling = null; void pollStats(); }, Math.max(delay, retryAt - Date.now()));
}
function handlePollingVisibility() {
  if (document.body?.dataset) document.body.dataset.pageHidden = String(document.hidden);
  if (document.hidden) { clearPollTimer(); return; }
  if (pollingActive && app.authenticated) void pollStats();
}
function startPolling() {
  stopPolling();
  pollingActive = true;
  pollingDelay = 4000;
  app.tokenUsage = null;
  app.tokenUsageSession = app.csrf;
  app.tokenUsageError = '';
  if (!visibilityBound && document.addEventListener) {
    document.addEventListener('visibilitychange', handlePollingVisibility);
    visibilityBound = true;
  }
  if (document.body?.dataset) document.body.dataset.pageHidden = String(document.hidden);
  schedulePoll();
}
function stopPolling() {
  pollingActive = false;
  pollingGeneration += 1;
  clearPollTimer();
  pollingFlight = null;
  app.pollStatsInFlight = false;
  app.tokenUsage = null;
  app.tokenUsageSession = null;
  app.tokenUsageLoading = false;
  app.tokenUsageError = '';
}
async function pollStats() {
  clearPollTimer();
  if (!app.authenticated || document.hidden || pollingFlight) return;
  if (Date.now() < Math.max(app.pollStatsRetryAt || 0, app.adminRetryAt || 0)) { schedulePoll(0); return; }
  const flight = { session: app.csrf, generation: pollingGeneration };
  pollingFlight = flight;
  app.pollStatsInFlight = true;
  const current = () => pollingFlight === flight && flight.session === app.csrf && flight.generation === pollingGeneration && app.authenticated;
  try {
    const payload = await api('/api/stats');
    if (!current()) return;
    const changed = payload.stats?.requests !== app.stats?.requests;
    pollingDelay = changed ? 4000 : Math.min(30000, pollingDelay * 2);
    app.stats = payload.stats;
    app.lastTick = Date.now();
    app.pollStatsRetryAt = 0;
    app.offline = false;
    hideOffline();
    if (!app.modal && app.data && payload.configRevision !== undefined && payload.configRevision !== app.data.configRevision) {
      await loadState({ silent: true });
    }
    if (!current()) return;
    updateLiveStats();
    updateChrome();
  } catch (error) {
    if (!current()) return;
    if (error.status === 429) {
      const delay = Number.isFinite(error.retryAfter) ? Math.max(1, error.retryAfter) * 1000 : 4000;
      app.pollStatsRetryAt = Date.now() + delay;
    }
    if (error.network) showOffline('管理服务连接中断，正在自动重试…');
  } finally {
    if (pollingFlight === flight) {
      pollingFlight = null;
      app.pollStatsInFlight = false;
      schedulePoll();
    }
  }
}

let tokenUsageSequence = 0;
async function loadTokenUsage() {
  if (!app.authenticated || app.route.name !== 'overview') return false;
  const sequence = ++tokenUsageSequence;
  const session = app.csrf;
  const viewSequence = app.viewSequence;
  const current = () => sequence === tokenUsageSequence && session === app.csrf && app.authenticated && app.route.name === 'overview' && viewSequence === app.viewSequence;
  if (app.tokenUsageSession !== session) app.tokenUsage = null;
  app.tokenUsageSession = session;
  app.tokenUsageLoading = true;
  app.tokenUsageError = '';
  updateTokenUsage();
  try {
    const payload = await api('/api/token-usage');
    if (!current()) return false;
    const usage = payload.usage;
    const fields = ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens', 'requests'];
    if (!usage || typeof usage.day !== 'string' || typeof usage.timeZone !== 'string' || !['today', 'total'].every(period => fields.every(field => Number.isSafeInteger(usage[period]?.[field]) && usage[period][field] >= 0))) throw new Error('Token 用量数据无效');
    app.tokenUsage = usage;
    return true;
  } catch (error) {
    if (!current()) return false;
    app.tokenUsageError = error.message || '暂时无法加载 Token 用量';
    return false;
  } finally {
    if (current()) { app.tokenUsageLoading = false; updateTokenUsage(); }
  }
}

let tokenBackupsSequence = 0;
async function loadTokenBackups() {
  if (!app.authenticated || app.route.name !== 'system' || app.route.tab !== 'backups') return false;
  const sequence = ++tokenBackupsSequence, session = app.csrf, viewSequence = app.viewSequence;
  const current = () => sequence === tokenBackupsSequence && session === app.csrf && app.authenticated && app.route.name === 'system' && app.route.tab === 'backups' && viewSequence === app.viewSequence;
  if (app.tokenBackupsSession !== session) app.tokenBackups = null;
  app.tokenBackupsSession = session;
  app.tokenBackupsLoading = true; app.tokenBackupsError = ''; updateTokenBackups();
  try {
    const payload = await api('/api/token-backups');
    if (!current()) return false;
    if (!Array.isArray(payload.backups) || !payload.backups.every(backup => typeof backup.name === 'string' && Number.isFinite(backup.size) && backup.size >= 0 && Number.isFinite(backup.mtimeMs))) throw new Error('账本备份列表无效');
    app.tokenBackups = payload.backups;
    return true;
  } catch (error) {
    if (!current()) return false;
    app.tokenBackupsError = '账本备份加载失败：' + (error.message || '请稍后刷新');
    return false;
  } finally { if (current()) { app.tokenBackupsLoading = false; updateTokenBackups(); } }
}
async function createTokenBackup() {
  if (!app.authenticated || app.tokenBackupCreating || app.route.name !== 'system' || app.route.tab !== 'backups') return false;
  const session = app.csrf, viewSequence = app.viewSequence;
  const current = () => session === app.csrf && app.authenticated && app.route.name === 'system' && app.route.tab === 'backups' && viewSequence === app.viewSequence;
  app.tokenBackupCreating = true; app.tokenBackupsError = ''; updateTokenBackups();
  try {
    await api('/api/token-backups', { method: 'POST', body: {} });
    if (!current()) return false;
    toast('Token 账本备份已创建', 'success');
    return await loadTokenBackups();
  } catch (error) {
    if (current()) app.tokenBackupsError = '账本备份创建失败：' + (error.message || '请稍后重试');
    return false;
  } finally { app.tokenBackupCreating = false; if (current()) updateTokenBackups(); }
}

export { loadState, startPolling, stopPolling, pollStats, loadTokenUsage, loadTokenBackups, createTokenBackup };
