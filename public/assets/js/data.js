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
    render();
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
  if (!app.authenticated || document.hidden) return;
  try {
    const payload = await api('/api/stats');
    app.stats = payload.stats;
    app.lastTick = Date.now();
    app.offline = false;
    hideOffline();
    updateLiveStats();
    updateChrome();
  } catch (error) {
    if (error.network) showOffline('管理服务连接中断，正在自动重试…');
  }
}

export { loadState, startPolling, stopPolling, pollStats };
