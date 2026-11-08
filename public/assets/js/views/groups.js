import { $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "../core.js";
/* ---------------- groups page ---------------- */
function renderGroupsPage() {
  const groups = app.data.groups || [];
  const protocols = summary().protocols || [];
  return `
    <div class="page-head">
      <div><div class="eyebrow"><i></i>UPSTREAM POOL</div><h1 class="page-title">上游分组</h1><p class="page-sub">每个分组是一片独立的模型与凭证池。客户端用本地 Key 进入，路由器按分组选择上游。</p></div>
      <div class="page-actions"><button class="btn btn-primary" data-action="new-group">${icon('plus')} 新建分组</button></div>
    </div>
    <div class="toolbar">
      <div class="search-field">${icon('search')}<input type="search" placeholder="搜索分组、ID 或模型…" value="${esc(app.search)}" data-filter="group-search" autocomplete="off"></div>
      <div class="filter-chips">
        <button class="filter-chip ${app.protocolFilter === 'all' ? 'active' : ''}" data-action="filter-protocol" data-protocol="all">全部</button>
        ${protocols.map(protocol => '<button class="filter-chip ' + (app.protocolFilter === protocol ? 'active' : '') + '" data-action="filter-protocol" data-protocol="' + protocol + '">' + PROTOCOL_LABEL[protocol] + '</button>').join('')}
      </div>
      <span class="faint tiny" style="margin-left:auto">${groups.length} 个分组</span>
    </div>
    <div class="group-grid">${groups.map(renderGroupCard).join('')}</div>
    <div id="groups-empty-filter" class="empty-state ${groups.length ? 'hidden' : ''}">
      <div class="empty-icon">${icon('search')}</div><b>没有匹配的分组</b><p>换个关键词，或者新建一个上游分组。</p>
      <button class="btn" data-action="new-group">${icon('plus')} 新建分组</button>
    </div>`;
}
function renderGroupCard(group) {
  const stats = groupRequestStats(group.id);
  const upstream = group.upstreamKey;
  const search = [group.id, group.name, group.note, ...group.models.map(model => model.id)].join(' ').toLowerCase();
  return `<article class="group-card ${group.enabled ? '' : 'disabled'}" data-group-card data-id="${esc(group.id)}" data-protocols="${esc((group.protocols || []).join(','))}" data-search="${esc(search)}" style="--card-accent:${groupAccent(group.id)}">
    <div class="group-card-top">
      <div class="chip-row">${protoBadges(group.protocols)}</div>
      <span class="badge ${group.enabled ? 'badge-green' : 'badge-red'}"><i class="dot ${group.enabled ? 'dot-green' : 'dot-red'}"></i>${group.enabled ? '启用' : '禁用'}</span>
    </div>
    <a class="group-card-body" href="#/groups/${encodeURIComponent(group.id)}/overview">
      <h3><span>${esc(group.name)}</span>${group.enabled ? '' : '<span class="badge">paused</span>'}</h3>
      <code class="group-id">${esc(group.id)}</code>
      <p class="group-note">${esc(group.note || '还没有备注。点击「管理」补充分组用途、上游信息或维护提示。')}</p>
      <div class="group-metrics">
        <div class="group-metric"><b>${group.models.length}</b><span>模型</span></div>
        <div class="group-metric"><b>${group.virtualKeys.length}</b><span>虚拟 Key</span></div>
        <div class="group-metric"><b data-group-live="${esc(group.id)}">${fmtNum(stats.requests)}</b><span>累计请求</span></div>
      </div>
    </a>
    <div class="group-card-footer">
      <span class="upstream-state">${upstream ? '<i class="dot dot-green"></i><code>' + esc(upstream.masked) + '</code>' : '<i class="dot dot-amber"></i>直通客户端 Key'}</span>
      <div class="card-actions">
        <button class="icon-btn" data-action="test-group-quick" data-group="${esc(group.id)}" title="测试上游">${icon('play')}</button>
        <button class="icon-btn" data-action="toggle-group" data-group="${esc(group.id)}" title="${group.enabled ? '禁用' : '启用'}">${icon(group.enabled ? 'eye-off' : 'play')}</button>
        <button class="icon-btn" data-action="delete-group" data-group="${esc(group.id)}" title="删除分组">${icon('trash')}</button>
        <a class="btn btn-sm" href="#/groups/${encodeURIComponent(group.id)}/overview">管理 ${icon('chevron-right')}</a>
      </div>
    </div>
  </article>`;
}
function filterGroups() {
  const cards = $$('[data-group-card]');
  if (!cards.length) return;
  const query = app.search.trim().toLowerCase();
  let visible = 0;
  for (const card of cards) {
    const matchesQuery = !query || (card.dataset.search || '').includes(query);
    const protocols = (card.dataset.protocols || '').split(',');
    const matchesProtocol = app.protocolFilter === 'all' || protocols.includes(app.protocolFilter);
    const show = matchesQuery && matchesProtocol;
    card.classList.toggle('hidden', !show);
    if (show) visible += 1;
  }
  $('#groups-empty-filter')?.classList.toggle('hidden', visible > 0 || !(app.data?.groups || []).length);
}


export { renderGroupsPage, renderGroupCard, filterGroups };
