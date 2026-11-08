import { ADMIN_RATE_LIMIT_DEFAULTS, rateLimitField, $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "../core.js";
/* ---------------- system page ---------------- */
function renderSystemPage() {
  const tab = ['general', 'backups', 'config', 'audit'].includes(app.route.tab) ? app.route.tab : 'general';
  const tabs = [['general', '系统设置', 'settings'], ['backups', '备份与恢复', 'archive'], ['config', '配置导入导出', 'database'], ['audit', '审计日志', 'clock']];
  const content = tab === 'backups' ? systemBackupsTab() : tab === 'config' ? systemConfigTab() : tab === 'audit' ? systemAuditTab() : systemGeneralTab();
  return '<div class="page-head"><div><div class="eyebrow"><i></i>CONTROL PLANE</div><h1 class="page-title">系统与维护</h1><p class="page-sub">调整监听参数、备份恢复、导入导出与本地安全设置。</p></div></div>' +
    '<nav class="tabs">' + tabs.map(function (entry) { return '<a class="tab ' + (tab === entry[0] ? 'active' : '') + '" href="#/system/' + entry[0] + '">' + icon(entry[2]) + '<span>' + entry[1] + '</span></a>'; }).join('') + '</nav>' + content;
}

function systemGeneralTab() {
  const data = app.data;
  const setting = data.settings || {};
  const rt = data.runtime || {};
  const service = data.service || {};
  const restartPort = Number(setting.port) !== Number(rt.routerPort);
  const restartAdmin = Number(setting.configuredAdminPort) !== Number(rt.adminPort);
  const serviceText = service.running ? '运行中 · pid ' + service.pid + (service.managed ? ' · service 托管' : ' · 手动启动') : '未运行';
  return '<div class="settings-layout"><div class="settings-stack">' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">运行参数</h2><p class="panel-sub">保存后配置会热重载；监听地址变更需要重启进程。</p></div><span class="badge ' + (restartPort || restartAdmin ? 'badge-amber' : 'badge-green') + '">' + (restartPort || restartAdmin ? '有待重启变更' : '已同步') + '</span></div><div class="panel-body">' +
    '<form class="settings-form" data-form="settings"><div class="form-grid two">' +
    '<div class="field"><label>路由监听地址</label><input class="input" name="host" value="' + esc(setting.host || '127.0.0.1') + '" required></div>' +
    '<div class="field"><label>路由端口 ' + (restartPort ? '<span class="restart-note">' + icon('alert') + ' 重启生效</span>' : '') + '</label><input class="input" name="port" type="number" min="1" max="65535" value="' + esc(setting.port ?? 8787) + '" required></div>' +
    '<div class="field"><label>管理台端口 ' + (restartAdmin ? '<span class="restart-note">' + icon('alert') + ' 重启生效</span>' : '') + '</label><input class="input" name="adminPort" type="number" min="1" max="65535" value="' + esc(setting.configuredAdminPort ?? 8788) + '" required></div>' +
    '<div class="field"><label>最大请求体（MiB）</label><input class="input" name="maxBodyMiB" type="number" min="1" max="1024" step="1" value="' + esc(Math.round((setting.maxBodyBytes || 67108864) / 1048576)) + '"></div>' +
    '<div class="field"><label for="max-response-mib">最大响应（MiB）</label><input class="input" id="max-response-mib" name="maxResponseMiB" type="number" min="0.00000095367431640625" step="any" value="' + esc((setting.maxResponseBytes ?? 268435456) / 1048576) + '" required><span class="field-hint">默认 256 MiB；1 MiB = 1048576 字节。保存后热生效，无需重启。</span></div>' +
    '<div class="field"><label>上游空闲超时（毫秒）</label><input class="input" name="upstreamTimeoutMs" type="number" min="1000" max="86400000" step="1000" value="' + esc(setting.upstreamTimeoutMs ?? 120000) + '"></div>' +
    '<div class="field"><label>总请求超时（毫秒）</label><input class="input" name="requestTimeoutMs" type="number" min="1000" max="86400000" step="1000" value="' + esc(setting.requestTimeoutMs ?? 600000) + '"></div>' +
    '<div class="field span-2"><label>访问日志</label><label class="switch"><input type="checkbox" name="accessLog" ' + (setting.accessLog ? 'checked' : '') + '><span class="track"></span><span>记录请求 ID、方法、协议、状态与耗时（不含 Key、正文、模型或上游地址）</span></label></div>' +
    '</div><div class="form-error" role="alert"></div><div class="form-actions"><button class="btn btn-primary" type="submit">' + icon('check') + ' 保存设置</button></div></form>' +
    '<div class="info-box mt-3">' + icon('alert') + '<span>修改监听地址/端口不会立即迁移当前 socket。保存后请使用下方「重启服务」或终端 <code class="mono">npm run service:restart</code> 让监听地址生效。</span></div>' +
    '</div></section>' +
    systemAdminLimitsPanel(setting) +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">安全</h2><p class="panel-sub">管理员密码使用 scrypt + 随机盐哈希存储</p></div><span class="badge badge-green">' + icon('shield') + ' scrypt</span></div><div class="panel-body">' +
    '<form class="settings-form" data-form="change-password"><div class="form-grid two"><div class="field"><label>当前密码</label><input class="input" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label>新密码</label><input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="10" required placeholder="至少 10 个字符"></div><div class="field span-2"><label>确认新密码</label><input class="input" name="confirm" type="password" autocomplete="new-password" minlength="10" required></div></div><div class="form-error" role="alert"></div><div class="form-actions split"><span class="field-hint">修改成功后旧会话全部失效，当前会话自动续签。</span><button class="btn btn-primary" type="submit">' + icon('key') + ' 更新密码</button></div></form>' +
    '<div class="divider" style="margin:16px 0"></div><div class="info-box">' + icon('terminal') + '<span>忘记密码时，在服务器终端运行 <code class="mono">npm run admin:password</code> 本地重置。密码文件：<code class="mono">' + esc(data.runtime?.authDisplay || 'config/admin-auth.private.json') + '</code>。</span></div>' +
    '</div></section></div><div class="settings-stack">' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">服务状态</h2><p class="panel-sub">由 scripts/service.mjs 托管时可一键重启</p></div></div><div class="panel-body"><div class="service-card"><div class="service-state ' + (service.running ? '' : 'offline') + '"><span class="service-dot"></span><div><b>' + serviceText + '</b><span>Node ' + esc(rt.node || '') + ' · 内存 ' + fmtNum(rt.memoryMB || 0) + ' MB</span></div></div><div class="panel-actions"><button class="btn btn-sm" data-action="reload-config">' + icon('refresh') + ' 重载配置</button><button class="btn btn-sm btn-danger" data-action="restart-service"' + (service.managed ? '' : ' disabled title="当前进程不是 service.mjs 托管"') + '>' + icon('rotate') + ' 重启服务</button></div></div>' +
    (service.managed ? '' : '<div class="warning-box mt-3">' + icon('alert') + '<span>当前进程不是由 <code>scripts/service.mjs</code> 托管，自动重启不可用。请在启动它的终端运行 <code>npm run service:restart</code>。</span></div>') +
    '</div></section>' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">运行时</h2><p class="panel-sub">当前进程与文件位置</p></div></div><div class="panel-body"><div class="runtime-grid">' +
    runtimeItem('进程 PID', rt.pid) + runtimeItem('运行时长', fmtDuration(rt.uptimeMs)) + runtimeItem('路由端口', rt.routerPort) + runtimeItem('管理台端口', rt.adminPort) + runtimeItem('Node.js', rt.node) + runtimeItem('版本', 'v' + (data.version || '1.0.0')) + runtimeItem('配置文件', rt.configDisplay || data.settings?.configPath) + runtimeItem('运行目录', rt.runDisplay || rt.runDir) +
    '</div><div class="divider" style="margin:14px 0"></div><div class="flex justify-between items-center gap-2 flex-wrap"><span class="field-hint">统计自进程启动累计，仅保存在内存中。</span><button class="btn btn-sm btn-ghost" data-action="reset-stats">' + icon('trash') + ' 重置统计</button></div></div></section>' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">快速入口</h2><p class="panel-sub">常用维护动作</p></div></div><div class="panel-body"><div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap"><button class="btn btn-sm" data-action="create-backup">' + icon('archive') + ' 立即备份</button><button class="btn btn-sm" data-action="command">' + icon('search') + ' 命令面板</button><button class="btn btn-sm" data-action="copy-endpoint">' + icon('copy') + ' 复制连接地址</button></div><div class="info-box mt-3">' + icon('spark') + '<span>上下文不会主动截断；配置的模型输出 Token 上限会校验，API 并发 / RPM 在各分组单独设置，0 为无上限。</span></div></div></section>' +
    '</div></div>';
}

function systemAdminLimitsPanel(setting) {
  const limits = { ...ADMIN_RATE_LIMIT_DEFAULTS, ...setting.rateLimits?.admin };
  const field = (name, label) => rateLimitField('admin.' + name, label, limits[name], 'system');
  return '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">WebUI / 管理限流</h2><p class="panel-sub">独立于分组 API；保存后立即热生效，无需重启。</p></div><span class="badge badge-green">热生效</span></div><div class="panel-body">' +
    '<form class="settings-form" data-form="settings-admin-limits"><div class="form-grid two">' +
    '<div class="field span-2"><label>管理 API · 全局</label><span class="field-hint">所有管理员请求共享管理全局预算；0 表示无上限。</span></div>' +
    field('maxConcurrent', '管理全局最大并发') + field('rpm', '管理全局 RPM（每 60 秒）') +
    '<div class="field span-2"><label>每来源</label><span class="field-hint">同一来源共享预算，包括同一 Tunnel 出口下的所有管理访问。</span></div>' +
    field('perIpMaxConcurrent', '每来源最大并发') + field('perIpRpm', '每来源 RPM（每 60 秒）') +
    '<div class="field span-2"><label>登录</label><span class="field-hint">单独限制登录请求，避免登录占满管理资源。</span></div>' +
    field('loginMaxConcurrent', '登录最大并发') + field('loginRpm', '登录 RPM（每 60 秒）') +
    '</div><div class="info-box mt-3">' + icon('alert') + '<span>RPM 是每 60 秒请求数；并发从请求进入到响应结束计数，包含 SSE 全生命周期。API 并发 / RPM 请在各上游分组中设置，同组所有 Key 共享。</span></div>' +
    '<div class="form-error" role="alert"></div><div class="form-actions"><button class="btn btn-primary" type="submit">' + icon('check') + ' 保存管理限流</button></div></form></div></section>';
}

function runtimeItem(label, value) {
  return '<div class="runtime-item"><span>' + esc(label) + '</span><b title="' + esc(value ?? '—') + '">' + esc(value ?? '—') + '</b></div>';
}

function systemBackupsTab() {
  const backups = app.data.backups || [];
  const rows = backups.map(function (backup) {
    return '<div class="backup-row"><code title="' + esc(backup.name) + '">' + esc(backup.name) + '</code><span class="size">' + fmtBytes(backup.size) + '</span><span class="time">' + fmtTime(backup.mtimeMs) + '</span><div class="card-actions"><a class="icon-btn" href="/api/backups/' + encodeURIComponent(backup.name) + '/download" title="下载完整备份">' + icon('download') + '</a><button class="icon-btn" data-action="restore-backup" data-name="' + esc(backup.name) + '" title="恢复此备份">' + icon('rotate') + '</button><button class="icon-btn" data-action="delete-backup" data-name="' + esc(backup.name) + '" title="删除备份">' + icon('trash') + '</button></div></div>';
  }).join('');
  return '<div class="settings-layout"><div class="settings-stack"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">配置备份</h2><p class="panel-sub">每次修改前自动创建；最多保留最近 40 份。</p></div><button class="btn btn-sm btn-primary" data-action="create-backup">' + icon('plus') + ' 立即备份</button></div><div class="panel-body">' + (rows ? '<div class="backup-list">' + rows + '</div>' : emptyState('还没有备份', '每次保存配置前都会自动备份。你也可以手动创建一份带标签的快照。', 'archive', '创建备份', 'create-backup')) + '</div></section></div><div class="settings-stack"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">备份说明</h2></div></div><div class="panel-body"><div class="warning-box">' + icon('alert') + '<span>备份文件包含完整上游密钥与虚拟 Key，权限为 0600。恢复会覆盖当前 config/local.json，并触发热重载；管理台登录密码不受影响。</span></div><div class="info-box mt-3">' + icon('archive') + '<span>下载的备份是完整 JSON，可手动放回 <code class="mono">config/local.json</code>。恢复前建议先手动创建一份当前状态备份。</span></div></div></section></div></div>';
}

function systemConfigTab() {
  return '<div class="settings-layout"><div class="settings-stack">' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">导入配置</h2><p class="panel-sub">粘贴完整 JSON，先校验再导入。导入会替换全部 groups 与全局参数。</p></div><span class="badge">JSON</span></div><div class="panel-body">' +
    '<div class="field"><div class="flex justify-between items-center gap-2"><label for="config-import">配置 JSON</label><label class="btn btn-sm btn-ghost" style="min-height:28px">' + icon('upload') + ' 选择文件<input type="file" accept=".json,application/json" data-file="config" hidden></label></div><textarea class="textarea import-area" id="config-import" spellcheck="false" placeholder=\'{\n  "host": "127.0.0.1",\n  "port": 8787,\n  "groups": [ ... ]\n}\'></textarea><span class="field-hint">当前配置文件路径：<code class="mono">' + esc(app.data.runtime?.configDisplay || 'config/local.json') + '</code>。导入前会自动备份旧配置。</span></div>' +
    '<div id="import-preview" class="hidden"></div><div class="form-error" id="import-error" role="alert"></div>' +
    '<div class="form-actions split"><span class="field-hint">支持环境变量引用：<code class="mono">{"env":"VAR"}</code></span><div class="panel-actions"><button class="btn btn-sm" data-action="validate-import">' + icon('check') + ' 校验配置</button><button class="btn btn-sm btn-primary" data-action="import-config">' + icon('upload') + ' 导入并热重载</button></div></div>' +
    '</div></section>' +
    '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">导出配置</h2><p class="panel-sub">脱敏版本适合分享；完整版本含真实密钥。</p></div></div><div class="panel-body"><div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap"><a class="btn" href="/api/config/export?mode=redacted&download=1">' + icon('download') + ' 下载脱敏配置</a><button class="btn btn-danger" data-action="export-config" data-mode="raw">' + icon('download') + ' 下载完整配置（含密钥）</button></div><div class="warning-box mt-3">' + icon('alert') + '<span>完整配置包含所有上游 API Key 和虚拟 Key。下载后请存放在加密磁盘，不要提交到 Git。</span></div></div></section></div>' +
    '<div class="settings-stack"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">配置结构速览</h2></div></div><div class="panel-body"><pre class="codeblock">' + esc('{\n  "host": "127.0.0.1",\n  "port": 8787,\n  "adminPort": 8788,\n  "groups": [{\n    "id": "provider-a",\n    "name": "Provider A",\n    "virtualApiKeys": ["mr-..."],\n    "upstreamApiKey": "sk-...",\n    "routes": {\n      "chat": { "baseURL": "https://.../v1", "auth": "bearer" }\n    },\n    "models": [{ "id": "model-id" }]\n  }]\n}') + '</pre><div class="info-box mt-3">' + icon('shield') + '<span>导入时会重新校验分组 ID、Key 唯一性、路由安全性和模型可用性；任何一项失败都不会写入磁盘。</span></div></div></section></div></div>';
}

const REQUEST_AUDIT_FIELDS = [
  ['requestIp', 'Request IP', true], ['inputTokens', 'Input Token', true],
  ['outputTokens', 'Output Token', true], ['systemPrompt', 'System Prompt', false],
  ['reasoningTokens', 'Reasoning Token', true], ['model', 'Model', true],
  ['group', 'Group', true], ['key', 'Key', false],
];

function requestAuditSettings() {
  const configured = app.data.settings?.audit || {};
  return {
    enabled: false, ipSource: 'cloudflare', trustedProxies: ['127.0.0.1', '::1'],
    maxEntries: 500, maxPromptChars: 16384, ...configured,
    fields: { ...Object.fromEntries(REQUEST_AUDIT_FIELDS.map(([name, , enabled]) => [name, enabled])), ...configured.fields },
  };
}

function requestAuditSettingsPanel(audit) {
  const switches = REQUEST_AUDIT_FIELDS.map(([name, label]) =>
    '<div class="field"><label class="switch"><input type="checkbox" name="fields.' + name + '" ' + (audit.fields[name] ? 'checked' : '') + '><span class="track"></span><span>' + label + '</span></label></div>').join('');
  return '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">请求审计设置</h2><p class="panel-sub">按需记录请求字段；保存后热生效，无需重启。</p></div></div><div class="panel-body">' +
    '<form class="settings-form" data-form="settings-audit"><div class="form-grid two">' +
    '<div class="field span-2"><label class="switch"><input type="checkbox" name="enabled" ' + (audit.enabled ? 'checked' : '') + '><span class="track"></span><span>启用请求审计</span></label></div>' + switches +
    '<div class="field"><label for="audit-ip-source">Request IP 来源</label><select class="select" id="audit-ip-source" name="ipSource">' +
    [['cloudflare', 'Cloudflare · CF-Connecting-IP（默认）'], ['socket', 'Socket · 直连地址'], ['x-forwarded-for', 'X-Forwarded-For']].map(([value, label]) => '<option value="' + value + '"' + (audit.ipSource === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="audit-trusted-proxies">可信代理 IP</label><textarea class="textarea" id="audit-trusted-proxies" name="trustedProxies" rows="3" spellcheck="false">' + esc(audit.trustedProxies.join('\n')) + '</textarea><span class="field-hint">换行或逗号分隔的精确 IP；不接受 CIDR、主机名或通配符。</span></div>' +
    '<div class="field"><label for="audit-max-entries">内存最多保留条数</label><input class="input" id="audit-max-entries" name="maxEntries" type="number" min="1" max="2000" step="1" value="' + esc(audit.maxEntries) + '" required></div>' +
    '<div class="field"><label for="audit-max-prompt-chars">System Prompt 最大字符数</label><input class="input" id="audit-max-prompt-chars" name="maxPromptChars" type="number" min="1" max="65536" step="1" value="' + esc(audit.maxPromptChars) + '" required></div>' +
    '</div><div class="info-box mt-3">' + icon('shield') + '<span>仅信任 socket 直连对端位于可信代理列表时提供的来源头。Cloudflare Tunnel 在本机运行时通常使用回环地址 127.0.0.1 / ::1；不要把客户端 IP 当作可信代理。关闭 Request IP 后不再按 IP 分组。</span></div>' +
    '<div class="warning-box mt-3">' + icon('alert') + '<span>Key 仅记录指纹，绝不记录原始密钥。System Prompt 可能含敏感信息，默认关闭。缺失 usage 显示 —，不当作 0。内存日志重启后清空；同时输出 stdout JSON audit，供 service 日志收集。关闭字段会从历史内存记录中移除该字段，但已输出的日志不会被追溯删除。</span></div>' +
    '<div class="form-error" role="alert"></div><div class="form-actions"><button class="btn btn-primary" type="submit">' + icon('check') + ' 保存请求审计</button></div></form></div></section>';
}

function requestAuditTable(entries, fields) {
  const optional = REQUEST_AUDIT_FIELDS.filter(([name]) => fields[name]);
  const headers = ['时间', 'Request ID', '方法', '协议', '状态', '结果', '耗时'].concat(optional.map(([, label]) => label));
  const cell = value => '<td>' + esc(value ?? '—') + '</td>';
  const rows = entries.map(entry => {
    const base = [fmtTime(entry.time), entry.requestId, entry.method, entry.protocol, entry.status, entry.outcome, entry.durationMs == null ? '—' : fmtMs(entry.durationMs)];
    return '<tr>' + base.map(cell).join('') + optional.map(([name]) => {
      if (name === 'systemPrompt' && entry[name] != null) {
        return '<td><details><summary>System Prompt</summary><pre class="codeblock">' + esc(entry[name]) + '</pre></details></td>';
      }
      return cell(entry[name]);
    }).join('') + '</tr>';
  }).join('');
  return '<div class="table-wrap"><table class="data-table"><thead><tr>' + headers.map(label => '<th>' + label + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function requestAuditPanel(audit) {
  const snapshot = app.data.requestAudit || {};
  const entries = snapshot.entries || [];
  let body;
  if (!entries.length) body = emptyState('暂无请求审计', audit.enabled ? '新请求完成后将出现在这里。' : '启用请求审计后开始记录。', 'clock');
  else if (!audit.fields.requestIp) body = requestAuditTable(entries, audit.fields);
  else {
    const groups = new Map();
    const totals = new Map((snapshot.byIp || []).map(item => [item.ip, item]));
    for (const entry of entries) {
      const ip = entry.requestIp ?? null;
      if (!groups.has(ip)) groups.set(ip, []);
      groups.get(ip).push(entry);
    }
    body = [...groups].map(([ip, items]) => {
      const counts = totals.get(ip);
      const errors = counts?.errors ?? items.filter(entry => Number(entry.status) >= 400 || entry.outcome === 'error').length;
      return '<details class="panel" data-audit-ip="' + esc(ip ?? '') + '" open><summary class="panel-head"><span class="mono">' + esc(ip ?? '未记录 IP') + '</span><span class="badge">' + esc(counts?.requests ?? items.length) + ' 请求 · ' + esc(errors) + ' 错误</span></summary><div class="panel-body">' + requestAuditTable(items, audit.fields) + '</div></details>';
    }).join('');
  }
  return '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">请求审计</h2><p class="panel-sub">' + (audit.fields.requestIp ? '按 Request IP 分类；展开查看请求详情。' : 'Request IP 已关闭；按请求显示，不进行 IP 分组。') + ' 点击刷新获取最新记录，未保存的设置会保留。</p></div><div class="panel-actions"><span class="badge">' + esc(snapshot.total ?? entries.length) + ' 条</span><button class="btn btn-sm" type="button" data-action="refresh">' + icon('refresh') + ' 刷新记录</button></div></div><div class="panel-body">' + body + '</div></section>';
}

function systemAuditTab() {
  const audit = app.data.recentAudit || [];
  const rows = audit.map(function (entry) {
    return '<div class="audit-row"><time>' + fmtTime(entry.time) + '</time><span class="audit-action">' + esc(AUDIT_LABELS[entry.action] || entry.action) + '</span><span class="audit-target" title="' + esc(entry.target || '') + '">' + esc(entry.target || '—') + '</span><span class="audit-result">' + (entry.ok ? '<span class="badge badge-green">成功</span>' : '<span class="badge badge-red">失败</span>') + '</span></div>';
  }).join('');
  const requestSettings = requestAuditSettings();
  return '<div class="settings-stack">' + requestAuditSettingsPanel(requestSettings) + requestAuditPanel(requestSettings) + '<section class="panel"><div class="panel-head"><div><h2 class="panel-title">管理动作审计日志</h2><p class="panel-sub">最近 250 条管理动作，仅保存在内存中，重启后清空。</p></div><span class="badge">' + icon('clock') + ' ' + audit.length + ' 条</span></div><div class="panel-body">' + (rows ? '<div class="audit-list">' + rows + '</div>' : emptyState('暂无审计记录', '登录、修改分组、轮换 Key 等动作会出现在这里。', 'clock')) + '</div></section></div>';
}

export { renderSystemPage, systemGeneralTab, runtimeItem, systemBackupsTab, systemConfigTab, systemAuditTab };
