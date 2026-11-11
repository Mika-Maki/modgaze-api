import {
  $, $$, icon, esc, app, api, closeModal, toast, dismissToast, findGroup, findKey,
  confirmModal, openModal, routerV1, copyToClipboard, downloadText, toggleTheme, copyEndpoint,
} from './core.js';
import { loadState } from './data.js';
import { bootAuth, showAuth } from './auth.js';
import { navigate, navigateFromHub, render, showOffline } from './router.js';
import { filterGroups } from './views/groups.js';
import {
  openCommandPalette, openCreateGroupModal, openEditGroupModal, openRouteModal, openModelModal,
  openBulkModelsModal, openVirtualKeyModal, openApiKeyModal, openKeyLabelModal, openCloneModal, openBackupModal, openSecretModal, passwordPrompt,
} from './dialogs.js';

function closeSidebar() {
  $('#sidebar')?.classList.remove('open');
  $('#sidebar-scrim')?.classList.remove('show');
}
function toggleSidebar() {
  $('#sidebar')?.classList.toggle('open');
  $('#sidebar-scrim')?.classList.toggle('show');
}
function report(error) {
  if (!error) return;
  if (error.network) { showOffline('管理服务连接中断，请检查服务状态'); toast('无法连接管理服务', 'error'); return; }
  if (error.status === 401) return;
  toast(error.message || '操作失败', 'error');
}
function parseImportConfig() {
  const textarea = $('#config-import');
  const text = textarea ? textarea.value.trim() : '';
  if (!text) throw new Error('请先粘贴或选择一个配置 JSON 文件');
  try { return JSON.parse(text); }
  catch { throw new Error('配置不是合法 JSON'); }
}
function showImportError(message) {
  const target = $('#import-error');
  if (!target) { toast(message, 'error'); return; }
  target.textContent = message;
  target.classList.add('show');
}
function clearImportError() {
  const target = $('#import-error');
  if (target) { target.textContent = ''; target.classList.remove('show'); }
}
function renderImportPreview(result) {
  const preview = $('#import-preview');
  if (!preview) return;
  const summary = result.summary || {};
  const warnings = result.warnings || [];
  preview.classList.remove('hidden');
  preview.innerHTML = '<div class="divider-labeled">校验结果</div><div class="import-summary"><div><span>分组</span><b>' + (summary.groups || 0) + '</b></div><div><span>模型</span><b>' + (summary.models || 0) + '</b></div><div><span>虚拟 Key</span><b>' + (summary.virtualKeys || 0) + '</b></div><div><span>协议</span><b>' + (summary.protocols || []).length + '</b></div></div>' +
    (warnings.length ? '<div class="warning-box mt-3">' + icon('alert') + '<div><b>注意事项</b><ul class="warn-list">' + warnings.map(function (warning) { return '<li>' + esc(warning) + '</li>'; }).join('') + '</ul></div></div>' : '<div class="info-box mt-3">' + icon('check') + '<span>配置结构校验通过，可以导入。</span></div>');
}

async function validateImport() {
  clearImportError();
  try {
    const config = parseImportConfig();
    const result = await api('/api/config/validate', { method: 'POST', body: { config } });
    app.pendingImport = config;
    renderImportPreview(result);
    toast('配置校验通过', 'info');
  } catch (error) { showImportError(error.message); }
}

async function importConfig() {
  clearImportError();
  try {
    const config = parseImportConfig();
    const validation = await api('/api/config/validate', { method: 'POST', body: { config } });
    const summary = validation.summary || {};
    const ok = await confirmModal({
      title: '导入配置并热重载',
      message: '将用这份配置替换当前全部 groups 与全局参数。<br><br>分组 <b>' + (summary.groups || 0) + '</b> · 模型 <b>' + (summary.models || 0) + '</b> · 虚拟 Key <b>' + (summary.virtualKeys || 0) + '</b><br><br>导入前会自动创建旧配置备份。若有分组正在被客户端使用，请确认路由与 Key 仍然有效。',
      confirmLabel: '导入并热重载', danger: true,
    });
    if (!ok) return;
    const result = await api('/api/config/import', { method: 'POST', body: { config } });
    await loadState();
    app.pendingImport = null;
    const textarea = $('#config-import');
    if (textarea) textarea.value = '';
    $('#import-preview')?.classList.add('hidden');
    toast('配置已导入并热重载');
    if (result.restartRequired?.length) toast('部分设置需要重启后生效', 'info', result.restartRequired.join('、'));
  } catch (error) { showImportError(error.message); }
}

