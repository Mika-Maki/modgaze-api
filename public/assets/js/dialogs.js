import { groupRateLimitFields, $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "./core.js";
/* ---------------- command palette ---------------- */
function openCommandPalette() {
  const commands = [
    { id: 'overview', label: '打开概览', icon: 'overview', hint: 'G O' },
    { id: 'groups', label: '打开上游分组', icon: 'groups', hint: 'G G' },
    { id: 'keys', label: '打开本地密钥', icon: 'key', hint: 'G K' },
    { id: 'system', label: '打开系统与维护', icon: 'settings', hint: 'G S' },
    { id: 'new-group', label: '新建上游分组', icon: 'plus' },
    { id: 'create-backup', label: '立即创建配置备份', icon: 'archive' },
    { id: 'reload', label: '重新加载配置文件', icon: 'refresh' },
    { id: 'copy-endpoint', label: '复制本地 Base URL', icon: 'copy' },
    { id: 'refresh', label: '刷新当前数据', icon: 'refresh' },
    { id: 'logout', label: '退出登录', icon: 'logout' },
  ];
  for (const group of app.data?.groups || []) commands.push({ id: 'group:' + group.id, label: '打开分组 · ' + group.name, icon: 'groups', hint: group.id });
  app.commandItems = commands;
  app.commandIndex = 0;
  openModal({
    title: '', bare: true, body: '<div class="command-input-wrap">' + icon('search') + '<input class="command-input" id="command-input" placeholder="搜索动作或分组…" autocomplete="off" autofocus></div><div class="command-section">动作</div><div class="command-list" id="command-list"></div>',
    size: 'command-modal', showIcon: false, onMount: function () {
      renderCommandList('');
      $('#command-input').addEventListener('input', function (event) { renderCommandList(event.target.value); });
      $('#command-input').addEventListener('keydown', function (event) {
        const items = $$('#command-list .command-item');
        if (!items.length) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); app.commandIndex = Math.min(items.length - 1, app.commandIndex + 1); focusCommand(items); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); app.commandIndex = Math.max(0, app.commandIndex - 1); focusCommand(items); }
        else if (event.key === 'Enter') { event.preventDefault(); items[app.commandIndex % items.length]?.click(); }
      });
    },
    onClose: function () { app.commandItems = []; },
  });
}
function renderCommandList(query) {
  const list = $('#command-list');
  if (!list) return;
  const normalized = String(query || '').trim().toLowerCase();
  const matches = app.commandItems.filter(function (command) { return !normalized || command.label.toLowerCase().includes(normalized) || command.id.toLowerCase().includes(normalized); });
  app.commandIndex = 0;
  if (!matches.length) { list.innerHTML = '<div class="command-empty">没有匹配的动作</div>'; return; }
  list.innerHTML = matches.map(function (command, index) {
    return '<button class="command-item ' + (index === 0 ? 'focus' : '') + '" data-action="command-run" data-command="' + esc(command.id) + '">' + icon(command.icon) + '<span class="cmd-label">' + esc(command.label) + '</span>' + (command.hint ? '<kbd>' + esc(command.hint) + '</kbd>' : '') + '</button>';
  }).join('');
}
function focusCommand(items) {
  items.forEach(function (item, index) { item.classList.toggle('focus', index === app.commandIndex); });
  items[app.commandIndex]?.scrollIntoView({ block: 'nearest' });
}
/* ---------------- modal forms ---------------- */
function nextGroupId() {
  const used = new Set((app.data?.groups || []).map(function (group) { return group.id; }));
  let index = 1;
  while (used.has('group-' + String(index).padStart(3, '0'))) index += 1;
  return 'group-' + String(index).padStart(3, '0');
}
function openCreateGroupModal() {
  const id = nextGroupId();
  const protocols = PROTOCOLS.map(function (protocol) { return '<label class="checkbox-row"><input type="checkbox" name="protocols" value="' + protocol + '" ' + (protocol === 'chat' ? 'checked' : '') + '> ' + PROTOCOL_LABEL[protocol] + ' <span class="faint">' + (protocol === 'chat' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : '/v1/messages') + '</span></label>'; }).join('');
  openModal({
    title: '新建上游分组', subtitle: '一个分组 = 一套上游凭证 + 路由 + 模型目录。保存后立即生效。', size: 'wide', icon: 'plus',
    body: '<form class="form-grid two" data-form="create-group" id="create-group-form">' +
      '<div class="field"><label>分组 ID <span class="req">*</span></label><input class="input" name="id" value="' + esc(id) + '" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"><span class="field-hint">字母、数字、点、下划线、短横线；作为内部标识。</span></div>' +
      '<div class="field"><label>展示名称</label><input class="input" name="name" placeholder="例如：OpenAI 官方、Kimi 高速通道"></div>' +
      '<div class="field span-2"><label>上游 Base URL <span class="req">*</span></label><input class="input" name="baseURL" placeholder="https://api.example.com/v1" required><span class="field-hint">API 前缀，不要填写 /chat/completions 或 /messages 完整路径。</span></div>' +
      '<div class="field span-2"><label>协议</label><div class="chip-row" style="gap:12px">' + protocols + '</div><span class="field-hint">选中的协议会共用同一个 Base URL；保存后可分别修改成不同上游。</span></div>' +
      '<div class="field span-2"><label>上游 API Key <span class="req">*</span></label><input class="input" name="upstreamApiKey" type="password" autocomplete="off" placeholder="sk-..." required><span class="field-hint">只保存在 0600 配置文件中；界面之后只显示尾号。</span></div>' +
      '<div class="field span-2"><label>模型 ID 列表 <span class="req">*</span></label><textarea class="textarea" name="models" required placeholder="model-a&#10;model-b&#10;model-c"></textarea><span class="field-hint">每行一个；也可用逗号分隔。保存后可补充上下文、输入模态等元数据。</span></div>' +
      '<div class="field"><label>上下文窗口（可选）</label><input class="input" name="contextWindow" type="number" min="1" placeholder="留空 = 不限制 / 未声明"></div>' +
      '<div class="field"><label>最大输出 tokens（可选）</label><input class="input" name="maxOutputTokens" type="number" min="1" placeholder="留空 = 不限制 / 未声明"></div>' +
      '<div class="field span-2"><label>分组限流</label><span class="field-hint">默认 0 = 无上限；同组所有 Key 共享预算，RPM 按每 60 秒计数，并发包含 SSE 全生命周期。保存后热生效。</span></div>' +
      groupRateLimitFields({}, 'create-group-limits') +
      '<div class="field span-2"><label>虚拟 Key 标签</label><input class="input" name="label" placeholder="默认密钥（留空使用默认标签）"><span class="field-hint">会自动生成一个 mr- 开头的虚拟 Key，保存后立即显示。</span></div>' +
      '<div class="form-error span-2" role="alert"></div>' +
      '<div class="form-actions span-2"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('check') + ' 创建分组</button></div></form>',
  });
}

