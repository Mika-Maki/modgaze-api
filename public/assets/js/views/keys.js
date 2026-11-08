import { $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "../core.js";
import { keyRow } from "./group-detail.js";
/* ---------------- keys page ---------------- */
function renderKeysPage() {
  const groups = app.data.groups || [];
  const allVirtual = groups.flatMap(function (group) { return group.virtualKeys || []; });
  const allApi = groups.flatMap(function (group) { return group.apiKeys || []; });
  const blocks = groups.filter(function (group) { return group.virtualKeys.length || group.apiKeys.length; }).map(function (group) { return renderKeyGroupBlock(group); }).join('');
  return '<div class="page-head"><div><div class="eyebrow"><i></i>LOCAL CREDENTIALS</div><h1 class="page-title">本地密钥</h1><p class="page-sub">客户端只应拿到虚拟 Key。每个分组独立隔离模型与上游凭证，删掉 Key 即刻失效。</p></div><div class="page-actions"><button class="btn" data-action="export-keys">' + icon('download') + ' 导出全部虚拟 Key</button><button class="btn btn-primary" data-action="new-virtual-key">' + icon('plus') + ' 新建虚拟 Key</button></div></div>' +
    '<div class="keys-summary"><div class="stat-card"><div class="stat-top"><span class="stat-label">虚拟 Key</span><span class="stat-icon purple">' + icon('key') + '</span></div><div class="stat-value">' + fmtNum(allVirtual.length) + '</div><div class="stat-sub">可安全交给本地客户端</div></div><div class="stat-card"><div class="stat-top"><span class="stat-label">覆盖分组</span><span class="stat-icon">' + icon('groups') + '</span></div><div class="stat-value">' + fmtNum(groups.filter(function (group) { return group.virtualKeys.length; }).length) + '</div><div class="stat-sub">一个 Key 只能进入一个分组</div></div><div class="stat-card"><div class="stat-top"><span class="stat-label">直通 Key</span><span class="stat-icon pink">' + icon('shield') + '</span></div><div class="stat-value">' + fmtNum(allApi.length) + '</div><div class="stat-sub">真实上游凭证，兼容旧客户端</div></div></div>' +
    '<div class="toolbar"><div class="search-field">' + icon('search') + '<input type="search" placeholder="搜索标签、分组或 Key 尾号…" value="' + esc(app.keySearch) + '" data-filter="key-search" autocomplete="off"></div><span class="faint tiny" style="margin-left:auto">' + allVirtual.length + ' 个虚拟 Key · ' + allApi.length + ' 个直通 Key</span></div>' +
    (blocks || emptyState('还没有本地 Key', '新建一个虚拟 Key 后，客户端用 mr-... 访问本机路由即可。', 'key', '新建虚拟 Key', 'new-virtual-key')) +
    '<div id="keys-empty-filter" class="empty-state hidden"><div class="empty-icon">' + icon('search') + '</div><b>没有匹配的 Key</b><p>换个关键词试试。</p></div>' +
    '<div class="info-box mt-4">' + icon('link') + '<span>客户端连接：OpenAI 兼容 base_url <code class="mono">' + esc(routerV1()) + '</code>，Anthropic base_url <code class="mono">' + esc(routerBase()) + '</code>。Key 填虚拟 Key，不需要改模型 ID。</span></div>';
}

function renderKeyGroupBlock(group) {
  const virtualRows = group.virtualKeys.map(function (key) { return keyRow(group, key, 'virtual'); }).join('');
  const apiRows = group.apiKeys.map(function (key) { return keyRow(group, key, 'api'); }).join('');
  return '<section class="panel key-group-block" data-key-group data-search="' + esc([group.id, group.name].join(' ').toLowerCase()) + '"><div class="key-group-head"><h3>' + icon('groups') + '<span>' + esc(group.name) + '</span><code>' + esc(group.id) + '</code></h3><div class="panel-actions"><button class="btn btn-sm btn-ghost" data-action="new-virtual-key" data-group="' + esc(group.id) + '">' + icon('plus') + ' 虚拟 Key</button><button class="btn btn-sm btn-ghost" data-action="new-api-key" data-group="' + esc(group.id) + '">' + icon('plus') + ' 直通 Key</button></div></div><div class="key-group-body">' +
    (virtualRows ? '<div class="key-list">' + virtualRows + '</div>' : '<div class="field-hint" style="padding:4px 2px 8px">该分组没有虚拟 Key。</div>') +
    (apiRows ? '<div class="divider-labeled" style="margin:14px 0 10px">直通 Key</div><div class="key-list">' + apiRows + '</div>' : '') +
    '</div></section>';
}

function filterKeys() {
  const rows = $$('[data-key-row]');
  if (!rows.length) return;
  const query = app.keySearch.trim().toLowerCase();
  let visible = 0;
  for (const row of rows) {
    const show = !query || (row.dataset.search || '').includes(query);
    row.classList.toggle('hidden', !show);
    if (show) visible += 1;
  }
  $$('[data-key-group]').forEach(function (block) {
    block.classList.toggle('hidden', !block.querySelector('[data-key-row]:not(.hidden)'));
  });
  const empty = $('#keys-empty-filter');
  if (empty) empty.classList.toggle('hidden', visible > 0 || !rows.length);
}

export { renderKeysPage, renderKeyGroupBlock, filterKeys };
