import { $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "./core.js";
import { render, renderLoading, renderFatal, showOffline, hideOffline } from "./router.js";
import { updateLiveStats } from "./views/dashboard.js";
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
function startPolling() {
  stopPolling();
  app.polling = setInterval(pollStats, 4000);
}
function stopPolling() {
  if (app.polling) clearInterval(app.polling);
  app.polling = null;
}
async function pollStats() {
  if (!app.authenticated || document.hidden || app.pollStatsInFlight) return;
  if (Date.now() < Math.max(app.pollStatsRetryAt, app.adminRetryAt)) return;
  app.pollStatsInFlight = true;
  const session = app.csrf;
  try {
    const payload = await api('/api/stats');
    if (session !== app.csrf || !app.authenticated) return;
    app.stats = payload.stats;
    app.lastTick = Date.now();
    app.pollStatsRetryAt = 0;
    app.offline = false;
    hideOffline();
    if (!app.modal && app.data && payload.configRevision !== undefined && payload.configRevision !== app.data.configRevision) {
      await loadState({ silent: true });
    }
    updateLiveStats();
    updateChrome();
  } catch (error) {
    if (session !== app.csrf || !app.authenticated) return;
    if (error.status === 429) {
      const delay = Number.isFinite(error.retryAfter) ? Math.max(1, error.retryAfter) * 1000 : 4000;
      app.pollStatsRetryAt = Date.now() + delay;
    }
    if (error.network) showOffline('管理服务连接中断，正在自动重试…');
  } finally {
    app.pollStatsInFlight = false;
  }
}

export { loadState, startPolling, stopPolling, pollStats };
