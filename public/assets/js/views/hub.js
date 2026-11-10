/* Modgaze — radial control hub markup. */
import { $, icon, esc, fmtNum, fmtPercent, app } from "../core.js";
import { eyeMarkup } from "../eye.js";
import { initOrbit } from "../orbit.js";
import { beginCrt } from "../crt.js";

function card(options) {
  return '<a class="orbit-card" href="' + options.href + '" data-module="' + options.module + '" data-orbit="' + options.orbit + '" data-action="enter-module" data-href="' + options.href + '" style="--i:' + options.index + '" aria-label="' + esc(options.title) + '">' +
    '<span class="orbit-notch" aria-hidden="true"></span>' +
    '<span class="orbit-sheen" aria-hidden="true"></span>' +
    '<div class="orbit-head">' +
      '<span class="orbit-index">' + String(options.number).padStart(2, '0') + '</span>' +
      '<span class="orbit-sigil">' + icon(options.icon) + '</span>' +
    '</div>' +
    '<div class="orbit-copy">' +
      '<span class="orbit-kicker">' + esc(options.kicker) + '</span>' +
      '<h2>' + esc(options.title) + '</h2>' +
      '<p>' + esc(options.description) + '</p>' +
    '</div>' +
    '<div class="orbit-foot">' +
      '<span class="orbit-metric"><b>' + esc(options.metric) + '</b><small>' + esc(options.unit) + '</small></span>' +
      '<span class="orbit-sub">' + options.sub + '</span>' +
      '<span class="orbit-arrow">' + icon('arrow-up-right') + '</span>' +
    '</div>' +
  '</a>';
}

function renderHub() {
  const data = app.data || {};
  const stats = app.stats || data.stats || {};
  const summaryData = data.summary || {};
  const groups = data.groups || [];
  const service = data.service || {};
  const runtime = data.runtime || {};
  const models = summaryData.models || groups.reduce(function (total, group) { return total + (group.models || []).length; }, 0);
  const activeGroups = summaryData.activeGroups ?? groups.filter(function (group) { return group.enabled; }).length;
  const virtualKeys = summaryData.virtualKeys || 0;
  const apiKeys = summaryData.apiKeys || 0;
  const protocols = (summaryData.protocols || []).length;
  const backups = (data.backups || []).length;
  const audit = (data.recentAudit || []).length;
  const healthy = Boolean(service.running) && !app.offline;
  const requests = fmtNum(stats.requests || 0);
  const errorRate = fmtPercent(stats.errorRate || 0);
  const routerPort = runtime.routerPort ?? data.settings?.port ?? 8787;
  const adminPort = runtime.adminPort ?? 8788;
  const cards = [
    {
      module: 'groups', orbit: 'tl', index: 0, number: 1, href: '#/groups', icon: 'groups',
      kicker: 'UPSTREAM CHOIRS', title: '上游分组',
      description: models + ' 个模型沿 ' + groups.length + ' 条血脉接入。',
      metric: String(groups.length), unit: '组',
      sub: '<i class="orbit-live-dot"></i>' + activeGroups + ' 在线 · ' + fmtNum(models) + ' models',
    },
    {
      module: 'keys', orbit: 'tr', index: 1, number: 2, href: '#/keys', icon: 'key',
      kicker: 'MORTAL KEYS', title: '本地密钥',
      description: '客户端只携带本地凭据，真实上游 Key 留在暗处。',
      metric: String(virtualKeys), unit: '枚',
      sub: virtualKeys + ' 虚拟 · ' + apiKeys + ' 直通 · ' + protocols + ' 协议',
    },
    {
      module: 'system', orbit: 'br', index: 2, number: 3, href: '#/system/general', icon: 'settings',
      kicker: 'RITUAL PARAMETERS', title: '系统设置',
      description: '监听、超时与请求上限。每一次保存都留下备份。',
      metric: String(routerPort), unit: 'port',
      sub: 'ADMIN ' + adminPort + ' · v' + esc(data.version || '1.1.0'),
    },
    {
      module: 'vault', orbit: 'bl', index: 3, number: 4, href: '#/system/backups', icon: 'archive',
      kicker: 'MEMORY VAULT', title: '备份与审计',
      description: '可回滚的配置切片，以及每一次操作的记忆。',
      metric: String(backups), unit: '份',
      sub: audit + ' 条审计 · 本地加密',
    },
  ];
  return '<section id="hub-stage" class="hub-stage' + (healthy ? ' is-healthy' : ' is-dormant') + '" aria-label="Modgaze 控制中枢">' +
    '<div class="hub-aura" aria-hidden="true"><i></i><i></i><i></i></div>' +
    '<div class="crt-overlay" aria-hidden="true"><div class="crt-amber"></div><div class="crt-lines"></div></div>' +
    '<div class="hub-axis" aria-hidden="true"><span class="hub-axis-line"></span><span class="hub-axis-label">ABYSSAL CORE / 01</span></div>' +
    '<div id="hub-eye" class="hub-eye">' +
      '<div class="eye-shell">' + eyeMarkup('core') + eyeMarkup('final', { init: false }) + '<span class="eye-grain" aria-hidden="true"></span>' +
        '<div class="hub-init-readout" aria-hidden="true">' +
          '<span style="--n:0"><em>MODGAZE</em><b>INIT</b></span>' +
          '<span style="--n:1"><em>DISPLAY BUFFER</em><b>OK</b></span>' +
          '<span style="--n:2"><em>CORE GEOMETRY</em><b>INIT</b></span>' +
        '</div>' +
      '</div>' +
      '<div class="eye-caption">' +
        '<span class="eye-kicker">THE WATCHER</span><span class="eye-rule"></span><span class="eye-status"><i></i>' + (healthy ? 'AWAKE' : 'DORMANT') + '</span>' +
      '</div>' +
    '</div>' +
    '<svg id="hub-synapses" class="hub-synapses" aria-hidden="true"></svg>' +
    '<div class="hub-cards">' + cards.map(card).join('') + '</div>' +
    '<div class="hub-readout" aria-hidden="true"><span>MOVE TO TRACK</span><i></i><span>CLICK TO CONTRACT</span></div>' +
    '<div class="hub-dock">' +
      '<button id="endpoint-chip" class="endpoint-chip hub-endpoint" data-action="copy-endpoint" title="复制兼容 OpenAI 的本地 Base URL">' +
        '<span class="endpoint-dot"></span><span class="endpoint-text">127.0.0.1:' + routerPort + '</span>' + icon('copy', 'tiny') +
      '</button>' +
      '<div class="hub-dock-copy"><span class="hub-dock-kicker">LIVE CORTEX</span><b data-hub-requests>' + requests + '</b><span>次请求</span><em data-hub-errors>' + errorRate + ' errors</em></div>' +
      '<div class="hub-dock-meta"><span class="hub-nocturne">LOCAL ONLY · NO TELEMETRY</span><span id="sidebar-version">v' + esc(data.version || '1.1.0') + '</span></div>' +
    '</div>' +
  '</section>';
}

function mountHub() {
  const stage = $('#hub-stage');
  if (!stage) return;
  // Claim the stage before the first layout pass so the eye, the cards and the
  // chrome are never painted in their finished state by accident.
  beginCrt(stage);
  initOrbit(stage);
}

export { renderHub, mountHub };
