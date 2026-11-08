/* Modgaze Control Plane — local admin UI */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const icon = (name, extra = '') => '<svg class="icon ' + extra + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const PROTOCOLS = ['chat', 'responses', 'messages'];
const PROTOCOL_LABEL = { chat: 'Chat', responses: 'Responses', messages: 'Messages' };
const PROTOCOL_AUTH = { chat: 'bearer', responses: 'bearer', messages: 'x-api-key' };
const AUDIT_LABELS = {
  'auth.login': '管理员登录', 'auth.logout': '退出登录', 'auth.login_failed': '登录失败',
  'auth.setup': '设置管理员密码', 'auth.password_change': '管理员密码变更',
  'group.create': '创建分组', 'group.update': '更新分组', 'group.delete': '删除分组', 'group.clone': '克隆分组', 'group.test': '测试上游',
  'route.update': '更新路由', 'route.delete': '删除路由',
  'model.create': '添加模型', 'model.update': '更新模型', 'model.delete': '删除模型', 'model.bulk': '批量添加模型',
  'model.route.update': '更新模型路由', 'model.route.delete': '删除模型路由',
  'key.create': '创建密钥', 'key.update': '更新密钥', 'key.delete': '删除密钥', 'key.rotate': '轮换密钥',
  'settings.update': '更新设置', 'config.import': '导入配置', 'config.reload': '重载配置',
  'backup.create': '创建备份', 'backup.restore': '恢复备份', 'backup.delete': '删除备份',
  'service.restart': '重启服务', 'stats.reset': '重置统计',
};
const app = {
  data: null,
  stats: null,
  csrf: null,
  auth: null,
  authenticated: false,
  route: { name: 'overview' },
  loading: true,
  offline: false,
  polling: null,
  pollStatsInFlight: false,
  pollStatsRetryAt: 0,
  adminRetryAt: 0,
  lastTick: 0,
  search: '',
  keySearch: '',
  protocolFilter: 'all',
  reveals: new Set(),
  modal: null,
  modalSecret: null,
  commandItems: [],
  commandIndex: 0,
  theme: 'dark',
  pendingImport: null,
};

/* ---------------- helpers ---------------- */
const nf = new Intl.NumberFormat('zh-CN');
const fmtNum = value => nf.format(Number(value) || 0);
const fmtMs = value => {
  const ms = Number(value) || 0;
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
};
const fmtBytes = value => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
};
const fmtPercent = value => ((Number(value) || 0) * 100).toFixed(1) + '%';
const fmtDuration = ms => {
  let seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  if (days) return days + ' 天 ' + hours + ' 小时';
  if (hours) return hours + ' 小时 ' + minutes + ' 分';
  if (minutes) return minutes + ' 分 ' + (seconds % 60) + ' 秒';
  return seconds + ' 秒';
};
const fmtTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const timeAgo = value => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return seconds + ' 秒前';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
  return Math.floor(seconds / 86400) + ' 天前';
};
const statusClass = status => {
  const code = Number(status) || 0;
  if (code >= 200 && code < 300) return 's-2xx';
  if (code >= 300 && code < 400) return 's-3xx';
  if (code >= 400 && code < 500) return 's-4xx';
  if (code >= 500) return 's-5xx';
  return 's-0';
};
const protoBadge = protocol => '<span class="proto proto-' + esc(protocol) + '">' + esc(PROTOCOL_LABEL[protocol] || protocol) + '</span>';
const protoBadges = list => (list || []).map(protoBadge).join('');
const groupAccent = id => {
  let hash = 0;
  for (const character of String(id)) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  // Keep generated group accents inside the ember / blood / brass family.
  const hue = 6 + (hash % 46);
  const saturation = 56 + (hash % 18);
  const lightness = 58 + ((hash >> 3) % 10);
  return 'hsl(' + hue + ' ' + saturation + '% ' + lightness + '%)';
};
const routerBase = () => {
  const port = app.data?.runtime?.routerPort ?? app.data?.settings?.port ?? 8787;
  return 'http://127.0.0.1:' + port;
};
const routerV1 = () => routerBase() + '/v1';
const findGroup = id => (app.data?.groups || []).find(group => group.id === id);
const findKey = id => {
  for (const group of app.data?.groups || []) {
    for (const [source, list] of [['virtual', group.virtualKeys || []], ['api', group.apiKeys || []]]) {
      const key = list.find(item => item.id === id);
      if (key) return { ...key, source, group };
    }
  }
  return null;
};
const groupRequestStats = id => app.stats?.byGroup?.[id] || { requests: 0, errors: 0 };
const summary = () => app.data?.summary || {};
const settings = () => app.data?.settings || {};
const runtime = () => app.data?.runtime || {};