function openEditGroupModal(group) {
  openModal({
    title: '编辑分组', subtitle: '修改展示名、内部 ID 或分组限流；保存后立即生效。重命名不会影响已有 Key。', icon: 'edit',
    body: '<form class="form-grid" data-form="group-basic" data-group="' + esc(group.id) + '">' +
      '<div class="field"><label>展示名称</label><input class="input" name="name" value="' + esc(group.name) + '" maxlength="80"></div>' +
      '<div class="field"><label>分组 ID</label><input class="input" name="newId" value="' + esc(group.id) + '" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"><span class="field-hint">修改后 URL 与配置中的 ID 会同步变化。</span></div>' +
      '<div class="field"><label>分组限流</label><span class="field-hint">0 = 无上限；同组所有 Key 共享预算。RPM 按每 60 秒计数，并发包含 SSE 全生命周期。</span></div>' +
      groupRateLimitFields(group.rateLimits || {}, 'edit-group-limits') +
      '<label class="switch"><input type="checkbox" name="enabled" ' + (group.enabled ? 'checked' : '') + '><span class="track"></span><span>允许这个分组接受客户端请求</span></label>' +
      '<div class="form-error" role="alert"></div>' +
      '<div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('check') + ' 保存</button></div></form>',
  });
}

function openRouteModal(group, protocol, modelId) {
  const model = modelId ? group.models.find(function (item) { return item.id === modelId; }) : null;
  const route = modelId ? model?.routes?.[protocol] : group.routes?.[protocol];
  const defaultBase = route?.baseURL || group.routes?.[protocol]?.baseURL || '';
  const protocolOptions = PROTOCOLS.map(function (item) { return '<option value="' + item + '" ' + (item === protocol ? 'selected' : '') + '>' + PROTOCOL_LABEL[item] + '</option>'; }).join('');
  const authOptions = ['bearer', 'x-api-key'].map(function (value) { return '<option value="' + value + '" ' + ((route?.auth || PROTOCOL_AUTH[protocol]) === value ? 'selected' : '') + '>' + value + '</option>'; }).join('');
  const keyHint = route?.key ? '当前路由级 Key：' + route.key.masked + '（留空保留）' : '留空则使用分组级上游 Key';
  openModal({
    title: modelId ? '模型路由覆盖' : '分组协议路由', subtitle: modelId ? ('仅对模型 ' + modelId + ' 生效，优先于分组路由') : '为这个协议指定上游 Base URL 与鉴权方式', icon: 'link',
    body: '<form class="form-grid" data-form="route" data-group="' + esc(group.id) + '" data-protocol="' + esc(protocol) + '" data-model-id="' + esc(modelId || '') + '">' +
      '<div class="field"><label>协议</label><select class="select" name="protocol" disabled title="协议由打开此对话框的入口决定">' + protocolOptions + '</select></div>' +
      '<div class="field"><label>Base URL <span class="req">*</span></label><input class="input" name="baseURL" value="' + esc(defaultBase) + '" placeholder="https://api.example.com/v1" required><span class="field-hint">路由器会在这里追加 /v1/chat/completions 等原生端点。</span></div>' +
      '<div class="field"><label>鉴权方式</label><select class="select" name="auth">' + authOptions + '</select></div>' +
      '<div class="field"><label>路由级上游 Key（可选）</label><input class="input" name="upstreamApiKey" type="password" autocomplete="off" placeholder="' + esc(keyHint) + '"><span class="field-hint">用于同分组内不同协议使用不同 Key；留空保留现有值。</span></div>' +
      (route?.key ? '<label class="checkbox-row"><input type="checkbox" name="clearKey"> 清除这个路由级 Key，改用分组级 Key</label>' : '') +
      '<div class="form-error" role="alert"></div>' +
      '<div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('check') + ' 保存路由</button></div></form>',
  });
}

