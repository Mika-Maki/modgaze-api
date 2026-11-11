import { $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "../core.js";
/* ---------------- overview ---------------- */
function renderTokenUsage() {
  const usage = app.tokenUsageSession === app.csrf ? app.tokenUsage : null;
  const amount = (period, field) => !usage || (field !== 'totalTokens' && usage[period].requests > 0 && usage[period].observed?.[field] === 0) ? '—' : fmtNum(usage[period][field]);
  const cards = [['today', 'DayToken', '今日'], ['total', 'TotalToken', '累计']].map(([period, label, description]) =>
    '<div class="token-usage-card"><span class="token-usage-label">' + label + ' <small>' + description + '</small></span><strong>' + amount(period, 'totalTokens') + '</strong><div class="token-usage-breakdown"><span>In <b>' + amount(period, 'inputTokens') + '</b></span><span>Out <b>' + amount(period, 'outputTokens') + '</b></span><span>Cached <b>' + amount(period, 'cachedTokens') + '</b></span></div></div>'
  ).join('');
  const state = app.tokenUsageLoading ? '正在刷新…' : app.tokenUsageError ? (usage ? '刷新失败，保留上次用量' : '暂时无法加载用量') : '';
  return '<div class="token-usage-grid">' + cards + '</div><p class="token-usage-note">' + (usage ? esc(usage.day) + ' · 日界时区 ' + esc(usage.timeZone) + ' · ' : '') + 'Total = In + Out；Cached 已含在 In 中。仅累计上游已返回的用量，缺失部分不估算。' + (state ? ' <span role="status">' + state + '</span>' : '') + '</p>';
}
function updateTokenUsage() {
  $$('[data-token-usage]').forEach(node => { node.innerHTML = renderTokenUsage(); });
}
function renderOverview() {
  const data = app.data;
  const stats = app.stats || data.stats || {};
  const service = data.service || {};
  const summaryData = data.summary || {};
  const groups = data.groups || [];
  const recent = (stats.recent || []).slice(0, 8);
  const byGroup = stats.byGroup || {};
  const topGroups = [...groups].sort((a, b) => (byGroup[b.id]?.requests || 0) - (byGroup[a.id]?.requests || 0)).slice(0, 6);
  const errorRate = stats.errorRate || 0;
  const protocolTotal = PROTOCOLS.reduce((total, protocol) => total + (stats.byProtocol?.[protocol] || 0), 0);
  return `
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow"><i></i>LOCAL ROUTER · v${esc(data.version || '1.0.0')}</div>
        <h1>本地模型，<span class="gradient-text">一键统管。</span></h1>
        <p class="hero-lead">${fmtNum(summaryData.groups || groups.length)} 个上游分组 · ${fmtNum(summaryData.models || 0)} 个模型 · ${fmtNum(summaryData.virtualKeys || 0)} 个虚拟 Key。客户端只认本地密钥，真实上游凭证留在这里。</p>
        <div class="hero-actions">
          <button class="btn btn-primary" data-action="new-group">${icon('plus')} 新建上游分组</button>
          <button class="btn" data-action="copy-endpoint">${icon('copy')} 复制本地 Base URL</button>
          <button class="btn btn-ghost" data-action="command">${icon('search')} 快速操作 <kbd style="font-size:9px;color:var(--faint)">⌘K</kbd></button>
        </div>
      </div>
      <div class="hero-endpoint">
        <div class="label"><span>CLIENT BASE URL</span><span class="badge badge-green"><i class="dot dot-green"></i> READY</span></div>
        <code>${esc(routerV1())}</code>
        <div class="protocols">${protoBadges(summaryData.protocols || [])}</div>
        <div class="endpoint-meta">
          <span class="faint tiny">${service.running ? 'pid ' + service.pid + ' · 已运行 ' + fmtDuration(runtime().uptimeMs) : '服务未运行'}</span>
          <button class="icon-btn" data-action="copy-endpoint" title="复制">${icon('copy')}</button>
        </div>
      </div>
    </section>

    <section class="token-usage" data-token-usage aria-label="Token 用量">${renderTokenUsage()}</section>
    <section class="stat-grid">
      <div class="stat-card">
        <div class="stat-top"><span class="stat-label">启用分组</span><span class="stat-icon purple">${icon('groups')}</span></div>
        <div class="stat-value" data-stat="active-groups">${fmtNum(summaryData.activeGroups || 0)}<small> / ${fmtNum(summaryData.groups || groups.length)}</small></div>
        <div class="stat-sub"><span class="dot dot-green"></span> 上游分组在线</div>
      </div>
      <div class="stat-card">
        <div class="stat-top"><span class="stat-label">模型总数</span><span class="stat-icon">${icon('database')}</span></div>
        <div class="stat-value" data-stat="models">${fmtNum(summaryData.models || 0)}</div>
        <div class="stat-sub">${protoBadges(summaryData.protocols || []) || '等待配置路由'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-top"><span class="stat-label">请求总数</span><span class="stat-icon green">${icon('activity')}</span></div>
        <div class="stat-value" data-stat="requests">${fmtNum(stats.requests || 0)}</div>
        <div class="stat-sub"><span data-stat="error-rate">${fmtPercent(errorRate)}</span> 错误率 · p95 <span data-stat="p95">${fmtMs(stats.p95Ms || 0)}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-top"><span class="stat-label">平均延迟</span><span class="stat-icon pink">${icon('clock')}</span></div>
        <div class="stat-value" data-stat="avg-ms">${fmtMs(stats.avgMs || 0)}</div>
        <div class="stat-sub">服务进程运行 <span data-stat="uptime">${fmtDuration(runtime().uptimeMs)}</span></div>
      </div>
    </section>

    <section class="grid-two">
      <div class="panel">
        <div class="panel-head">
          <div><h2 class="panel-title">流量脉冲</h2><p class="panel-sub">最近 60 分钟 · 每格 1 分钟</p></div>
          <div class="panel-actions"><span class="badge badge-cyan">${icon('activity')} live</span></div>
        </div>
        <div class="chart-wrap" id="traffic-chart">${trafficChartSvg(stats)}</div>
        <div class="chart-legend"><span><i class="legend-dot"></i>请求</span><span><i class="legend-dot cyan"></i>峰值 ${fmtNum(Math.max(0, ...(stats.buckets || []).map(bucket => bucket.count)))}</span><span><i class="legend-dot red"></i>错误 ${fmtNum(stats.errors || 0)}</span></div>
        <div class="chart-footer"><span>-60m</span><span>-30m</span><span>now</span></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2 class="panel-title">协议分布</h2><p class="panel-sub">当前进程累计请求</p></div></div>
        <div class="panel-body">
          <div class="protocol-mix" id="protocol-mix">${protocolMixHtml(stats)}</div>
          <div class="mix-foot"><span>鉴权来源</span><span>虚拟 <b class="mono" style="color:var(--text-soft)">${fmtNum(stats.byAuth?.virtual || 0)}</b> · 直通 <b class="mono" style="color:var(--text-soft)">${fmtNum(stats.byAuth?.apiKey || 0)}</b></span></div>
        </div>
      </div>
    </section>

    <section class="grid-half">
      <div class="panel">
        <div class="panel-head"><div><h2 class="panel-title">分组健康度</h2><p class="panel-sub">按累计请求排序</p></div><a class="btn btn-sm btn-ghost" href="#/groups">全部 ${icon('chevron-right')}</a></div>
        <div class="panel-body" id="groups-health">${topGroups.length ? `<div class="group-mini-list">${topGroups.map(group => groupHealthRow(group, byGroup[group.id])).join('')}</div>` : emptyState('还没有分组', '创建第一个上游分组后，健康度会显示在这里。', 'plus', '新建分组', 'new-group')}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2 class="panel-title">最近请求</h2><p class="panel-sub">不含请求正文与密钥</p></div><button class="icon-btn" data-action="refresh" title="刷新">${icon('refresh')}</button></div>
        <div class="panel-body" id="recent-requests">${recentTable(recent)}</div>
      </div>
    </section>`;
}
function groupHealthRow(group, stat) {
  const requests = stat?.requests || 0;
  const errors = stat?.errors || 0;
  return `<a class="group-mini" href="#/groups/${encodeURIComponent(group.id)}/overview">
    <span class="group-mini-mark" style="--card-accent:${groupAccent(group.id)};color:${groupAccent(group.id)}">${esc(group.id.slice(0, 2).toUpperCase())}</span>
    <span class="group-mini-copy"><b>${esc(group.name)}</b><span>${esc(group.id)} · ${group.models.length} models</span></span>
    <span class="group-mini-meta">${group.enabled ? '<i class="dot dot-green"></i>' : '<i class="dot dot-red"></i>'}<span class="live-count">${fmtNum(requests)} req</span>${errors ? '<span class="badge badge-red">' + errors + '</span>' : ''}</span>
  </a>`;
}
function recentTable(recent) {
  if (!recent.length) return emptyState('还没有请求', '客户端第一次调用 /v1/* 后，这里会出现实时请求记录。', 'activity');
  return `<div class="table-wrap"><table class="requests-table"><thead><tr><th>时间</th><th>分组</th><th>协议</th><th>模型</th><th>状态</th><th class="text-right">耗时</th></tr></thead><tbody id="recent-requests-live">${recentRows(recent)}</tbody></table></div>`;
}
function recentRows(recent) {
  return recent.map(item => {
    const group = findGroup(item.group);
    return `<tr>
      <td class="mono">${new Date(item.time).toLocaleTimeString('zh-CN', { hour12: false })}</td>
      <td class="group-name">${item.group ? esc(group?.name || item.group) : '<span class="faint">未鉴权</span>'}</td>
      <td>${item.protocol && PROTOCOLS.includes(item.protocol) ? protoBadge(item.protocol) : '<span class="badge">' + esc(item.protocol || 'local') + '</span>'}</td>
      <td class="mono group-name">${esc(item.model || '—')}</td>
      <td><span class="status-code ${statusClass(item.status)}">${item.status || 0}</span></td>
      <td class="text-right mono">${fmtMs(item.durationMs)}</td>
    </tr>`;
  }).join('');
}
function protocolMixHtml(stats) {
  const counts = stats.byProtocol || {};
  const total = PROTOCOLS.reduce((sum, protocol) => sum + (counts[protocol] || 0), 0);
  if (!total) return '<div class="empty-state" style="min-height:150px"><div class="empty-icon">' + icon('activity') + '</div><b>暂无流量</b><p>客户端发起第一次请求后，这里会出现协议分布。</p></div>';
  return PROTOCOLS.map(protocol => {
    const count = counts[protocol] || 0;
    const percent = total ? (count / total) * 100 : 0;
    return `<div class="mix-row"><span class="mix-name"><i class="dot" style="background:currentColor;color:${protocol === 'chat' ? '#c4b5fd' : protocol === 'responses' ? '#67e8f9' : '#fcd34d'}"></i>${PROTOCOL_LABEL[protocol]}</span><span class="mix-bar"><span style="width:${percent.toFixed(1)}%"></span></span><span class="mix-value">${fmtNum(count)}</span></div>`;
  }).join('');
}
function trafficChartSvg(stats) {
  const buckets = stats.buckets || [];
  if (!buckets.length || !buckets.some(bucket => bucket.count)) {
    return '<div class="chart-empty">' + icon('activity') + '<span>等待第一条请求</span></div>';
  }
  const width = 760, height = 210, padX = 10, top = 18, bottom = 30;
  const max = Math.max(1, ...buckets.map(bucket => bucket.count));
  const spanX = Math.max(1, buckets.length - 1);
  const x = index => padX + index * (width - padX * 2) / spanX;
  const y = value => top + (height - top - bottom) * (1 - value / max);
  const points = buckets.map((bucket, index) => [x(index), y(bucket.count)]);
  const line = points.map((point, index) => (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1)).join(' ');
  const area = line + ' L ' + x(buckets.length - 1).toFixed(1) + ' ' + (height - bottom) + ' L ' + x(0).toFixed(1) + ' ' + (height - bottom) + ' Z';
  const errors = points.map((point, index) => buckets[index].errors ? '<circle cx="' + point[0].toFixed(1) + '" cy="' + point[1].toFixed(1) + '" r="2.4" fill="var(--red)" opacity=".85"/>' : '').join('');
  const hover = points.map((point, index) => {
    const bucket = buckets[index];
    const label = new Date(bucket.t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
    return '<circle cx="' + point[0].toFixed(1) + '" cy="' + point[1].toFixed(1) + '" r="8" fill="transparent"><title>' + label + ' · ' + bucket.count + ' 次 · 平均 ' + bucket.avgMs + ' ms</title></circle>';
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="最近 60 分钟请求量">
    <defs>
      <linearGradient id="traffic-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#b84830" stop-opacity="0.32"/>
        <stop offset="70%" stop-color="#d28a55" stop-opacity="0.06"/>
        <stop offset="100%" stop-color="#7a2930" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="traffic-line" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#7f2830"/><stop offset="55%" stop-color="#c65a38"/><stop offset="100%" stop-color="#e8b777"/>
      </linearGradient>
    </defs>
    <g opacity="0.32">${[0, 1, 2, 3].map(index => { const lineY = top + (height - top - bottom) * index / 3; return '<line x1="' + padX + '" y1="' + lineY.toFixed(1) + '" x2="' + (width - padX) + '" y2="' + lineY.toFixed(1) + '" stroke="rgba(148,163,184,.16)" stroke-dasharray="3 5"/>'; }).join('')}</g>
    <path d="${area}" fill="url(#traffic-fill)"/>
    <path d="${line}" fill="none" stroke="url(#traffic-line)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    ${errors}
    ${hover}
  </svg>`;
}
function renderTrafficChart() {
  const host = $('#traffic-chart');
  if (host) host.innerHTML = trafficChartSvg(app.stats || app.data?.stats || {});
}

/* ---------------- attention: live patches ---------------- */
function updateLiveStats() {
  const stats = app.stats;
  if (!stats) return;
  const set = (name, value) => $$('[data-stat="' + name + '"]').forEach(el => { el.textContent = value; });
  set('requests', fmtNum(stats.requests || 0));
  set('p95', fmtMs(stats.p95Ms || 0));
  set('avg-ms', fmtMs(stats.avgMs || 0));
  set('error-rate', fmtPercent(stats.errorRate || 0));
  set('uptime', fmtDuration(runtime().uptimeMs || 0));
  $$('[data-hub-requests]').forEach(function (node) { node.textContent = fmtNum(stats.requests || 0); });
  $$('[data-hub-errors]').forEach(function (node) { node.textContent = fmtPercent(stats.errorRate || 0) + ' errors'; });
  const chart = $('#traffic-chart');
  if (chart) chart.innerHTML = trafficChartSvg(stats);
  const mix = $('#protocol-mix');
  if (mix) mix.innerHTML = protocolMixHtml(stats);
  const recent = $('#recent-requests-live');
  if (recent) recent.innerHTML = recentRows((stats.recent || []).slice(0, 8));
  const health = $('#groups-health');
  if (health && app.route.name === 'overview') {
    const byGroup = stats.byGroup || {};
    const topGroups = [...(app.data?.groups || [])].sort((a, b) => (byGroup[b.id]?.requests || 0) - (byGroup[a.id]?.requests || 0)).slice(0, 6);
    health.innerHTML = topGroups.length ? '<div class="group-mini-list">' + topGroups.map(group => groupHealthRow(group, byGroup[group.id])).join('') + '</div>' : health.innerHTML;
  }
  $$('[data-group-live]').forEach(el => {
    const groupStats = stats.byGroup?.[el.dataset.groupLive] || { requests: 0, errors: 0 };
    el.textContent = fmtNum(groupStats.requests);
  });
}

export { renderTokenUsage, updateTokenUsage, renderOverview, groupHealthRow, recentTable, recentRows, protocolMixHtml, trafficChartSvg, renderTrafficChart, updateLiveStats };