/* ---------------- rate-limit controls ---------------- */
const ADMIN_RATE_LIMIT_DEFAULTS = Object.freeze({
  maxConcurrent: 64, rpm: 600, perIpMaxConcurrent: 32, perIpRpm: 300,
  loginMaxConcurrent: 2, loginRpm: 10,
});
const formatRateLimit = value => Number(value ?? 0) === 0 ? '无上限' : fmtNum(value);
function rateLimitField(name, label, value = 0, prefix = 'limit') {
  const id = prefix + '-' + name;
  return '<div class="field"><label for="' + esc(id) + '">' + esc(label) + '</label>' +
    '<input class="input" id="' + esc(id) + '" name="' + esc(name) + '" type="number" min="0" max="100000" step="1" value="' + esc(value) + '" list="' + esc(id) + '-options" required>' +
    '<datalist id="' + esc(id) + '-options"><option value="0" label="无上限">无上限</option></datalist>' +
    '<span class="field-hint">0 = 无上限；可手动输入或选择无上限，最大 100000。</span></div>';
}
function groupRateLimitFields(limits = {}, prefix = 'group-limits') {
  return rateLimitField('rateMaxConcurrent', '分组最大并发', limits.maxConcurrent ?? 0, prefix) +
    rateLimitField('rateRpm', '分组 RPM（每 60 秒）', limits.rpm ?? 0, prefix);
}

/* ---------------- API ---------------- */
function retryAfterSeconds(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds : null;
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(text)) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, (timestamp - Date.now()) / 1000) : null;
}
async function api(path, { method = 'GET', body, csrf = true } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET' && app.csrf) headers['x-csrf-token'] = app.csrf;
  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  } catch (error) {
    const networkError = new Error('无法连接本地管理服务');
    networkError.network = true;
    throw networkError;
  }
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(payload?.error?.message || '请求失败（HTTP ' + response.status + '）');
    error.status = response.status;
    error.code = payload?.error?.code;
    error.detail = payload?.error?.detail;
    error.payload = payload;
    // Surface the server delay in seconds, without replaying any request (especially writes).
    error.retryAfter = retryAfterSeconds(response.headers?.get('retry-after'));
    if (response.status === 429) {
      const seconds = error.retryAfter ?? 4;
      app.adminRetryAt = Math.max(app.adminRetryAt, Date.now() + Math.max(1, seconds) * 1000);
    }
    if (response.status === 401 && app.authenticated && unauthorizedHandler && !path.startsWith('/api/auth/')) unauthorizedHandler();
    throw error;
  }
  return payload;
}

/* ---------------- theme / chrome ---------------- */
function applyTheme() {
  // Modgaze has one visual state: the abyss. Dark mode is not a preference.
  app.theme = 'dark';
  document.documentElement.dataset.theme = 'dark';
  if (localStorage.getItem('mr-theme') !== null) localStorage.removeItem('mr-theme');
}
function toggleTheme() {
  applyTheme();
}

