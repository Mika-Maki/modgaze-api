# HTTPS / TLS 配置教程

[← 返回 README](../README.md)

Modgaze 的 HTTPS 是可选的两组监听：API TLS 默认 `https://127.0.0.1:8786`（OpenAI base URL 用 `https://127.0.0.1:8786/v1`），管理台 TLS 默认 `https://127.0.0.1:8789`。HTTP 的 8787（API）和 8788（管理台）同时保留；TLS 与 HTTP 共用同一份路由、虚拟 key、脱敏、流式响应和热加载状态。

证书私钥只保存在本机 `config/tls/`（已在 `.gitignore` 中），不要提交或外传。

## 1. 生成证书

需要本机有 `openssl`：

```bash
cd /root/amerge
npm run tls:init
```

它会在 `config/tls/` 生成：

- `ca.key` / `ca.crt`：本地 CA（RSA 3072，有效期 3650 天）。
- `server.key` / `server.crt`：服务器证书（RSA 2048，有效期 365 天），签发给 `localhost`、`127.0.0.1`、`::1`。
- `server.csr` / `extensions.cnf`：签发过程文件。

同时把默认的 `https`（8786）与 `adminHttps`（8789）写进 `config/local.json`。以下情况命令会拒绝执行，避免覆盖：

- 配置里已有 `https` 或 `adminHttps`；
- `config/tls/` 下已有证书文件。

没有自动续期；到期后删除旧证书文件重新执行，或换用正式证书。

## 2. 配置监听

`config/local.json` 中的两个段：

```json
"https": {
  "host": "127.0.0.1",
  "port": 8786,
  "keyFile": "tls/server.key",
  "certFile": "tls/server.crt"
},
"adminHttps": {
  "host": "127.0.0.1",
  "port": 8789,
  "keyFile": "tls/server.key",
  "certFile": "tls/server.crt",
  "allowedHosts": []
}
```

- 证书相对路径以配置文件所在目录（`config/`）为准，也可填绝对路径。
- 需要局域网访问时把 `host` 改成 `0.0.0.0`，并自行限制防火墙；默认只监听回环。
- `https: false`、`adminHttps: false` 或段内 `enabled: false` 关闭对应监听。
- 私钥必须 0600，目录建议 0700；TLS 最低 1.2。
- 启动时会检查证书与私钥是否匹配、端口是否冲突；配置无效直接报错，不会静默退回 HTTP。
- 改端口、绑定地址或证书后必须重启进程（`npm run service:restart`），热重载不会重建监听。

## 3. 校验并重启

```bash
cd /root/amerge
npm run check
npm run service:restart        # 前台运行时直接 npm start
curl --cacert config/tls/ca.crt https://127.0.0.1:8786/healthz
```

启动成功后日志里会分别出现 `https_listening` 和 `admin_https_listening` 事件。

## 4. 客户端信任本地 CA

本地 CA 不会自动进入系统或浏览器信任库。

```bash
# curl
curl --cacert /root/amerge/config/tls/ca.crt https://127.0.0.1:8786/v1/models \
  -H "Authorization: Bearer <key>"

# Node 客户端
NODE_EXTRA_CA_CERTS=/root/amerge/config/tls/ca.crt node your-client.mjs
```

- OpenAI SDK：base_url = `https://127.0.0.1:8786/v1`
- Anthropic SDK：base_url = `https://127.0.0.1:8786`
- 浏览器访问 WebUI TLS：先在本机系统/浏览器信任 `ca.crt`。
- 只分发 `ca.crt`；不要分发 `ca.key` 或 `server.key`。
- 不要用关闭 TLS 校验代替信任本地 CA。
- 用其他 IP 或域名访问时，证书必须覆盖该名称；默认证书只覆盖 localhost / 127.0.0.1 / ::1。
- HTTPS 不会自动开放 CORS；跨 Origin 访问仍需自行处理同源策略。

## 5. 管理台 TLS（8789）

- 使用现有管理员密码登录，不需要新密码；首次设置密码仍只允许从服务器本机进行。
- TLS 会话 Cookie 独立于 HTTP，带 `Secure`、`HttpOnly`、`SameSite=Strict`，不能在 HTTP 端口重放。
- HTTPS 请求的 Origin 必须与当前 Host 完全匹配，CSRF 校验保留。
- 使用自定义域名时，把无协议、无端口的域名填入 `adminHttps.allowedHosts`，并确保证书覆盖该域名。
- HTTP 管理端口 8788 的监听地址由 `adminHost` 控制；自定义域名可通过 `adminAllowedHosts` 放行，IP 访问自动允许当前连接的本机地址。

## 6. 使用正式证书

- 把 `keyFile` / `certFile` 换成域名证书的私钥和 fullchain（建议绝对路径）。
- 证书须由客户端信任的 CA 签发；本地 CA 不等同于公网可信证书。
- 公网使用需要真实域名和相应的签发/续期流程。
- 换证书后执行 `npm run check && npm run service:restart`。

## 7. 排错

| 现象 | 检查 |
| --- | --- |
| 启动报端口占用 | 8786 / 8789 是否被其他进程或另一个 Modgaze 实例占用 |
| 启动报证书错误 | `keyFile` / `certFile` 路径、私钥权限（0600）、证书与私钥是否匹配 |
| 客户端提示证书不受信任 | 是否用 `--cacert` 或 `NODE_EXTRA_CA_CERTS` 指定了 `config/tls/ca.crt` |
| 域名访问证书不匹配 | 证书是否覆盖该域名；`adminHttps.allowedHosts` 是否填写 |
| 只想用 HTTP | 关闭或删除 `https` / `adminHttps` 段后重启 |

## 8. 与旧端口的关系

早期的 8443 TLS 监听已停用；本教程统一使用 API 8786、管理台 8789。HTTP 8787 / 8788 不受影响，API 鉴权继续使用原有虚拟 key，上游 URL 与凭证配置不需要改动。