function openModelModal(group, model) {
  const isEdit = Boolean(model);
  const routeBlocks = PROTOCOLS.map(function (protocol) {
    const route = model?.routes?.[protocol];
    const authOptions = ['bearer', 'x-api-key'].map(function (value) { return '<option value="' + value + '" ' + ((route?.auth || PROTOCOL_AUTH[protocol]) === value ? 'selected' : '') + '>' + value + '</option>'; }).join('');
    return '<div class="inline-toggle" style="align-items:flex-start;flex-direction:column"><div class="flex justify-between items-center w-full gap-2"><span class="proto proto-' + protocol + '">' + PROTOCOL_LABEL[protocol] + '</span>' + (route ? '<span class="badge badge-purple">已有覆盖</span>' : '<span class="badge">跟随分组</span>') + '</div><div class="form-grid two w-full" style="margin-top:9px"><div class="field span-2"><label>Base URL</label><input class="input" name="route_' + protocol + '_baseURL" value="' + esc(route?.baseURL || '') + '" placeholder="留空跟随分组路由"><span class="field-hint">' + (route?.key ? '现有路由 Key：' + esc(route.key.masked) + '，留空保留。' : '') + '</span></div><div class="field"><label>鉴权</label><select class="select" name="route_' + protocol + '_auth">' + authOptions + '</select></div><div class="field"><label>路由 Key（可选）</label><input class="input" name="route_' + protocol + '_key" type="password" autocomplete="off" placeholder="' + (route?.key ? '保留现有 Key' : '可选') + '"></div><label class="checkbox-row span-2"><input type="checkbox" name="route_' + protocol + '_clear"> 删除这个协议的路由覆盖</label></div></div>';
  }).join('');
  const inputValue = (model?.input || []).join(', ');
  const reasoning = model?.reasoningEfforts ? JSON.stringify(model.reasoningEfforts, null, 2) : '';
  const defaults = model?.defaults ? JSON.stringify(model.defaults, null, 2) : '';
  openModal({
    title: isEdit ? '编辑模型 · ' + model.id : '添加模型', subtitle: isEdit ? '只修改需要变化的字段；路由覆盖留空即跟随分组。' : '客户端只能看到这里列出的模型 ID。', size: 'wide', icon: 'database',
    body: '<form class="form-grid two" data-form="model" data-group="' + esc(group.id) + '" data-model-id="' + esc(model?.id || '') + '">' +
      '<div class="field"><label>模型 ID <span class="req">*</span></label><input class="input" name="id" value="' + esc(model?.id || '') + '" required><span class="field-hint">客户端请求里的 model 字段。</span></div>' +
      '<div class="field"><label>展示名称</label><input class="input" name="name" value="' + esc(model?.name || '') + '" placeholder="可选"></div>' +
      '<div class="field span-2"><label>上游模型名（可选）</label><input class="input" name="upstreamModel" value="' + esc(model?.upstreamModel || '') + '" placeholder="留空表示与模型 ID 相同"><span class="field-hint">用于客户端模型名与上游不一致的情况。</span></div>' +
      '<div class="field"><label>上下文窗口</label><input class="input" name="contextWindow" type="number" min="1" value="' + esc(model?.contextWindow ?? '') + '" placeholder="留空 = ∞ / 未声明"></div>' +
      '<div class="field"><label>最大输出 tokens</label><input class="input" name="maxOutputTokens" type="number" min="1" value="' + esc(model?.maxOutputTokens ?? '') + '" placeholder="留空 = ∞ / 未声明"></div>' +
      '<div class="field span-2"><label>输入模态</label><input class="input" name="input" value="' + esc(inputValue) + '" placeholder="text, image, audio"><span class="field-hint">逗号分隔；仅作为 /v1/models 发现元数据，不做请求转换。</span></div>' +
      '<div class="field"><label>reasoningEfforts JSON</label><textarea class="textarea" name="reasoningEfforts" placeholder=\'{"low":"low","high":"high"}\'>' + esc(reasoning) + '</textarea></div>' +
      '<div class="field"><label>defaults JSON</label><textarea class="textarea" name="defaults" placeholder=\'{"responses":{"reasoning":{"effort":"high"}}}\'>' + esc(defaults) + '</textarea></div>' +
      '<div class="field span-2"><div class="divider-labeled">模型级路由覆盖（可选）</div><div class="settings-stack">' + routeBlocks + '</div></div>' +
      '<div class="form-error span-2" role="alert"></div>' +
      '<div class="form-actions span-2"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('check') + ' ' + (isEdit ? '保存模型' : '添加模型') + '</button></div></form>',
  });
}