async function exportKeys() {
  const groups = app.data?.groups || [];
  const ok = await confirmModal({
    title: '导出全部虚拟 Key',
    message: '导出的文件包含所有虚拟 Key 明文，可用于备份或迁移客户端配置。请存放在安全位置，不要上传到公开仓库。',
    confirmLabel: '导出 JSON', danger: false,
  });
  if (!ok) return;
  const payload = groups.map(function (group) {
    return {
      group: group.id,
      name: group.name,
      baseURL: routerV1(),
      protocols: group.protocols,
      models: group.models.map(function (model) { return model.id; }),
      virtualApiKeys: group.virtualKeys.map(function (key) {
        return key.value ? { label: key.label, key: key.value } : { label: key.label, env: key.env };
      }),
    };
  });
  downloadText('modgaze-virtual-keys.json', JSON.stringify(payload, null, 2) + '\n');
  toast('已导出虚拟 Key 文件');
}

async function toggleGroup(id) {
  const group = findGroup(id);
  if (!group) return;
  await api('/api/groups/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: !group.enabled } });
  await loadState();
  toast(group.enabled ? '分组已禁用' : '分组已启用');
}
async function deleteGroup(id) {
  const group = findGroup(id);
  if (!group) return;
  const ok = await confirmModal({
    title: '删除上游分组', danger: true, requireText: group.id,
    message: '这会删除分组 <b>' + esc(group.name) + '</b>（<code>' + esc(group.id) + '</code>）及其全部模型、虚拟 Key 与路由。该操作不可撤销，但会自动创建配置备份。',
    confirmLabel: '永久删除',
  });
  if (!ok) return;
  await api('/api/groups/' + encodeURIComponent(id), { method: 'DELETE' });
  if (app.route.name === 'group' && app.route.id === id) navigate('#/groups');
  await loadState();
  toast('分组已删除');
}
async function clearUpstreamKey(id) {
  const group = findGroup(id);
  if (!group) return;
  const ok = await confirmModal({
    title: '清除上游 Key', danger: true,
    message: '清除后，该分组的虚拟 Key 必须依赖每个路由自己的上游 Key，否则保存会失败。客户端直通 Key 将原样转发。',
    confirmLabel: '清除 Key',
  });
  if (!ok) return;
  await api('/api/groups/' + encodeURIComponent(id), { method: 'PATCH', body: { upstreamApiKey: null } });
  await loadState();
  toast('上游 Key 已清除');
}
async function deleteRoute(id, protocol, modelId) {
  const ok = await confirmModal({
    title: '删除协议路由', danger: true,
    message: '删除 <code>' + esc(PROTOCOL_LABEL_TEXT(protocol)) + '</code> 路由后，使用该路由的模型将无法通过此协议转发。' + (modelId ? '<br><br>目标：模型覆盖 <code>' + esc(modelId) + '</code>' : ''),
    confirmLabel: '删除路由',
  });
  if (!ok) return;
  const path = modelId
    ? '/api/groups/' + encodeURIComponent(id) + '/models/' + encodeURIComponent(modelId) + '/routes/' + protocol
    : '/api/groups/' + encodeURIComponent(id) + '/routes/' + protocol;
  await api(path, { method: 'DELETE' });
  await loadState();
  toast('路由已删除');
}
function PROTOCOL_LABEL_TEXT(protocol) {
  return protocol === 'chat' ? 'Chat' : protocol === 'responses' ? 'Responses' : 'Messages';
}
async function deleteModel(groupId, modelId) {
  const ok = await confirmModal({
    title: '删除模型', danger: true,
    message: '从分组中删除模型 <code>' + esc(modelId) + '</code>。客户端随后请求该模型会返回 404。每个分组至少保留一个模型。',
    confirmLabel: '删除模型',
  });
  if (!ok) return;
  await api('/api/groups/' + encodeURIComponent(groupId) + '/models/' + encodeURIComponent(modelId), { method: 'DELETE' });
  await loadState();
  toast('模型已删除');
}
async function deleteKey(groupId, keyId, source) {
  const key = findKey(keyId);
  if (!key) return;
  const ok = await confirmModal({
    title: '删除访问密钥', danger: true,
    message: '删除后，使用该 Key 的客户端会立即收到 401。' + (source === 'api' ? '直通 Key 删除后不会影响其他密钥。' : '虚拟 Key 删除后可重新生成。'),
    confirmLabel: '删除 Key',
  });
  if (!ok) return;
  const endpoint = source === 'api' ? 'api-keys' : 'virtual-keys';
  await api('/api/groups/' + encodeURIComponent(groupId) + '/' + endpoint + '/' + encodeURIComponent(keyId), { method: 'DELETE' });
  app.reveals.delete(keyId);
  await loadState();
  toast('访问密钥已删除');
}
async function rotateKey(groupId, keyId) {
  const session = app.csrf;
  const ok = await confirmModal({
    title: '轮换虚拟 Key',
    message: '将立即生成新的 mr- Key，旧 Key 立刻失效。已配置旧 Key 的客户端需要更新。',
    confirmLabel: '轮换 Key',
  });
  if (!ok) return;
  const result = await api('/api/groups/' + encodeURIComponent(groupId) + '/virtual-keys/' + encodeURIComponent(keyId) + '/rotate', { method: 'POST', body: {} });
  app.reveals.delete(keyId);
  await loadState();
  const group = findGroup(groupId);
  toast('虚拟 Key 已轮换');
  if (result.key) openSecretModal(result.key, { session, label: '新的虚拟 Key', group: groupId, models: group ? group.models.map(function (model) { return model.id; }) : [] });
}
function revealKey(keyId) {
  const key = findKey(keyId);
  const code = document.querySelector('[data-key-text="' + keyId + '"]');
  const button = document.querySelector('[data-action="reveal-key"][data-key-id="' + keyId + '"]');
  if (!key || !key.value || !code) { toast('该 Key 不可读取（环境变量引用）', 'error'); return; }
  if (app.reveals.has(keyId)) {
    app.reveals.delete(keyId);
    code.textContent = key.masked;
    code.classList.remove('revealed');
    if (button) button.innerHTML = icon('eye');
  } else {
    app.reveals.add(keyId);
    code.textContent = key.value;
    code.classList.add('revealed');
    if (button) button.innerHTML = icon('eye-off');
  }
}
async function copyKey(keyId) {
  const key = findKey(keyId);
  if (!key || !key.value) { toast('该 Key 不可读取（环境变量引用）', 'error'); return; }
  const ok = await copyToClipboard(key.value);
  toast(ok ? '虚拟 Key 已复制' : '复制失败，请显示后手动复制', ok ? 'success' : 'error');
}

async function resetStats() {
  const ok = await confirmModal({ title: '重置统计', message: '清空当前进程的请求计数、延迟分布与最近请求记录。配置和密钥不受影响。', confirmLabel: '重置统计', danger: true });
  if (!ok) return;
  const result = await api('/api/stats/reset', { method: 'POST', body: {} });
  app.stats = result.stats;
  render();
  toast('统计已重置');
}
async function reloadConfigAction() {
  const result = await api('/api/config/reload', { method: 'POST', body: {} });
  await loadState();
  toast('配置已重新加载');
  if (result.warnings?.length) toast('配置提示', 'info', result.warnings[0]);
}
async function restartServiceAction() {
  const ok = await confirmModal({
    title: '重启路由服务', danger: true,
    message: '服务会断开当前连接并在数秒内重启。浏览器会话保存在内存中，重启后需要重新登录。',
    confirmLabel: '立即重启',
  });
  if (!ok) return;
  try { await api('/api/service/restart', { method: 'POST', body: {} }); }
  catch (error) { if (!error.network) throw error; }
  showReconnectOverlay();
}
function showReconnectOverlay() {
  if ($('#reconnect-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'reconnect-overlay';
  overlay.className = 'reconnect-overlay';
  overlay.innerHTML = '<div class="reconnect-signal" aria-hidden="true"><i></i></div><b>正在重启服务…</b><span>页面会自动重连，请稍候。</span>';
  document.body.appendChild(overlay);
  let attempts = 0;
  const timer = setInterval(async function () {
    attempts += 1;
    try {
      const response = await fetch('/healthz', { cache: 'no-store', credentials: 'same-origin' });
      if (response.ok) {
        clearInterval(timer);
        overlay.remove();
        await bootAuth();
        toast('服务已重启', 'success');
        return;
      }
    } catch {}
    if (attempts >= 40) {
      clearInterval(timer);
      overlay.remove();
      showOffline('服务重启后仍无法连接，请检查 run/modgaze.log');
      toast('服务重启超时', 'error');
    }
  }, 1200);
}

async function restoreBackup(name) {
  const ok = await confirmModal({
    title: '恢复配置备份', danger: true,
    message: '将把当前 <code>config/local.json</code> 替换为备份 <code>' + esc(name) + '</code>。恢复前会再创建一份当前配置备份。',
    confirmLabel: '恢复备份',
  });
  if (!ok) return;
  await api('/api/backups/' + encodeURIComponent(name) + '/restore', { method: 'POST', body: {} });
  await loadState();
  toast('配置已从备份恢复');
}
async function deleteBackup(name) {
  const ok = await confirmModal({
    title: '删除备份', danger: true,
    message: '删除备份文件 <code>' + esc(name) + '</code>。已恢复的内容不会受影响。',
    confirmLabel: '删除备份',
  });
  if (!ok) return;
  await api('/api/backups/' + encodeURIComponent(name), { method: 'DELETE' });
  await loadState();
  toast('备份已删除');
}
async function exportConfigRaw() {
  const password = await passwordPrompt({
    title: '导出完整配置',
    subtitle: '完整导出需要重新验证管理员密码',
    message: '完整配置包含所有上游 API Key 与虚拟 Key 明文。验证通过后浏览器会下载 JSON 文件，请存放在加密磁盘，不要提交到 Git 或发送到聊天工具。',
    confirmLabel: '验证并下载',
    danger: true,
  });
  if (!password) return;
  const result = await api('/api/config/export', { method: 'POST', body: { mode: 'raw', password } });
  downloadText('modgaze-config-private.json', JSON.stringify(result.config, null, 2) + '\n');
  toast('完整配置已下载');
}
async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  app.authenticated = false;
  app.csrf = null;
  app.data = null;
  app.stats = null;
  app.reveals.clear();
  closeModal();
  $('#app').classList.add('hidden');
  showAuth('login');
  toast('已退出登录', 'info');
}

async function runCommand(command) {
  closeModal();
  if (command === 'overview') return navigate('#/overview');
  if (command === 'groups') return navigate('#/groups');
  if (command === 'keys') return navigate('#/keys');
  if (command === 'system') return navigate('#/system/general');
  if (command === 'new-group') return openCreateGroupModal();
  if (command === 'create-backup') return openBackupModal();
  if (command === 'reload') return reloadConfigAction();
  if (command === 'copy-endpoint') return copyEndpoint();
  if (command === 'refresh') { if (await loadState({ silent: true }) !== false) toast('数据已刷新', 'info'); return; }
  if (command === 'logout') return logout();
  if (command.startsWith('group:')) return navigate('#/groups/' + encodeURIComponent(command.slice(6)) + '/overview');
}

async function runAction(action, element, event) {
  const groupId = element.dataset.group;
  const modelId = element.dataset.modelId;
  if (action === 'toggle-sidebar') { toggleSidebar(); return; }
  if (action === 'close-sidebar') { closeSidebar(); return; }
  if (action === 'command') { openCommandPalette(); return; }
  if (action === 'retry-boot') { await bootAuth(); return; }
  if (action === 'show-reset-help') {
    const hint = document.getElementById('auth-reset-hint');
    if (hint) hint.classList.toggle('hidden');
    else toast('本地重置密码', 'info', '在服务器终端运行：npm run admin:password');
    return;
  }
  if (action === 'toggle-password') {
    const input = document.getElementById(element.dataset.target);
    if (input) {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      element.innerHTML = icon(show ? 'eye-off' : 'eye');
    }
    return;
  }
  if (action === 'dismiss-toast') { dismissToast(element.closest('.toast')); return; }
  if (action === 'close-modal') { closeModal(); return; }
  if (action === 'copy-secret') {
    if (!app.modalSecret) return;
    const ok = await copyToClipboard(app.modalSecret);
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择', ok ? 'success' : 'error');
    return;
  }
  if (action === 'copy-endpoint') { await copyEndpoint(); return; }
  if (action === 'logout') { await logout(); return; }
  if (action === 'refresh') { if (await loadState({ silent: true }) !== false) toast('数据已刷新', 'info'); return; }
  if (action === 'filter-protocol') {
    app.protocolFilter = element.dataset.protocol || 'all';
    $$('.filter-chip').forEach(function (chip) { chip.classList.toggle('active', chip.dataset.protocol === app.protocolFilter); });
    filterGroups();
    return;
  }
  if (action === 'new-group') { openCreateGroupModal(); return; }
  if (action === 'edit-group') { const group = findGroup(groupId); if (group) openEditGroupModal(group); return; }
  if (action === 'clone-group') { const group = findGroup(groupId); if (group) openCloneModal(group); return; }
  if (action === 'toggle-group') { await toggleGroup(groupId); return; }
  if (action === 'delete-group') { await deleteGroup(groupId); return; }
  if (action === 'test-group-quick') { navigate('#/groups/' + encodeURIComponent(groupId) + '/test'); return; }
  if (action === 'clear-upstream-key') { await clearUpstreamKey(groupId); return; }
  if (action === 'edit-route') { const group = findGroup(groupId); if (group) openRouteModal(group, element.dataset.protocol, modelId || ''); return; }
  if (action === 'delete-route') { await deleteRoute(groupId, element.dataset.protocol, modelId || ''); return; }
  if (action === 'new-model') { const group = findGroup(groupId); if (group) openModelModal(group, null); return; }
  if (action === 'edit-model') { const group = findGroup(groupId); const model = group?.models.find(function (item) { return item.id === modelId; }); if (group && model) openModelModal(group, model); return; }
  if (action === 'delete-model') { await deleteModel(groupId, modelId); return; }
  if (action === 'bulk-models') { const group = findGroup(groupId); if (group) openBulkModelsModal(group); return; }
  if (action === 'new-virtual-key') { openVirtualKeyModal(groupId || ''); return; }
  if (action === 'new-api-key') { openApiKeyModal(groupId || ''); return; }
  if (action === 'edit-key-label') { const key = findKey(element.dataset.keyId); if (key) openKeyLabelModal(key, element.dataset.source, groupId); return; }
  if (action === 'reveal-key') { revealKey(element.dataset.keyId); return; }
  if (action === 'copy-key') { await copyKey(element.dataset.keyId); return; }
  if (action === 'rotate-key') { await rotateKey(groupId, element.dataset.keyId); return; }
  if (action === 'delete-key') { await deleteKey(groupId, element.dataset.keyId, element.dataset.source); return; }
  if (action === 'export-keys') { await exportKeys(); return; }
  if (action === 'reset-stats') { await resetStats(); return; }
  if (action === 'reload-config') { await reloadConfigAction(); return; }
  if (action === 'restart-service') { await restartServiceAction(); return; }
  if (action === 'create-backup') { openBackupModal(); return; }
  if (action === 'restore-backup') { await restoreBackup(element.dataset.name); return; }
  if (action === 'delete-backup') { await deleteBackup(element.dataset.name); return; }
  if (action === 'validate-import') { await validateImport(); return; }
  if (action === 'import-config') { await importConfig(); return; }
  if (action === 'export-config') { await exportConfigRaw(); return; }
  if (action === 'command-run') { await runCommand(element.dataset.command); return; }
  if (action === 'enter-module') { navigateFromHub(element.dataset.href || element.getAttribute('href')); return; }
  if (action === 'nav') { closeSidebar(); return; }
  if (action === 'toggle-sidebar-scrim') { closeSidebar(); return; }
  toast('未知操作：' + action, 'error');
}

export async function handleClick(event) {
  const navLink = event.target.closest('#sidebar a, .sidebar a');
  if (navLink) closeSidebar();
  const element = event.target.closest('[data-action]');
  if (!element) return;
  const action = element.dataset.action;
  if (action === 'nav') { closeSidebar(); return; }
  if (action === 'enter-module' && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
  event.preventDefault();
  try { await runAction(action, element, event); }
  catch (error) { report(error); }
}
