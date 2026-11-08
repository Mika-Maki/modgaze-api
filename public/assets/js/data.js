import { $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "./core.js";
import { render, renderLoading, renderFatal, showOffline, hideOffline } from "./router.js";
import { updateLiveStats } from "./views/dashboard.js";
async function loadState({ silent = false } = {}) {
  if (!app.data && !silent) renderLoading();
  try {
    const data = await api('/api/state');
    app.data = data;
    app.stats = data.stats;
    app.loading = false;
    app.offline = false;
    hideOffline();
    updateChrome();
    // Silent refreshes must not discard an audit settings draft, including edits
    // made while /api/state was in flight. A successful save uses non-silent load.
    const auditForm = silent && app.route?.name === 'system' && app.route.tab === 'audit'
      ? $('form[data-form="settings-audit"]') : null;
    const dirty = auditForm && Array.from(auditForm.elements).some(input => {
      if (input.type === 'checkbox') return input.checked !== input.defaultChecked;
      if (input.tagName === 'SELECT') return Array.from(input.options).some(option => option.selected !== option.defaultSelected);
      return input.defaultValue !== undefined && input.value !== input.defaultValue;
    });
    const focused = dirty && auditForm.contains(document.activeElement) ? document.activeElement : null;
    render();
    if (dirty) {
      $('form[data-form="settings-audit"]')?.replaceWith(auditForm);
      focused?.focus({ preventScroll: true });
    }
  } catch (error) {
    if (error.network) {
      showOffline('无法连接管理服务，正在重试…');
      if (!app.data) renderFatal(error);
      return;
    }
    if (error.status === 401) return;
    renderFatal(error);
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
  try {
    const payload = await api('/api/stats');
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