function openBulkModelsModal(group) {
  openModal({
    title: '批量导入模型', subtitle: '每行一个模型 ID；重复 ID 会自动跳过。', icon: 'upload',
    body: '<form class="form-grid" data-form="bulk-models" data-group="' + esc(group.id) + '">' +
      '<div class="field"><label>模型 ID</label><textarea class="textarea import-area" name="models" style="min-height:200px" required placeholder="model-a&#10;model-b&#10;model-c"></textarea><span class="field-hint">也支持逗号分隔。导入后可以逐个编辑上下文与输入模态。</span></div>' +
      '<div class="form-grid two"><div class="field"><label>统一上下文窗口（可选）</label><input class="input" name="contextWindow" type="number" min="1" placeholder="不设置"></div><div class="field"><label>统一最大输出（可选）</label><input class="input" name="maxOutputTokens" type="number" min="1" placeholder="不设置"></div></div>' +
      '<div class="form-error" role="alert"></div>' +
      '<div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('upload') + ' 导入模型</button></div></form>',
  });
}

function groupSelectOptions(selected) {
  return (app.data?.groups || []).map(function (group) { return '<option value="' + esc(group.id) + '" ' + (group.id === selected ? 'selected' : '') + '>' + esc(group.name) + ' · ' + esc(group.id) + '</option>'; }).join('');
}