function updateChrome() {
  const data = app.data;
  const route = app.route;
  const active = route.name === 'group' ? 'groups' : route.name;
  $$('[data-nav]').forEach(item => item.classList.toggle('active', item.dataset.nav === active));
  const crumbs = $('#crumbs');
  if (crumbs) {
    const parts = [];
    if (route.name === 'overview') parts.push('<span class="current">控制中枢</span>');
    else if (route.name === 'groups') parts.push('<span class="current">上游分组</span>');
    else if (route.name === 'group') {
      parts.push('<a class="crumb-link" href="#/groups">上游分组</a><span class="sep">/</span>');
      parts.push('<span class="current">' + esc(findGroup(route.id)?.name || route.id || '分组') + '</span>');
    } else if (route.name === 'keys') parts.push('<span class="current">本地密钥</span>');
    else if (route.name === 'system') {
      const systemTab = route.tab || 'general';
      const label = { general: '系统设置', backups: '备份与恢复', config: '配置导入导出', audit: '审计日志' }[systemTab] || '系统与维护';
      parts.push('<a class="crumb-link" href="#/system/general">系统与维护</a><span class="sep">/</span><span class="current">' + label + '</span>');
    }
    crumbs.innerHTML = parts.length ? parts.join('') : '<span>概览</span>';
  }
  const live = $('#live-pill');
  if (live) {
    const healthy = Boolean(data?.service?.running) && !app.offline;
    live.classList.toggle('bad', !healthy);
    live.querySelector('span').textContent = app.offline ? '重连中' : (healthy ? '在线' : '服务离线');
  }
  const version = $('#sidebar-version');
  if (version) version.textContent = 'v' + (data?.version || '1.0.0');
  $$('[data-app-version]').forEach(function (node) { node.textContent = 'v' + (data?.version || '1.0.0'); });
  const endpoint = $('#endpoint-chip .endpoint-text');
  if (endpoint) endpoint.textContent = '127.0.0.1:' + (data?.runtime?.routerPort ?? data?.settings?.port ?? 8787);
  applyTheme(app.theme);
}

let unauthorizedHandler = null;
function setUnauthorizedHandler(handler) { unauthorizedHandler = handler; }
/* ---------------- shared empty state ---------------- */
function emptyState(title, description, iconName, actionLabel, action, data) {
  let attrs = '';
  if (data) Object.keys(data).forEach(function (key) { attrs += ' data-' + key + '="' + esc(data[key]) + '"'; });
  const button = actionLabel && action ? '<button class="btn btn-sm" data-action="' + esc(action) + '"' + attrs + '>' + icon('plus') + ' ' + esc(actionLabel) + '</button>' : '';
  return '<div class="empty-state"><div class="empty-icon">' + icon(iconName || 'spark') + '</div><b>' + esc(title) + '</b><p>' + esc(description || '') + '</p>' + button + '</div>';
}

/* ---------------- toast / modal ---------------- */
function toast(message, type = 'success', detail = '') {
  const root = $('#toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = 'toast ' + type;
  const iconName = type === 'error' ? 'alert' : type === 'info' ? 'spark' : 'check';
  node.innerHTML = '<span class="toast-icon">' + icon(iconName) + '</span><div class="toast-copy"><b>' + esc(message) + '</b>' + (detail ? '<span>' + esc(detail) + '</span>' : '') + '</div><button class="toast-close" data-action="dismiss-toast" aria-label="关闭">' + icon('close') + '</button>';
  root.appendChild(node);
  setTimeout(function () { dismissToast(node); }, type === 'error' ? 6500 : 3800);
  return node;
}
function dismissToast(node) {
  if (!node || node.classList.contains('out')) return;
  node.classList.add('out');
  setTimeout(function () { node.remove(); }, 260);
}

function openModal(options) {
  closeModal();
  const root = $('#modal-root');
  const size = options.size ? ' ' + options.size : '';
  const head = options.bare ? '' : '<div class="modal-head"><div>' + (options.showIcon === false ? '' : '<div class="modal-icon ' + (options.danger ? 'danger' : '') + '">' + icon(options.icon || 'spark') + '</div>') + '<h2 class="modal-title" id="modal-title">' + esc(options.title || '') + '</h2>' + (options.subtitle ? '<p class="modal-sub">' + esc(options.subtitle) + '</p>' : '') + '</div><button class="icon-btn modal-close" data-action="close-modal" aria-label="关闭">' + icon('close') + '</button></div>';
  const labelled = options.bare ? '' : ' aria-labelledby="modal-title"';
  root.innerHTML = '<div class="modal-backdrop" data-action="close-modal"></div><div class="modal' + size + '" role="dialog" aria-modal="true"' + labelled + '>' + head +
    '<div class="modal-body' + (options.bare ? ' modal-body-bare' : '') + '">' + (options.body || '') + '</div>' + (options.footer ? '<div class="modal-foot">' + options.footer + '</div>' : '') + '</div>';
  root.classList.add('open');
  document.body.classList.add('modal-open');
  app.modal = { onClose: options.onClose || null };
  const modal = root.querySelector('.modal');
  if (options.onMount) options.onMount(modal);
  setTimeout(function () {
    const target = modal.querySelector('[autofocus], input:not([type=hidden]), select, textarea, button');
    if (target) target.focus();
  }, 30);
}
function closeModal() {
  const root = $('#modal-root');
  if (!root) return;
  const current = app.modal;
  app.modal = null;
  app.modalSecret = null;
  root.classList.remove('open');
  root.innerHTML = '';
  document.body.classList.remove('modal-open');
  if (current && current.onClose) current.onClose();
}

function confirmModal(options) {
  return new Promise(function (resolve) {
    let settled = false;
    const finish = function (value) {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    const requireText = options.requireText || null;
    const body = '<form id="confirm-form"><div class="danger-copy" style="font-size:13px;line-height:1.7">' + options.message + '</div>' +
      (requireText ? '<div class="field mt-3"><label>输入 <code class="mono">' + esc(requireText) + '</code> 以确认</label><input class="input" id="confirm-text" autocomplete="off" placeholder="' + esc(requireText) + '"></div>' : '') +
      '<div class="form-error mt-3" role="alert"></div></form>';
    const footer = '<button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn ' + (options.danger ? 'btn-danger' : 'btn-primary') + '" type="submit" form="confirm-form">' + esc(options.confirmLabel || '确认') + '</button>';
    openModal({
      title: options.title, subtitle: options.subtitle || '', body: body, footer: footer, size: 'narrow', icon: options.danger ? 'alert' : 'shield', danger: options.danger,
      onClose: function () { if (!settled) { settled = true; resolve(false); } },
    });
    const form = $('#confirm-form');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (requireText) {
        const value = $('#confirm-text').value.trim();
        if (value !== requireText) {
          const error = form.querySelector('.form-error');
          error.textContent = '确认文本不匹配';
          error.classList.add('show');
          return;
        }
      }
      finish(true);
    });
    setTimeout(function () { $('#confirm-text')?.focus(); }, 40);
  });
}

