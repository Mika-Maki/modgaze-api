import { $, $$, app, applyTheme, setUnauthorizedHandler, closeModal, toast } from './js/core.js';
import { bootAuth, sessionExpired } from './js/auth.js';
import { parseRoute, render } from './js/router.js';
import { pollStats } from './js/data.js';
import { handleClick } from './js/actions.js';
import { handleSubmit } from './js/forms.js';
import { openCommandPalette } from './js/dialogs.js';
import { initEye } from './js/eye.js';
import { filterGroups } from './js/views/groups.js';
import { filterKeys } from './js/views/keys.js';

function updatePasswordStrength(input) {
  const meter = $('#strength-meter');
  const label = $('#strength-label');
  if (!meter || !label) return;
  const value = String(input.value || '');
  let score = 0;
  if (value.length >= 10) score += 1;
  if (value.length >= 16) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value)) score += 1;
  meter.className = 'strength ' + (score ? 's' + score : '');
  label.textContent = !value ? '使用长密码或三组以上随机词。' : score <= 1 ? '强度偏弱：至少 10 位，建议混合大小写、数字与符号。' : score === 2 ? '强度一般：继续增加长度或混合字符。' : score === 3 ? '强度良好：可以再长一点。' : '强度很好。';
}

function handleInput(event) {
  const target = event.target;
  if (target.matches('[data-filter="group-search"]')) {
    app.search = target.value;
    filterGroups();
    return;
  }
  if (target.matches('[data-filter="key-search"]')) {
    app.keySearch = target.value;
    filterKeys();
    return;
  }
  if (target.id === 'auth-password') updatePasswordStrength(target);
}

function handleChange(event) {
  const target = event.target;
  if (!target.matches('[data-file="config"]')) return;
  const file = target.files && target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('文件超过 8 MiB 限制', 'error'); return; }
  file.text().then(function (text) {
    const area = $('#config-import');
    if (area) area.value = text;
    toast('已读取配置文件', 'info', file.name);
  }).catch(function () { toast('无法读取文件', 'error'); });
}

function trapFocus(event) {
  if (event.key !== 'Tab' || !app.modal) return;
  const modal = document.querySelector('#modal-root .modal');
  if (!modal) return;
  const focusable = Array.from(modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(function (element) { return element.offsetParent !== null; });
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function handleKeydown(event) {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === 'k') {
    if (!app.authenticated) return;
    event.preventDefault();
    openCommandPalette();
    return;
  }
  if (event.key === 'Escape' && app.modal) { event.preventDefault(); closeModal(); return; }
  if (event.key === 'Tab') { trapFocus(event); return; }
  if (event.key === '/' && !app.modal && app.authenticated) {
    const tag = String(document.activeElement?.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return;
    const search = document.querySelector('[data-filter="group-search"], [data-filter="key-search"]');
    if (search) { event.preventDefault(); search.focus(); }
  }
}

function handleHashChange() {
  app.route = parseRoute();
  if (app.authenticated && app.data) render();
}

async function init() {
  app.route = parseRoute();
  if (!location.hash) history.replaceState(null, '', '#/overview');
  applyTheme(app.theme);
  initEye();
  setUnauthorizedHandler(sessionExpired);
  document.addEventListener('click', handleClick);
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleChange);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('hashchange', handleHashChange);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && app.authenticated) pollStats();
  });
  await bootAuth();
}

export { init };