function openVirtualKeyModal(groupId) {
  const group = groupId ? findGroup(groupId) : null;
  openModal({
    title: '新建虚拟 API Key', subtitle: '虚拟 Key 只会命中一个分组，并替换为该分组的上游 Key。', icon: 'key',
    body: '<form class="form-grid" data-form="virtual-key">' +
      '<div class="field"><label>归属分组</label><select class="select" name="group">' + groupSelectOptions(groupId || app.data?.groups?.[0]?.id) + '</select></div>' +
      '<div class="field"><label>标签</label><input class="input" name="label" maxlength="80" placeholder="例如：Claude Code 客户端"></div>' +
      '<div class="field"><label>自定义 Key（可选）</label><input class="input" name="key" autocomplete="off" placeholder="留空自动生成 mr-..."><span class="field-hint">自定义 Key 至少 8 个字符，不能包含空白字符。' + (group && !group.upstreamKey ? ' 该分组未配置上游 Key，保存时可能失败。' : '') + '</span></div>' +
      '<div class="form-error" role="alert"></div>' +
      '<div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('plus') + ' 创建 Key</button></div></form>',
  });
}

function openApiKeyModal(groupId) {
  openModal({
    title: '添加直通 API Key', subtitle: '兼容旧客户端：请求中的真实 Key 会原样转发给上游。', icon: 'shield',
    body: '<form class="form-grid" data-form="api-key">' +
      '<div class="field"><label>归属分组</label><select class="select" name="group">' + groupSelectOptions(groupId || app.data?.groups?.[0]?.id) + '</select></div>' +
      '<div class="field"><label>标签</label><input class="input" name="label" maxlength="80" placeholder="例如：旧版 OpenAI SDK"></div>' +
      '<div class="field"><label>真实上游 Key <span class="req">*</span></label><input class="input" name="key" type="password" autocomplete="off" required placeholder="sk-..."><span class="field-hint">保存后只显示尾号；不会通过管理 API 回显完整值。</span></div>' +
      '<div class="form-error" role="alert"></div>' +
      '<div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('plus') + ' 添加</button></div></form>',
  });
}