/* ---------------- test result / copy ---------------- */
function showTestResult(containerId, result) {
  const target = $('#' + containerId);
  if (!target) return;
  const ok = Boolean(result?.ok);
  const models = Array.isArray(result?.models) ? result.models : null;
  target.classList.remove('empty');
  target.innerHTML = '<div class="test-result-head"><b>' + (ok ? '连接成功' : '请求失败') + '</b><span class="badge ' + (ok ? 'badge-green' : 'badge-red') + '"><i class="dot ' + (ok ? 'dot-green' : 'dot-red') + '"></i>' + esc(result?.status || 'ERR') + '</span></div>' +
    '<div class="test-metrics"><span>耗时 <b>' + fmtMs(result?.latencyMs) + '</b></span>' + (result?.endpoint ? '<span>端点 <b>' + esc(result.endpoint) + '</b></span>' : '') + (result?.protocol ? '<span>协议 <b>' + esc(PROTOCOL_LABEL[result.protocol] || result.protocol) + '</b></span>' : '') + '</div>' +
    (models ? '<div class="chip-row mt-2">' + models.map(function (model) { return '<span class="badge badge-cyan">' + esc(model) + '</span>'; }).join('') + '</div>' : '') +
    '<pre>' + esc(result?.snippet || result?.error || '') + '</pre>';
}
function setTestLoading(containerId, label) {
  const target = $('#' + containerId);
  if (!target) return;
  target.classList.add('empty');
  target.innerHTML = '<div class="flex items-center gap-2">' + icon('refresh') + '<span>' + esc(label || '正在测试…') + '</span></div>';
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      return true;
    } catch { return false; }
  }
}
async function copyEndpoint() {
  const ok = await copyToClipboard(routerV1());
  toast(ok ? '已复制本地 Base URL' : '复制失败，请手动复制', ok ? 'success' : 'error', routerV1());
}
function downloadText(filename, text, type) {
  const blob = new Blob([text], { type: type || 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
function applyKeyReveals() {
  for (const keyId of app.reveals) {
    const key = findKey(keyId);
    const code = document.querySelector('[data-key-text="' + keyId + '"]');
    if (!key || !key.value || !code) { app.reveals.delete(keyId); continue; }
    code.textContent = key.value;
    code.classList.add('revealed');
    const button = document.querySelector('[data-action="reveal-key"][data-key-id="' + keyId + '"]');
    if (button) button.innerHTML = icon('eye-off');
  }
}


export { ADMIN_RATE_LIMIT_DEFAULTS, formatRateLimit, rateLimitField, groupRateLimitFields, retryAfterSeconds, $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals };
