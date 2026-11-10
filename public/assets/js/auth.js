import { $, $$, icon, esc, PROTOCOLS, PROTOCOL_LABEL, PROTOCOL_AUTH, AUDIT_LABELS, app, nf, fmtNum, fmtMs, fmtBytes, fmtPercent, fmtDuration, fmtTime, timeAgo, statusClass, protoBadge, protoBadges, groupAccent, routerBase, routerV1, findGroup, findKey, groupRequestStats, summary, settings, runtime, api, applyTheme, toggleTheme, updateChrome, setUnauthorizedHandler, emptyState, toast, dismissToast, openModal, closeModal, confirmModal, showTestResult, setTestLoading, copyToClipboard, copyEndpoint, downloadText, applyKeyReveals } from "./core.js";
import { startPolling, stopPolling, loadState } from "./data.js";
import { standDownCrt, primeCrt } from "./crt.js";

const CARD_HEAD = '<div class="auth-card-head"><span>MODGAZE://LOCAL</span><span class="auth-card-led"><i></i>LINK</span></div>';

function showAuth(mode = 'login', options = {}) {
  app.authenticated = false;
  app.csrf = null;
  stopPolling();
  standDownCrt();
  $('#app').classList.add('hidden');
  const auth = $('#auth-screen');
  auth.classList.add('is-powered');
  auth.classList.remove('hidden');
  const card = $('#auth-card');
  const resetHint = $('#auth-reset-hint');
  // The reset command stays folded away until the operator asks for it.
  resetHint.classList.add('hidden');
  if (mode === 'setup') {
    card.innerHTML = `
      ${CARD_HEAD}
      <div class="auth-kicker"><i></i>FIRST-RUN SETUP</div>
      <h2 class="auth-title">建立第一枚凭证</h2>
      <p class="auth-sub">这是第一次打开控制台。密码以 scrypt + 随机盐哈希后写入本地，控制台永远不会储存明文。</p>
      <form class="auth-form" data-form="auth-setup">
        <div class="field">
          <label for="auth-password"><span class="field-tag">PASSPHRASE</span>管理员密码 <span class="req">*</span></label>
          <div class="input-wrap">
            <span class="input-prompt" aria-hidden="true">&gt;</span>
            <input class="input" id="auth-password" name="password" type="password" autocomplete="new-password" minlength="10" required placeholder="至少 10 个字符，建议 16 位以上">
            <button class="icon-btn" type="button" data-action="toggle-password" data-target="auth-password" aria-label="显示密码">${icon('eye')}</button>
          </div>
          <div class="strength" id="strength-meter"><span></span><span></span><span></span><span></span></div>
          <div class="field-hint" id="strength-label">使用长密码或三组以上随机词。</div>
        </div>
        <div class="field">
          <label for="auth-confirm"><span class="field-tag">CONFIRM</span>确认密码 <span class="req">*</span></label>
          <div class="input-wrap">
            <span class="input-prompt" aria-hidden="true">&gt;</span>
            <input class="input" id="auth-confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required placeholder="再输入一次">
            <button class="icon-btn" type="button" data-action="toggle-password" data-target="auth-confirm" aria-label="显示密码">${icon('eye')}</button>
          </div>
        </div>
        <div class="form-error" role="alert"></div>
        <button class="btn auth-submit" type="submit">${icon('shield')} 启用控制台</button>
        <div class="auth-meta"><span>密码只用于本机登录，不会发送到任何上游。</span><span>LOCAL</span></div>
      </form>`;
  } else if (options.broken) {
    card.innerHTML = `
      ${CARD_HEAD}
      <div class="auth-alert-icon">${icon('alert')}</div>
      <div class="auth-kicker"><i></i>AUTHENTICATION</div>
      <h2 class="auth-title">管理员密码文件异常</h2>
      <p class="auth-sub">${esc(options.message || '无法读取本地管理员密码文件。')}</p>
      <div class="info-box">${icon('terminal')}<span>在服务器终端运行 <code>npm run admin:password</code> 重新设置密码。该命令只写入加盐哈希，不会显示明文。</span></div>
    `;
  } else if (options.network) {
    card.innerHTML = `
      ${CARD_HEAD}
      <div class="auth-alert-icon">${icon('alert')}</div>
      <div class="auth-kicker"><i></i>CONNECTION</div>
      <h2 class="auth-title">无法连接管理台</h2>
      <p class="auth-sub">${esc(options.message || '管理服务尚未启动或端口未开放。')}</p>
      <button class="btn auth-submit" data-action="retry-boot">${icon('refresh')} 重新连接</button>
    `;
  } else {
    card.innerHTML = `
      ${CARD_HEAD}
      <div class="auth-kicker"><i></i>ACCESS TERMINAL</div>
      <h2 class="auth-title">控制台接入</h2>
      <p class="auth-sub">输入管理员密码以打开本地控制面。会话保存在 HttpOnly Cookie 中，写操作附带 CSRF 令牌。</p>
      <form class="auth-form" data-form="auth-login">
        <div class="field">
          <label for="auth-password"><span class="field-tag">PASSPHRASE</span>管理员密码</label>
          <div class="input-wrap">
            <span class="input-prompt" aria-hidden="true">&gt;</span>
            <input class="input" id="auth-password" name="password" type="password" autocomplete="current-password" required autofocus placeholder="输入管理员密码">
            <button class="icon-btn" type="button" data-action="toggle-password" data-target="auth-password" aria-label="显示密码">${icon('eye')}</button>
          </div>
        </div>
        <div class="form-error" role="alert"></div>
        <button class="btn auth-submit" type="submit">${icon('key')} 认证</button>
        <div class="auth-meta"><span>本地会话 · 12 小时绝对过期</span><button type="button" data-action="show-reset-help">忘记密码？</button></div>
      </form>`;
  }
  setTimeout(() => $('#auth-password')?.focus(), 120);
}
function sessionExpired() {
  if (!app.authenticated) return;
  app.authenticated = false;
  app.csrf = null;
  stopPolling();
  $('#app').classList.add('hidden');
  showAuth('login');
  toast('登录状态已失效，请重新登录', 'info');
}
async function bootAuth() {
  $('#auth-screen')?.classList.remove('is-powered');
  try {
    const status = await api('/api/auth/status', { csrf: false });
    app.auth = status;
    if (status.error) { showAuth('login', { broken: true, message: status.error }); return; }
    if (!status.configured) { showAuth('setup'); return; }
    if (status.authenticated) { app.csrf = status.csrfToken; await enterApp(); }
    else { showAuth('login'); }
  } catch (error) {
    showAuth('login', { network: true, message: error.message });
  }
}
async function enterApp({ verifySession = false } = {}) {
  if (verifySession) {
    // A 200 login response only proves the password was accepted. Confirm that
    // the browser/proxy actually returned the HttpOnly session cookie before
    // showing the app or starting requests that would immediately return 401.
    const status = await api('/api/auth/status', { csrf: false });
    if (!status?.authenticated) {
      app.csrf = null;
      const error = new Error('登录 Cookie 未能保存或随请求返回。请允许本站使用 Cookie，并检查浏览器或代理的 Cookie 过滤，重新加载后再登录。');
      error.code = 'session_cookie_missing';
      throw error;
    }
    app.auth = status;
    app.csrf = status.csrfToken;
  }
  app.authenticated = true;
  $('#auth-screen').classList.add('hidden');
  $('#auth-screen').classList.remove('is-powered');
  primeCrt({ restart: true });
  $('#app').classList.remove('hidden');
  startPolling();
  await loadState();
}
export { showAuth, sessionExpired, bootAuth, enterApp };
