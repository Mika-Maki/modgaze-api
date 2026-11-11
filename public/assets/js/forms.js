import {
  ADMIN_RATE_LIMIT_DEFAULTS, $, $$, icon, esc, app, api, closeModal, toast, findGroup, findKey, PROTOCOLS,
  PROTOCOL_LABEL, PROTOCOL_AUTH, showTestResult, setTestLoading,
} from './core.js';
import { loadState } from './data.js';
import { enterApp } from './auth.js';
import { navigate, showOffline } from './router.js';
import { openSecretModal } from './dialogs.js';

function value(fd, name) {
  const raw = fd.get(name);
  return typeof raw === 'string' ? raw.trim() : '';
}
function keyExpiryFromForm(fd, form) {
  const input = form.querySelector('[name="expiresAt"]');
  const invalid = () => { throw new Error('MR Expires at 必须是有效的本地日期时间，或留空表示永不过期'); };
  if (input?.validity && !input.validity.valid) invalid();
  const text = value(fd, 'expiresAt');
  if (!text) return null;
  const parts = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!parts) invalid();
  const date = new Date(text);
  const expected = parts.slice(1).map(part => Number(part || 0));
  const actual = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  // Reject normalized invalid dates and local times skipped by a DST transition.
  if (Number.isNaN(date.getTime()) || actual.some((part, index) => part !== expected[index])) invalid();
  // An unchanged wall time must also preserve its instant during a DST overlap.
  const original = input?.dataset;
  const localWithSeconds = text.length === 16 ? text + ':00' : text;
  if (original?.originalExpiresAt && localWithSeconds === original.originalLocal) {
    const originalDate = new Date(original.originalExpiresAt);
    if (!Number.isNaN(originalDate.getTime())) return originalDate.toISOString();
  }
  return date.toISOString();
}
function intOrNull(text) {
  if (text === '' || text === null || text === undefined) return null;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('token 数值必须是正整数，或留空表示不限制');
  return number;
}
function rateLimitValue(fd, name, label) {
  const text = value(fd, name);
  const number = Number(text);
  if (text === '' || !Number.isSafeInteger(number) || number < 0 || number > 100000) {
    throw new Error(label + ' 必须是 0–100000 的整数（0 = 无上限）');
  }
  return number;
}
function groupRateLimitsFromForm(fd) {
  return {
    maxConcurrent: rateLimitValue(fd, 'rateMaxConcurrent', '分组最大并发'),
    rpm: rateLimitValue(fd, 'rateRpm', '分组 RPM'),
  };
}
function responseBytesFromForm(fd) {
  const bytes = Number(value(fd, 'maxResponseMiB')) * 1048576;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('最大响应必须大于 0 MiB，且换算后的字节数为安全整数');
  return bytes;
}
function listOf(text) {
  return String(text || '').split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
}
function jsonOrNull(text, label) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch { throw new Error(label + ' 不是合法 JSON'); }
}
function setFormError(form, message) {
  const target = form.querySelector('.form-error');
  if (!target) { toast(message, 'error'); return; }
  target.textContent = message;
  target.classList.add('show');
}
function clearFormError(form) {
  const target = form.querySelector('.form-error');
  if (target) { target.textContent = ''; target.classList.remove('show'); }
}
function setBusy(form, busy) {
  const button = form.querySelector('[type="submit"]');
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('loading', busy);
}
async function withForm(form, run) {
  clearFormError(form);
  setBusy(form, true);
  try {
    await run();
  } catch (error) {
    setFormError(form, error.message || '操作失败');
    if (error.network) showOffline('管理服务连接中断，请检查服务状态');
  } finally {
    setBusy(form, false);
  }
}
function findModel(group, id) {
  return (group.models || []).find(model => model.id === id) || null;
}

