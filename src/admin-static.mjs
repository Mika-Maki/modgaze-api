import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { httpError } from './admin-store.mjs';
import { sendText } from './admin-http.mjs';

export function createStaticHandler({ publicDir, version, currentAdminPort }) {
  async function readStatic(file, asset = false) {
    const root = await realpath(publicDir);
    const target = await realpath(resolve(publicDir, file));
    if (target !== root && !target.startsWith(root + sep)) throw httpError(404, '页面不存在');
    if (asset) {
      const assetRoot = await realpath(join(publicDir, 'assets'));
      if (!assetRoot.startsWith(root + sep) || !target.startsWith(assetRoot + sep)) throw httpError(404, '页面不存在');
    }
    return await readFile(target, 'utf8');
  }

  return async function serveStatic(req, res, path) {
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const files = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/assets/app.js': ['assets/app.js', 'text/javascript; charset=utf-8'],
      '/assets/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    };
    const entry = files[path];
    if (!entry && path.startsWith('/assets/')) {
      const relativePath = path.slice('/assets/'.length);
      const segments = relativePath.split('/');
      if (!relativePath || relativePath.includes('\\') || segments.some(segment => !segment || segment === '..' || segment === '.') || !/\.(?:js|css)$/i.test(relativePath)) {
        throw httpError(404, '页面不存在');
      }
      const assetRoot = resolve(publicDir, 'assets');
      const assetPath = resolve(assetRoot, relativePath);
      if (assetPath !== assetRoot && !assetPath.startsWith(assetRoot + sep)) throw httpError(404, '页面不存在');
      const type = /\.css$/i.test(relativePath) ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      const content = await readStatic(join('assets', relativePath), true);
      sendText(res, 200, content, type, { 'cache-control': 'no-store' });
      return;
    }
    if (!entry) throw httpError(404, '页面不存在');
    const [file, type] = entry;
    let content;
    if (file === 'index.html') {
      content = await readStatic(file);
      if (!content) throw httpError(500, 'Web UI 资源缺失，请检查 public/index.html');
      content = content.replaceAll('%APP_VERSION%', version).replaceAll('%ADMIN_PORT%', String(currentAdminPort()));
      res.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; form-action 'self'");
      res.setHeader('x-frame-options', 'DENY');
    }
    content = file === 'index.html' ? content : await readStatic(file, file.startsWith('assets/'));
    sendText(res, 200, content, type, { 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
  };
}
