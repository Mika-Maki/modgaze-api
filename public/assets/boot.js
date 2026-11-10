/* Keep startup feedback outside the application module graph: one missing
   dependency must not leave both the authentication screen and app invisible. */
(function () {
  const BOOT_TIMEOUT_MS = 15000;
  const status = document.querySelector('#boot-status');
  const title = document.querySelector('#boot-title');
  const message = document.querySelector('#boot-message');
  const detail = document.querySelector('#boot-detail');
  let phase = 'modules';

  function showFailure(timedOut, error) {
    // The normal auth/error view has replaced this panel, or the app is already
    // visible. Never cover a working view with a stale startup timeout.
    if (!status || !status.isConnected || document.querySelector('#auth-screen').classList.contains('hidden')) return;
    status.dataset.state = timedOut ? 'timeout' : 'failed';
    status.dataset.phase = phase;
    title.textContent = timedOut ? '控制台加载超时' : '控制台启动失败';
    message.textContent = phase === 'modules'
      ? '界面资源未能加载完成，请查看错误详情后重新加载。'
      : '控制台初始化未能完成，请查看错误详情后重新加载。';
    const code = timedOut ? 'BOOT_TIMEOUT' : phase === 'modules' ? 'BOOT_MODULE' : 'BOOT_INIT';
    status.dataset.code = code;
    if (detail) {
      const reason = error ? String(error.name || 'Error') + ': ' + String(error.message || error) : '等待 ' + phase + ' 阶段超过 15 秒';
      detail.textContent = code + ' [' + phase + '] ' + reason.slice(0, 400);
      detail.classList.remove('hidden');
    }
    console.error('[Modgaze boot]', phase, error || 'startup timeout');
  }

  const watchdog = window.setTimeout(function () { showFailure(true); }, BOOT_TIMEOUT_MS);
  import('./app.js')
    .then(function (app) {
      phase = 'session';
      return app.init();
    })
    .then(function () {
      window.clearTimeout(watchdog);
    }, function (error) {
      window.clearTimeout(watchdog);
      showFailure(false, error);
    });
})();