function openKeyLabelModal(key, source, groupId) {
  const isVirtual = source === 'virtual';
  let expiryField = '';
  if (isVirtual) {
    const date = key.expiresAt ? new Date(key.expiresAt) : null;
    const pad = number => String(number).padStart(2, '0');
    const localValue = date && !Number.isNaN(date.getTime())
      ? String(date.getFullYear()).padStart(4, '0') + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
      : '';
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expiryField = '<div class="field"><label for="key-expires-at">MR Expires at</label><input class="input" id="key-expires-at" type="datetime-local" name="expiresAt" step="1" value="' + esc(localValue) + '" data-original-local="' + esc(localValue) + '" data-original-expires-at="' + esc(key.expiresAt || '') + '"><span class="field-hint">留空表示永不过期，到期后自动删除此 MR Key。浏览器本地时区：' + esc(timezone) + '；保存时转换为 UTC。</span></div>';
  }
  openModal({
    title: isVirtual ? '编辑密钥' : '重命名密钥', subtitle: '标签只用于本地识别，不影响鉴权。', icon: 'edit', size: 'narrow',
    body: '<form class="form-grid" data-form="key-label" data-group="' + esc(groupId) + '" data-source="' + esc(source) + '" data-key-id="' + esc(key.id) + '"><div class="field"><label>标签</label><input class="input" name="label" value="' + esc(key.label || '') + '" maxlength="80" autofocus></div>' + expiryField + '<div class="form-error" role="alert"></div><div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('check') + ' 保存</button></div></form>',
  });
}

function openCloneModal(group) {
  openModal({
    title: '克隆分组', subtitle: '复制路由与模型，重新生成虚拟 Key；不会复制直通 Key。', icon: 'copy', size: 'narrow',
    body: '<form class="form-grid" data-form="clone-group" data-group="' + esc(group.id) + '"><div class="field"><label>新分组 ID</label><input class="input" name="id" value="' + esc(group.id + '-copy') + '" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"></div><div class="field"><label>展示名称</label><input class="input" name="name" value="' + esc((group.name || group.id) + ' 副本') + '"></div><div class="info-box">' + icon('key') + '<span>克隆会复用上游 Key 与模型，并为新分组生成新的虚拟 Key，避免和原分组冲突。</span></div><div class="form-error" role="alert"></div><div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('copy') + ' 克隆</button></div></form>',
  });
}

function openBackupModal() {
  openModal({
    title: '创建配置备份', subtitle: '备份包含完整密钥，文件权限 0600。', icon: 'archive', size: 'narrow',
    body: '<form class="form-grid" data-form="backup-create"><div class="field"><label>备份标签</label><input class="input" name="label" maxlength="24" placeholder="例如 before-cleanup" autofocus><span class="field-hint">标签会写入文件名，仅支持字母、数字、短横线。</span></div><div class="form-error" role="alert"></div><div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">' + icon('archive') + ' 创建备份</button></div></form>',
  });
}

function openSecretModal(key, options) {
  app.modalSecret = key;
  const opts = options || {};
  const label = opts.label || '新密钥';
  openModal({
    title: label, subtitle: '请复制并保存到你的客户端配置中。密钥不会再次通过创建接口返回。', icon: 'key',
    body: '<div class="secret-display"><code id="secret-value">' + esc(key) + '</code><button class="btn btn-sm" data-action="copy-secret">' + icon('copy') + ' 复制</button></div>' +
      (opts.group ? '<div class="info-box mt-3">' + icon('link') + '<span>分组 <b>' + esc(opts.group) + '</b> · Base URL <code class="mono">' + esc(routerV1()) + '</code> · 模型 ' + esc((opts.models || []).slice(0, 6).join(', ')) + ((opts.models || []).length > 6 ? ' 等' : '') + '</span></div>' : '') +
      '<div class="warning-box mt-3">' + icon('alert') + '<span>这是可直接访问本机路由的凭证，请只交给可信客户端。丢失后可在「本地密钥」里轮换或删除。</span></div>',
    footer: '<button class="btn btn-primary" data-action="close-modal">完成</button>',
  });
}

export { openCommandPalette, renderCommandList, focusCommand, nextGroupId, openCreateGroupModal, openEditGroupModal, openRouteModal, openModelModal, openBulkModelsModal, groupSelectOptions, openVirtualKeyModal, openApiKeyModal, openKeyLabelModal, openCloneModal, openBackupModal, openSecretModal };
