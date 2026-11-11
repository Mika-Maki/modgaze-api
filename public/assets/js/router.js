import { $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "./core.js";
import { renderOverview, renderTrafficChart, updateLiveStats } from "./views/dashboard.js";
import { renderHub, mountHub } from "./views/hub.js";
import { cleanupOrbit } from "./orbit.js";
import { standDownCrt } from "./crt.js";
import { loadTokenUsage, loadTokenBackups } from "./data.js";
import { renderGroupsPage, filterGroups } from "./views/groups.js";
import { renderGroupDetailPage } from "./views/group-detail.js";
import { renderKeysPage, filterKeys } from "./views/keys.js";
import { renderSystemPage } from "./views/system.js";
/* ---------------- routing / render ---------------- */
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '').trim();
  if (!raw) return { name: 'overview' };
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'groups') {
    if (parts.length === 1) return { name: 'groups' };
    return { name: 'group', id: decodeURIComponent(parts[1]), tab: parts[2] || 'overview' };
  }
  if (parts[0] === 'keys') return { name: 'keys' };
  if (parts[0] === 'system') return { name: 'system', tab: parts[1] || 'general' };
  return { name: 'overview' };
}
function navigate(hash) {
  if (location.hash === hash) { app.route = parseRoute(); render(); }
  else location.hash = hash;
}
function navigateFromHub(hash) {
  if (!hash || (location.hash === hash && app.route.name === 'overview')) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { navigate(hash); return; }
  const stage = $('#hub-stage');
  if (!stage) { navigate(hash); return; }
  if (stage.classList.contains('is-departing')) return;
  stage.classList.add('is-departing');
  document.body.dataset.transition = 'leaving';
  window.setTimeout(function () { navigate(hash); }, 380);
}
function setShell(routeName) {
  const hub = routeName === 'overview' || routeName === 'loading';
  document.body.dataset.route = routeName === 'overview' ? 'hub' : routeName === 'loading' ? 'loading' : 'console';
  const view = $('#view');
  if (view) view.className = 'view ' + (hub ? 'view--hub' : 'view--console');
  const titles = {
    overview: 'Modgaze · 控制中枢', loading: 'Modgaze · 正在连接',
    groups: 'Modgaze · 上游分组', group: 'Modgaze · 分组详情',
    keys: 'Modgaze · 本地密钥', system: 'Modgaze · 系统与维护',
  };
  document.title = titles[routeName] || 'Modgaze · 控制中枢';
}
function render() {
  app.viewSequence = (app.viewSequence || 0) + 1;
  updateChrome();
  setShell(app.route.name);
  delete document.body.dataset.transition;
  const view = $('#view');
  if (!app.data) { view.innerHTML = ''; return; }
  let html = '';
  switch (app.route.name) {
    case 'groups': html = renderGroupsPage(); break;
    case 'group': html = renderGroupDetailPage(); break;
    case 'keys': html = renderKeysPage(); break;
    case 'system': html = renderSystemPage(); break;
    case 'overview': html = renderHub(); break;
    default: html = renderHub();
  }
  view.innerHTML = html;
  if (app.route.name === 'overview') { mountHub(); void loadTokenUsage(); }
  else { cleanupOrbit(); standDownCrt(); }
  if (app.route.name === 'system' && app.route.tab === 'backups') void loadTokenBackups();
  applyKeyReveals();
  filterGroups();
  filterKeys();
  updateLiveStats();
  if (app.route.name === 'overview') setTimeout(() => renderTrafficChart(), 0);
}
function renderLoading() {
  setShell('loading');
  const view = $('#view');
  if (!view) return;
  view.innerHTML = `
    <div class="hub-loading" aria-label="正在建立控制台几何">
      <div class="hub-loading-signal" aria-hidden="true"><i></i></div>
      <div class="hub-loading-readout" aria-hidden="true">
        <span><em>MODGAZE</em><b>INIT</b></span>
        <span><em>DISPLAY BUFFER</em><b>OK</b></span>
        <span><em>CORE GEOMETRY</em><b>INIT</b></span>
      </div>
    </div>`;
}
function renderFatal(error) {
  standDownCrt();
  setShell('console');
  const view = $('#view');
  if (!view) return;
  view.innerHTML = `
    <div class="card card-pad" style="margin-top:40px">
      <div class="empty-state">
        <div class="empty-icon">${icon('alert')}</div>
        <b>无法加载控制台数据</b>
        <p>${esc(error.message || '配置或服务出现异常。详细原因请查看服务端日志。')}</p>
        <button class="btn btn-primary" data-action="refresh">${icon('refresh')} 重新加载</button>
      </div>
    </div>`;
}
function showOffline(message) {
  app.offline = true;
  const banner = $('#offline-banner');
  if (banner) { banner.classList.remove('hidden'); $('#offline-text').textContent = message; }
  updateChrome();
}
function hideOffline() {
  app.offline = false;
  $('#offline-banner')?.classList.add('hidden');
}

export { parseRoute, navigate, navigateFromHub, render, renderLoading, renderFatal, showOffline, hideOffline };
