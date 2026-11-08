import { formatRateLimit, groupRateLimitFields, $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "../core.js";
/* ---------------- group detail ---------------- */
function renderGroupDetailPage() {
  const group = findGroup(app.route.id);
  if (!group) {
    return '<div class="card card-pad" style="margin-top:30px"><div class="empty-state"><div class="empty-icon">' + icon('groups') + '</div><b>分组不存在</b><p>它可能已经被删除，或者 ID 不正确。</p><a class="btn btn-primary" href="#/groups">返回分组列表</a></div></div>';
  }
  const tab = ['overview', 'routes', 'models', 'keys', 'test'].includes(app.route.tab) ? app.route.tab : 'overview';
  const tabs = [['overview', '概览', 'overview'], ['routes', '路由', 'link'], ['models', '模型', 'database'], ['keys', '密钥', 'key'], ['test', '测试', 'play']];
  const stats = groupRequestStats(group.id);
  const tabHtml = tabs.map(function (entry) {
    const key = entry[0], label = entry[1], iconName = entry[2];
    let count = '';
    if (key === 'models') count = '<span class="tab-count">' + group.models.length + '</span>';
    if (key === 'keys') count = '<span class="tab-count">' + (group.virtualKeys.length + group.apiKeys.length) + '</span>';
    return '<a class="tab ' + (tab === key ? 'active' : '') + '" href="#/groups/' + encodeURIComponent(group.id) + '/' + key + '">' + icon(iconName) + '<span>' + label + '</span>' + count + '</a>';
  }).join('');
  const content = tab === 'overview' ? groupOverviewTab(group, stats) : tab === 'routes' ? groupRoutesTab(group) : tab === 'models' ? groupModelsTab(group) : tab === 'keys' ? groupKeysTab(group) : groupTestTab(group);
  return '<div class="detail-head">' +
    '<div class="detail-title"><a class="back-btn" href="#/groups" aria-label="返回">' + icon('chevron-left') + '</a><div>' +
    '<h1>' + esc(group.name) + ' <span class="badge ' + (group.enabled ? 'badge-green' : 'badge-red') + '"><i class="dot ' + (group.enabled ? 'dot-green' : 'dot-red') + '"></i>' + (group.enabled ? '运行中' : '已禁用') + '</span></h1>' +
    '<div class="meta"><code>' + esc(group.id) + '</code><span>·</span><span>' + group.models.length + ' 个模型</span><span>·</span>' + protoBadges(group.protocols) + '</div>' +
    '</div></div>' +
    '<div class="detail-actions">' +
    '<button class="btn btn-sm" data-action="test-group-quick" data-group="' + esc(group.id) + '">' + icon('play') + ' 测试上游</button>' +
    '<button class="btn btn-sm" data-action="clone-group" data-group="' + esc(group.id) + '">' + icon('copy') + ' 克隆</button>' +
    '<button class="btn btn-sm" data-action="edit-group" data-group="' + esc(group.id) + '">' + icon('edit') + ' 编辑</button>' +
    '<button class="btn btn-sm btn-danger" data-action="delete-group" data-group="' + esc(group.id) + '">' + icon('trash') + ' 删除</button>' +
    '</div></div>' +
    '<nav class="tabs">' + tabHtml + '</nav><div class="tab-content">' + content + '</div>';
}

function groupOverviewTab(group, stats) {
  const upstream = group.upstreamKey;
  const routes = group.routes || {};
  const routeList = PROTOCOLS.filter(function (protocol) { return routes[protocol]; }).map(function (protocol) {
    const route = routes[protocol];
    return '<div class="route-item"><span class="route-proto">' + protoBadge(protocol) + '</span><span class="route-copy"><code>' + esc(route.baseURL) + '</code><span>' + esc(route.auth) + (route.key ? ' · 路由级 Key ' + esc(route.key.masked) : '') + '</span></span><button class="icon-btn" data-action="edit-route" data-group="' + esc(group.id) + '" data-protocol="' + protocol + '">' + icon('edit') + '</button></div>';
  }).join('');
  const errorRate = stats.requests ? ((stats.errors / stats.requests) * 100).toFixed(1) + '%' : '0%';
  return '<div class="overview-grid"><div class="settings-stack">' +
    '<section class="panel credential-card"><div class="panel-head"><div><h2 class="panel-title">上游凭证</h2><p class="panel-sub">虚拟 Key 请求会被替换成这里的真实上游 Key</p></div><span class="badge ' + (upstream ? 'badge-green' : 'badge-amber') + '">' + (upstream ? (upstream.source === 'env' ? '环境变量' : '已配置') : '直传') + '</span></div>' +
    '<div class="panel-body"><div class="secret-line"><code>' + (upstream ? esc(upstream.masked) : '未设置 group.upstreamApiKey') + '</code>' + (upstream ? '<span class="key-state badge badge-green">' + icon('shield') + ' 已配置</span>' : '<span class="key-state badge badge-amber">使用客户端 Key</span>') + '</div>' +
    '<form class="key-form" data-form="upstream-key" data-group="' + esc(group.id) + '"><input class="input" type="password" name="upstreamApiKey" autocomplete="off" placeholder="输入新的上游 API Key（保存后仅显示尾号）"><button class="btn btn-primary" type="submit">' + icon('check') + ' 更新 Key</button></form>' +
    '<div class="form-error" role="alert"></div>' +
    '<div class="flex items-center justify-between mt-2"><span class="field-hint">配置文件权限 0600；接口永不回显完整上游 Key。</span>' + (upstream ? '<button class="btn btn-sm btn-ghost" data-action="clear-upstream-key" data-group="' + esc(group.id) + '">清除上游 Key</button>' : '') + '</div></div></section>' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">协议路由</h2><p class="panel-sub">分组级上游目标</p></div><a class="btn btn-sm btn-ghost" href="#/groups/' + encodeURIComponent(group.id) + '/routes">管理路由 ' + icon('chevron-right') + '</a></div>' +
    '<div class="panel-body">' + (routeList ? '<div class="route-list">' + routeList + '</div>' : emptyState('还没有协议路由', '至少配置一个 chat / responses / messages 路由后，分组才能转发请求。', 'link', '添加路由', 'edit-route', { group: group.id, protocol: group.protocols[0] || 'chat' })) + '</div></section>' +
    '</div><div class="settings-stack">' +
    groupLimitsPanel(group) +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">分组脉冲</h2><p class="panel-sub">当前进程累计</p></div><span class="badge badge-cyan">' + icon('activity') + ' live</span></div><div class="panel-body"><div class="inline-stats"><div class="inline-stat"><b>' + fmtNum(stats.requests) + '</b><span>请求</span></div><div class="inline-stat"><b>' + fmtNum(stats.errors) + '</b><span>错误</span></div><div class="inline-stat"><b>' + errorRate + '</b><span>错误率</span></div></div><div class="divider" style="margin:16px 0"></div><div class="info-box">' + icon('key') + '<span>虚拟 Key 共 <b>' + group.virtualKeys.length + '</b> 个，直通 Key 共 <b>' + group.apiKeys.length + '</b> 个。虚拟 Key 会替换上游凭证；直通 Key 会原样发送到上游。</span></div></div></section>' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">备注</h2><p class="panel-sub">用途、限流或维护提示</p></div></div><div class="panel-body"><form class="note-editor" data-form="group-note" data-group="' + esc(group.id) + '"><textarea class="textarea" name="note" placeholder="例如：官方 aihub 通道，月预算 200，仅用于 Grok / Kimi…">' + esc(group.note || '') + '</textarea><div class="flex justify-between items-center gap-2"><span class="field-hint">保存在本地配置中，不会发送给上游。</span><button class="btn btn-sm" type="submit">' + icon('check') + ' 保存备注</button></div><div class="form-error" role="alert"></div></form></div></section>' +
    '</div></div>';
}

function groupLimitsPanel(group) {
  const limits = group.rateLimits || {};
  return '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">分组 API 限流</h2><p class="panel-sub">同组所有 Key 共享，保存后热生效，无需重启。</p></div><span class="badge badge-green">热生效</span></div><div class="panel-body">' +
    '<div class="info-box">' + icon('activity') + '<span>当前并发：<b>' + formatRateLimit(limits.maxConcurrent) + '</b>；RPM：<b>' + formatRateLimit(limits.rpm) + '</b>。RPM 为每 60 秒请求数，并发包含 SSE 全生命周期。0 = 无上限。</span></div>' +
    '<form class="settings-form mt-3" data-form="group-limits" data-group="' + esc(group.id) + '"><div class="form-grid two">' +
    groupRateLimitFields(limits, 'detail-group-limits') +
    '</div><div class="form-error" role="alert"></div><div class="form-actions"><button class="btn btn-primary" type="submit">' + icon('check') + ' 保存分组限流</button></div></form></div></section>';
}

function groupRoutesTab(group) {
  const cards = PROTOCOLS.map(function (protocol) {
    const route = group.routes ? group.routes[protocol] : null;
    if (!route) {
      return '<div class="route-card unset"><div class="route-card-head">' + protoBadge(protocol) + '<span class="badge">未配置</span></div><div class="route-empty-copy">该分组目前不能通过 ' + PROTOCOL_LABEL[protocol] + ' 协议转发。添加后，使用此分组虚拟 Key 的客户端即可调用。</div><div class="route-card-foot"><span class="field-hint">' + (protocol === 'chat' ? 'POST /v1/chat/completions' : protocol === 'responses' ? 'POST /v1/responses' : 'POST /v1/messages') + '</span><button class="btn btn-sm" data-action="edit-route" data-group="' + esc(group.id) + '" data-protocol="' + protocol + '">' + icon('plus') + ' 添加</button></div></div>';
    }
    return '<div class="route-card"><div class="route-card-head">' + protoBadge(protocol) + '<span class="badge badge-green">' + icon('check') + ' 已配置</span></div><div><div class="field-label" style="margin-bottom:3px">Base URL</div><code>' + esc(route.baseURL) + '</code></div><div class="route-card-meta"><span class="badge">' + esc(route.auth) + '</span>' + (route.key ? '<span class="badge badge-purple">' + icon('key') + ' 路由级 Key</span>' : '<span class="badge">使用分组 Key</span>') + '</div><div class="route-card-foot"><span class="field-hint">' + (protocol === 'messages' ? 'x-api-key' : 'Bearer') + ' 鉴权</span><div class="card-actions"><button class="icon-btn" data-action="edit-route" data-group="' + esc(group.id) + '" data-protocol="' + protocol + '" title="编辑">' + icon('edit') + '</button><button class="icon-btn" data-action="delete-route" data-group="' + esc(group.id) + '" data-protocol="' + protocol + '" title="删除">' + icon('trash') + '</button></div></div></div>';
  }).join('');
  return '<div class="panel-head" style="padding:0 0 14px"><div><h2 class="panel-title">分组级路由</h2><p class="panel-sub">模型可以再覆盖这些目标，优先级：模型路由 &gt; 分组路由</p></div><div class="panel-actions"><button class="btn btn-sm btn-primary" data-action="edit-route" data-group="' + esc(group.id) + '" data-protocol="' + esc((group.protocols || ['chat'])[0]) + '">' + icon('plus') + ' 添加 / 编辑路由</button></div></div>' +
    '<div class="route-grid">' + cards + '</div>' +
    '<div class="info-box mt-4">' + icon('link') + '<span>Base URL 填 API 前缀而不是完整端点：<code class="mono">https://api.openai.com/v1</code> 会请求 <code class="mono">/v1/chat/completions</code>；根域名会自动补 <code class="mono">/v1</code>。<b>不要</b>填写完整路径。</span></div>';
}

function formatTokens(value) {
  if (value === null || value === undefined) return '∞';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
}

function groupModelsTab(group) {
  const rows = group.models.map(function (model) { return modelRow(group, model); }).join('');
  const body = group.models.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>模型</th><th>上游名</th><th>上下文</th><th>最大输出</th><th>输入</th><th>协议</th><th>路由覆盖</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : emptyState('还没有模型', '添加客户端可见的模型 ID，路由器会按分组路由转发。', 'database', '添加模型', 'new-model', { group: group.id });
  return '<section class="panel"><div class="table-toolbar"><div><h2 class="panel-title">模型目录</h2><p class="panel-sub">客户端只能请求这里列出的模型。上下文与输出上限仅作为发现元数据。</p></div><div class="panel-actions"><button class="btn btn-sm" data-action="bulk-models" data-group="' + esc(group.id) + '">' + icon('upload') + ' 批量导入</button><button class="btn btn-sm btn-primary" data-action="new-model" data-group="' + esc(group.id) + '">' + icon('plus') + ' 添加模型</button></div></div>' + body + '<div class="panel-body" style="padding-top:0"><div class="info-box">' + icon('spark') + '<span>「∞」表示未声明上限，不是对上游实际能力的承诺。模型上下文与最大输出都是本地发现元数据，路由器不会截断请求或伪造 token 限制。</span></div></div></section>';
}

function modelRow(group, model) {
  const routeCount = Object.keys(model.routes || {}).length;
  const inputTags = (model.input || []).map(function (value) { return '<span class="badge">' + esc(value) + '</span>'; }).join('') || '<span class="faint">—</span>';
  return '<tr data-model-row data-model-id="' + esc(model.id) + '"><td><div class="cell-title"><b>' + esc(model.name || model.id) + '</b><span>' + esc(model.id) + '</span></div></td>' +
    '<td class="mono">' + (model.upstreamModel ? esc(model.upstreamModel) : '<span class="faint">同 ID</span>') + '</td>' +
    '<td><span class="token-pill-inline" title="' + esc(model.contextWindow ?? '未声明') + '">' + esc(formatTokens(model.contextWindow)) + '</span></td>' +
    '<td><span class="token-pill-inline" title="' + esc(model.maxOutputTokens ?? '未声明') + '">' + esc(formatTokens(model.maxOutputTokens)) + '</span></td>' +
    '<td><div class="chip-row">' + inputTags + '</div></td>' +
    '<td><div class="chip-row">' + protoBadges(model.effectiveProtocols || []) + '</div></td>' +
    '<td>' + (routeCount ? '<span class="badge badge-purple">' + routeCount + ' 个覆盖</span>' : '<span class="faint tiny">跟随分组</span>') + (model.hasProvenance ? ' <span class="badge" title="保留导入的 provenance 元数据">meta</span>' : '') + '</td>' +
    '<td><div class="cell-actions"><button class="icon-btn" data-action="edit-model" data-group="' + esc(group.id) + '" data-model-id="' + esc(model.id) + '" title="编辑模型">' + icon('edit') + '</button><button class="icon-btn" data-action="delete-model" data-group="' + esc(group.id) + '" data-model-id="' + esc(model.id) + '" title="删除模型">' + icon('trash') + '</button></div></td></tr>';
}

function groupKeysTab(group) {
  const virtualRows = group.virtualKeys.map(function (key) { return keyRow(group, key, 'virtual'); }).join('');
  const apiRows = group.apiKeys.map(function (key) { return keyRow(group, key, 'api'); }).join('');
  const virtualBody = virtualRows ? '<div class="key-list">' + virtualRows + '</div>' : emptyState('还没有虚拟 Key', '新建一个 mr- 开头的本地 Key，客户端就不会看到真实上游凭证。', 'key', '新建虚拟 Key', 'new-virtual-key', { group: group.id });
  const apiBody = apiRows ? '<div class="key-list">' + apiRows + '</div>' : '<div class="empty-state" style="min-height:110px"><div class="empty-icon">' + icon('shield') + '</div><b>没有直通 Key</b><p>推荐只用虚拟 Key；直通 Key 会把客户端凭证直接交给上游。</p></div>';
  return '<div class="settings-stack">' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">虚拟 API Key</h2><p class="panel-sub">给本地客户端使用；路由器收到后替换为上游 Key，不会直传。</p></div><button class="btn btn-sm btn-primary" data-action="new-virtual-key" data-group="' + esc(group.id) + '">' + icon('plus') + ' 新建虚拟 Key</button></div><div class="panel-body">' + virtualBody + '</div></section>' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">直通 API Key</h2><p class="panel-sub">兼容旧客户端：请求中的 Key 会原样进入上游。通常不需要。</p></div><button class="btn btn-sm" data-action="new-api-key" data-group="' + esc(group.id) + '">' + icon('plus') + ' 添加直通 Key</button></div><div class="panel-body">' + apiBody + '</div></section></div>';
}

function keyRow(group, key, source) {
  const typeLabel = source === 'virtual' ? '虚拟' : '直通';
  const revealable = Boolean(key.value);
  const expiryDate = source === 'virtual' && key.expiresAt ? new Date(key.expiresAt) : null;
  const expiryLabel = expiryDate && !Number.isNaN(expiryDate.getTime())
    ? (expiryDate.getTime() <= Date.now() ? '已过期 · ' : '到期 · ') + expiryDate.toLocaleString()
    : '永不过期';
  const search = [key.label, key.masked, key.id, group.id, group.name, typeLabel].join(' ').toLowerCase();
  const actions = '<button class="icon-btn" data-action="edit-key-label" data-key-id="' + esc(key.id) + '" data-source="' + source + '" data-group="' + esc(group.id) + '" title="' + (source === 'virtual' ? '编辑标签与到期时间' : '重命名') + '">' + icon('edit') + '</button>' +
    (source === 'virtual' ? '<button class="icon-btn" data-action="rotate-key" data-key-id="' + esc(key.id) + '" data-group="' + esc(group.id) + '" title="轮换">' + icon('rotate') + '</button>' : '') +
    '<button class="icon-btn" data-action="delete-key" data-key-id="' + esc(key.id) + '" data-source="' + source + '" data-group="' + esc(group.id) + '" title="删除">' + icon('trash') + '</button>';
  const secretControls = revealable ? '<button class="icon-btn" data-action="reveal-key" data-key-id="' + esc(key.id) + '" title="显示 / 隐藏">' + icon('eye') + '</button><button class="icon-btn" data-action="copy-key" data-key-id="' + esc(key.id) + '" title="复制">' + icon('copy') + '</button>' : '<span class="badge">不可读取</span>';
  return '<div class="key-row" data-key-row data-key-id="' + esc(key.id) + '" data-search="' + esc(search) + '">' +
    '<div class="key-label"><b>' + esc(key.label || typeLabel + ' Key') + '</b><span>' + (key.source === 'env' ? 'env · ' + esc(key.env || '') : typeLabel + ' · 内联') + '</span></div>' +
    '<div class="key-secret"><code data-key-text="' + esc(key.id) + '">' + esc(key.masked) + '</code>' + secretControls + '</div>' +
    '<div class="key-meta"><span>' + (key.createdAt ? timeAgo(key.createdAt) : '创建时间未知') + '</span><span>' + (source === 'virtual' ? esc(expiryLabel) : '直通上游') + '</span></div>' +
    '<div class="key-actions">' + actions + '</div></div>';
}

function groupTestTab(group) {
  const keyOptions = group.virtualKeys.filter(function (key) { return key.value; }).map(function (key) { return '<option value="' + esc(key.id) + '">' + esc(key.label || '虚拟 Key') + ' · ' + esc(key.masked) + '</option>'; }).join('');
  const protocols = group.protocols.length ? group.protocols : PROTOCOLS;
  const protocolOptions = protocols.map(function (protocol) { return '<option value="' + protocol + '">' + PROTOCOL_LABEL[protocol] + '</option>'; }).join('');
  const modelOptions = group.models.map(function (model) { return '<option value="' + esc(model.id) + '">' + esc(model.id) + '</option>'; }).join('');
  const routerKeyHint = keyOptions ? '' : '<span class="field-hint">环境变量 Key 无法在浏览器中读取；可改用下方手动输入。</span>';
  return '<div class="test-grid">' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">上游连通性</h2><p class="panel-sub">从服务端直接请求上游，验证 Base URL、Key 与协议</p></div><span class="badge">' + icon('server') + ' UPSTREAM</span></div><div class="panel-body">' +
    '<form class="test-panel" data-form="upstream-test" data-group="' + esc(group.id) + '"><div class="form-grid two"><div class="field"><label>测试模式</label><select class="select" name="mode"><option value="models">模型列表（免费，GET /models）</option><option value="generate">真实生成（最多 16 tokens）</option></select></div><div class="field"><label>协议</label><select class="select" name="protocol">' + protocolOptions + '</select></div><div class="field span-2"><label>模型</label><select class="select" name="model">' + modelOptions + '</select></div><div class="field span-2"><label>提示词（仅生成模式）</label><input class="input" name="prompt" value="ping" maxlength="1000"><span class="field-hint">会向真实上游发起请求，可能产生少量费用。</span></div></div><div class="form-error" role="alert"></div><button class="btn btn-primary" type="submit">' + icon('play') + ' 开始测试</button></form>' +
    '<div id="upstream-result" class="test-result empty">尚未运行测试</div></div></section>' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">本地路由验证</h2><p class="panel-sub">用虚拟 Key 请求本机路由，验证鉴权与模型发现</p></div><span class="badge badge-cyan">' + icon('activity') + ' ROUTER</span></div><div class="panel-body">' +
    '<form class="test-panel" data-form="router-test" data-group="' + esc(group.id) + '"><div class="form-grid two"><div class="field span-2"><label>选择虚拟 Key</label><select class="select" name="keyId">' + (keyOptions || '<option value="">没有可读取的虚拟 Key</option>') + '</select>' + routerKeyHint + '</div><div class="field span-2"><label>或手动输入本地 Key</label><input class="input" name="manualKey" autocomplete="off" placeholder="mr-...（可选）"></div><div class="field"><label>模式</label><select class="select" name="mode"><option value="models">模型列表</option><option value="generate">生成（最多 16 tokens）</option></select></div><div class="field"><label>协议</label><select class="select" name="protocol">' + protocolOptions + '</select></div><div class="field span-2"><label>模型</label><select class="select" name="model">' + modelOptions + '</select></div></div><div class="form-error" role="alert"></div><button class="btn btn-primary" type="submit">' + icon('play') + ' 验证本地路由</button></form>' +
    '<div id="router-result" class="test-result empty">尚未运行测试</div></div></section></div>';
}


export { renderGroupDetailPage, groupOverviewTab, groupRoutesTab, formatTokens, groupModelsTab, modelRow, groupKeysTab, keyRow, groupTestTab };