export async function handleSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  const session = app.csrf;
  const fd = new FormData(form);
  if (kind === 'auth-login') {
    await withForm(form, async () => {
      const password = String(fd.get('password') || '');
      if (!password) throw new Error('请输入管理员密码');
      const result = await api('/api/auth/login', { method: 'POST', body: { password }, csrf: false });
      app.csrf = result.csrfToken;
      await enterApp({ verifySession: true });
    });
    return;
  }
  if (kind === 'auth-setup') {
    await withForm(form, async () => {
      const password = String(fd.get('password') || '');
      const confirm = String(fd.get('confirm') || '');
      if (password.length < 10) throw new Error('密码至少需要 10 个字符');
      if (password !== confirm) throw new Error('两次输入的密码不一致');
      const result = await api('/api/auth/setup', { method: 'POST', body: { password }, csrf: false });
      app.csrf = result.csrfToken;
      await enterApp({ verifySession: true });
    });
    return;
  }
  if (kind === 'create-group') {
    await withForm(form, async () => {
      const protocols = fd.getAll('protocols').filter(protocol => PROTOCOLS.includes(protocol));
      if (!protocols.length) throw new Error('请至少选择一个协议');
      const baseURL = value(fd, 'baseURL');
      if (!baseURL) throw new Error('请填写上游 Base URL');
      const modelIds = listOf(fd.get('models'));
      if (!modelIds.length) throw new Error('至少添加一个模型 ID');
      const contextWindow = intOrNull(value(fd, 'contextWindow'));
      const maxOutputTokens = intOrNull(value(fd, 'maxOutputTokens'));
      const routes = {};
      for (const protocol of protocols) routes[protocol] = { baseURL, auth: PROTOCOL_AUTH[protocol] };
      const models = modelIds.map(id => {
        const model = { id };
        if (contextWindow) model.contextWindow = contextWindow;
        if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens;
        return model;
      });
      const body = {
        id: value(fd, 'id'), name: value(fd, 'name'), upstreamApiKey: value(fd, 'upstreamApiKey'),
        routes, models, label: value(fd, 'label') || '默认密钥',
        rateLimits: groupRateLimitsFromForm(fd),
      };
      const result = await api('/api/groups', { method: 'POST', body });
      closeModal();
      const refreshed = await loadState({ renderPage: false });
      if (refreshed !== false) navigate('#/groups/' + encodeURIComponent(result.group.id) + '/overview');
      toast('分组已创建');
      if (result.generatedKey) openSecretModal(result.generatedKey, { session, label: '分组虚拟 Key', group: result.group.id, models: result.group.models.map(model => model.id) });
    });
    return;
  }
  if (kind === 'group-basic') {
    await withForm(form, async () => {
      const id = form.dataset.group;
      const body = {
        newId: value(fd, 'newId'), name: value(fd, 'name'),
        enabled: Boolean(form.querySelector('[name="enabled"]')?.checked),
        rateLimits: groupRateLimitsFromForm(fd),
      };
      if (!body.newId) throw new Error('分组 ID 不能为空');
      const result = await api('/api/groups/' + encodeURIComponent(id), { method: 'PATCH', body });
      closeModal();
      const refreshed = await loadState({ renderPage: false });
      if (refreshed !== false) navigate('#/groups/' + encodeURIComponent(result.group.id) + '/overview');
      toast('分组信息已保存');
    });
    return;
  }
  if (kind === 'group-limits') {
    await withForm(form, async () => {
      const rateLimits = groupRateLimitsFromForm(fd);
      await api('/api/groups/' + encodeURIComponent(form.dataset.group), { method: 'PATCH', body: { rateLimits } });
      await loadState();
      toast('分组限流已保存并热生效');
    });
    return;
  }
  if (kind === 'upstream-key') {
    await withForm(form, async () => {
      const group = form.dataset.group;
      const key = value(fd, 'upstreamApiKey');
      if (!key) throw new Error('请输入新的上游 API Key');
      if (/\s/.test(key)) throw new Error('上游 API Key 不能包含空白字符');
      await api('/api/groups/' + encodeURIComponent(group), { method: 'PATCH', body: { upstreamApiKey: key } });
      await loadState();
      form.reset();
      toast('上游 Key 已更新');
    });
    return;
  }
  if (kind === 'group-note') {
    await withForm(form, async () => {
      const group = form.dataset.group;
      await api('/api/groups/' + encodeURIComponent(group), { method: 'PATCH', body: { note: String(fd.get('note') || '') } });
      await loadState();
      toast('备注已保存');
    });
    return;
  }
  if (kind === 'route') {
    await withForm(form, async () => {
      const groupId = form.dataset.group;
      const protocol = form.dataset.protocol;
      const modelId = form.dataset.modelId;
      const baseURL = value(fd, 'baseURL');
      if (!baseURL) throw new Error('Base URL 不能为空');
      const body = { baseURL, auth: value(fd, 'auth') || PROTOCOL_AUTH[protocol] };
      const key = value(fd, 'upstreamApiKey');
      if (key) body.upstreamApiKey = key;
      if (form.querySelector('[name="clearKey"]')?.checked) body.upstreamApiKey = null;
      const path = modelId
        ? '/api/groups/' + encodeURIComponent(groupId) + '/models/' + encodeURIComponent(modelId) + '/routes/' + protocol
        : '/api/groups/' + encodeURIComponent(groupId) + '/routes/' + protocol;
      await api(path, { method: 'PUT', body });
      closeModal();
      await loadState();
      toast('路由已保存');
    });
    return;
  }
  if (kind === 'model') {
    await withForm(form, async () => {
      const groupId = form.dataset.group;
      const originalId = form.dataset.modelId;
      const group = findGroup(groupId);
      if (!group) throw new Error('分组不存在');
      const id = value(fd, 'id');
      if (!id) throw new Error('模型 ID 不能为空');
      const body = {
        id,
        name: value(fd, 'name') || null,
        upstreamModel: value(fd, 'upstreamModel') || null,
        contextWindow: intOrNull(value(fd, 'contextWindow')),
        maxOutputTokens: intOrNull(value(fd, 'maxOutputTokens')),
        input: listOf(fd.get('input')),
        reasoningEfforts: jsonOrNull(fd.get('reasoningEfforts'), 'reasoningEfforts'),
        defaults: jsonOrNull(fd.get('defaults'), 'defaults'),
      };
      if (!body.input.length) body.input = null;
      const existingModel = originalId ? findModel(group, originalId) : null;
      const routes = {};
      for (const protocol of PROTOCOLS) {
        const clear = Boolean(form.querySelector('[name="route_' + protocol + '_clear"]')?.checked);
        const baseURL = value(fd, 'route_' + protocol + '_baseURL');
        const key = value(fd, 'route_' + protocol + '_key');
        const auth = value(fd, 'route_' + protocol + '_auth') || PROTOCOL_AUTH[protocol];
        if (clear) { routes[protocol] = null; continue; }
        if (!baseURL && !key) continue;
        const existingRoute = existingModel?.routes?.[protocol];
        const route = { baseURL: baseURL || existingRoute?.baseURL, auth };
        if (!route.baseURL) throw new Error(PROTOCOL_LABEL[protocol] + ' 路由覆盖缺少 Base URL');
        if (key) route.upstreamApiKey = key;
        routes[protocol] = route;
      }
      if (Object.keys(routes).length) body.routes = routes;
      if (originalId) {
        await api('/api/groups/' + encodeURIComponent(groupId) + '/models/' + encodeURIComponent(originalId), { method: 'PATCH', body });
      } else {
        await api('/api/groups/' + encodeURIComponent(groupId) + '/models', { method: 'POST', body: { model: body } });
      }
      closeModal();
      await loadState();
      toast(originalId ? '模型已保存' : '模型已添加');
    });
    return;
  }
  if (kind === 'bulk-models') {
    await withForm(form, async () => {
      const groupId = form.dataset.group;
      const ids = listOf(fd.get('models'));
      if (!ids.length) throw new Error('请至少输入一个模型 ID');
      const template = {};
      const contextWindow = intOrNull(value(fd, 'contextWindow'));
      const maxOutputTokens = intOrNull(value(fd, 'maxOutputTokens'));
      if (contextWindow) template.contextWindow = contextWindow;
      if (maxOutputTokens) template.maxOutputTokens = maxOutputTokens;
      const result = await api('/api/groups/' + encodeURIComponent(groupId) + '/models/bulk', { method: 'POST', body: { ids, template } });
      closeModal();
      await loadState();
      toast('批量导入完成', 'success', '新增 ' + result.added.length + ' 个 · 跳过 ' + result.skipped.length + ' 个');
    });
    return;
  }
  if (kind === 'virtual-key') {
    await withForm(form, async () => {
      const groupId = value(fd, 'group');
      if (!groupId) throw new Error('请选择归属分组');
      const body = { label: value(fd, 'label') };
      const custom = value(fd, 'key');
      if (custom) body.key = custom;
      const result = await api('/api/groups/' + encodeURIComponent(groupId) + '/virtual-keys', { method: 'POST', body });
      closeModal();
      await loadState();
      toast('虚拟 Key 已创建');
      if (result.key) {
        const group = findGroup(groupId);
        openSecretModal(result.key, { session, label: '虚拟 Key 已创建', group: groupId, models: group ? group.models.map(model => model.id) : [] });
      }
    });
    return;
  }
  if (kind === 'api-key') {
    await withForm(form, async () => {
      const groupId = value(fd, 'group');
      const key = value(fd, 'key');
      if (!groupId) throw new Error('请选择归属分组');
      if (!key) throw new Error('请输入直通 Key');
      await api('/api/groups/' + encodeURIComponent(groupId) + '/api-keys', { method: 'POST', body: { key, label: value(fd, 'label') } });
      closeModal();
      await loadState();
      toast('直通 Key 已添加');
    });
    return;
  }
  if (kind === 'key-label') {
    await withForm(form, async () => {
      const groupId = form.dataset.group;
      const source = form.dataset.source === 'api' ? 'api-keys' : 'virtual-keys';
      const keyId = form.dataset.keyId;
      const body = { label: value(fd, 'label') };
      if (form.dataset.source === 'virtual') body.expiresAt = keyExpiryFromForm(fd, form);
      await api('/api/groups/' + encodeURIComponent(groupId) + '/' + source + '/' + encodeURIComponent(keyId), { method: 'PATCH', body });
      closeModal();
      await loadState();
      toast(form.dataset.source === 'virtual' ? '密钥已保存' : '密钥标签已保存');
    });
    return;
  }
  if (kind === 'clone-group') {
    await withForm(form, async () => {
      const groupId = form.dataset.group;
      const result = await api('/api/groups/' + encodeURIComponent(groupId) + '/clone', { method: 'POST', body: { id: value(fd, 'id'), name: value(fd, 'name') } });
      closeModal();
      const refreshed = await loadState({ renderPage: false });
      if (refreshed !== false) navigate('#/groups/' + encodeURIComponent(result.group.id) + '/overview');
      toast('分组已克隆');
      const virtual = result.group.virtualKeys?.[0];
      if (virtual?.value) openSecretModal(virtual.value, { session, label: '克隆分组的虚拟 Key', group: result.group.id, models: result.group.models.map(model => model.id) });
    });
    return;
  }
  if (kind === 'backup-create') {
    await withForm(form, async () => {
      await api('/api/backups', { method: 'POST', body: { label: value(fd, 'label') || 'manual' } });
      closeModal();
      await loadState();
      toast('配置备份已创建');
    });
    return;
  }
  if (kind === 'settings') {
    await withForm(form, async () => {
      const body = {
        host: value(fd, 'host'),
        port: Number(value(fd, 'port')),
        adminPort: Number(value(fd, 'adminPort')),
        maxBodyBytes: Math.round(Number(value(fd, 'maxBodyMiB')) * 1048576),
        maxResponseBytes: responseBytesFromForm(fd),
        upstreamTimeoutMs: Number(value(fd, 'upstreamTimeoutMs')),
        requestTimeoutMs: Number(value(fd, 'requestTimeoutMs')),
        accessLog: Boolean(form.querySelector('[name="accessLog"]')?.checked),
      };
      const result = await api('/api/settings', { method: 'PATCH', body });
      await loadState();
      if (result.restartRequired?.length) toast('设置已保存，部分项需要重启', 'info', result.restartRequired.join('、') + ' 重启后生效');
      else toast('设置已保存并热重载');
      const nextAdminPort = result.settings?.configuredAdminPort;
      if (nextAdminPort && Number(nextAdminPort) !== Number(app.data?.runtime?.adminPort)) {
        toast('管理台端口已变更', 'info', '重启后请访问 http://127.0.0.1:' + nextAdminPort);
      }
    });
    return;
  }
  if (kind === 'settings-audit') {
    await withForm(form, async () => {
      const fields = {};
      for (const name of ['requestIp', 'inputTokens', 'outputTokens', 'systemPrompt', 'reasoningTokens', 'model', 'group', 'key']) {
        fields[name] = Boolean(form.querySelector('[name="fields.' + name + '"]')?.checked);
      }
      const bounded = (name, min, max) => {
        const text = value(fd, name);
        const number = Number(text);
        if (!text || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(name + ' 必须是 ' + min + '–' + max + ' 的整数');
        return number;
      };
      const ipSource = value(fd, 'ipSource');
      if (!['cloudflare', 'socket', 'x-forwarded-for'].includes(ipSource)) throw new Error('请选择有效的 Request IP 来源');
      const audit = {
        enabled: Boolean(form.querySelector('[name="enabled"]')?.checked), fields, ipSource,
        trustedProxies: listOf(fd.get('trustedProxies')),
        maxEntries: bounded('maxEntries', 1, 2000),
        maxPromptChars: bounded('maxPromptChars', 1, 65536),
      };
      await api('/api/settings', { method: 'PATCH', body: { audit } });
      await loadState();
      toast('请求审计已保存并热生效');
    });
    return;
  }
  if (kind === 'settings-admin-limits') {
    await withForm(form, async () => {
      const admin = {};
      for (const name of Object.keys(ADMIN_RATE_LIMIT_DEFAULTS)) {
        admin[name] = rateLimitValue(fd, 'admin.' + name, '管理限流 ' + name);
      }
      await api('/api/settings', { method: 'PATCH', body: { rateLimits: { admin } } });
      await loadState();
      toast('管理限流已保存并热生效');
    });
    return;
  }
  if (kind === 'change-password') {
    await withForm(form, async () => {
      const currentPassword = String(fd.get('currentPassword') || '');
      const newPassword = String(fd.get('newPassword') || '');
      const confirm = String(fd.get('confirm') || '');
      if (newPassword.length < 10) throw new Error('新密码至少 10 个字符');
      if (newPassword !== confirm) throw new Error('两次输入的新密码不一致');
      const result = await api('/api/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      app.csrf = result.csrfToken;
      form.reset();
      toast('管理员密码已更新', 'success', '旧会话已全部失效');
    });
    return;
  }
  if (kind === 'upstream-test') {
    const groupId = form.dataset.group;
    form.querySelector('.form-error')?.classList.remove('show');
    setTestLoading('upstream-result', '正在请求上游…');
    try {
      const body = {
        mode: value(fd, 'mode'), protocol: value(fd, 'protocol'), model: value(fd, 'model'),
        prompt: value(fd, 'prompt'),
      };
      const result = await api('/api/groups/' + encodeURIComponent(groupId) + '/test', { method: 'POST', body });
      showTestResult('upstream-result', result.result);
    } catch (error) {
      showTestResult('upstream-result', { ok: false, status: 0, latencyMs: 0, error: error.message });
      setFormError(form, error.message);
    }
    return;
  }
  if (kind === 'router-test') {
    const groupId = form.dataset.group;
    setTestLoading('router-result', '正在请求本地路由…');
    try {
      const manual = value(fd, 'manualKey');
      let key = manual;
      if (!key) {
        const selected = findKey(value(fd, 'keyId'));
        key = selected?.value || '';
      }
      if (!key) throw new Error('请选择一个可读取的虚拟 Key，或手动输入本地 Key');
      const body = { key, mode: value(fd, 'mode'), protocol: value(fd, 'protocol'), model: value(fd, 'model') };
      const result = await api('/api/test/router', { method: 'POST', body });
      showTestResult('router-result', result.result);
    } catch (error) {
      showTestResult('router-result', { ok: false, status: 0, latencyMs: 0, error: error.message });
      setFormError(form, error.message);
    }
    return;
  }
  toast('未知表单：' + kind, 'error');
}
