# 后端 HTTPS

API TLS：**https://127.0.0.1:8786**（OpenAI base URL 使用 /v1）。WebUI TLS：**https://127.0.0.1:8789**。两个 TLS 监听均为 0.0.0.0，旧 API HTTP 8787 保留，管理 HTTP 8788 也监听 0.0.0.0；旧 TLS 8443 已停用。HTTPS 与 HTTP 共用路由、虚拟 key、脱敏、流式响应和热加载状态；未修改前端页面、现有密码或 API key。

## 验证与客户端信任

本地 CA 为 config/tls/ca.crt，签发 localhost、127.0.0.1、::1 的服务器证书。CA 未自动加入系统或浏览器信任。TLS 监听所有 IPv4 接口，但使用其他 IP/域名访问仍须配置覆盖该名称的证书。

~~~bash
cd /root/amerge
curl --cacert config/tls/ca.crt https://127.0.0.1:8786/healthz
# OpenAI SDK 的 base_url：https://127.0.0.1:8786/v1
# Anthropic SDK 的 base_url：https://127.0.0.1:8786
# Node 客户端启动时可显式信任本地 CA：
NODE_EXTRA_CA_CERTS=/root/amerge/config/tls/ca.crt node your-client.mjs
~~~

浏览器需在客户端系统/浏览器中信任 ca.crt；只分发公有 CA 证书，不分发 ca.key 或 server.key。不要用关闭 TLS 验证代替配置 CA。若 WebUI 与 API 跨 Origin，HTTPS 不会自动赋予 CORS 权限；本次仅调整 WebUI 后端 TLS、同源校验及安全会话 cookie，未开放跨域策略。

## 配置与正式证书

config/local.json 中 `adminHost: "0.0.0.0"` 控制原 HTTP 管理端口（默认 8788）的监听地址；自定义域名可通过 `adminAllowedHosts` 配置，IP 访问自动允许当前连接的本机地址。仍保留密码和同源/CSRF 校验。

TLS 配置：

~~~json
"https": {
  "host": "0.0.0.0",
  "port": 8786,
  "keyFile": "tls/server.key",
  "certFile": "tls/server.crt"
},
"adminHttps": {
  "host": "0.0.0.0",
  "port": 8789,
  "keyFile": "tls/server.key",
  "certFile": "tls/server.crt",
  "allowedHosts": []
}
~~~

相对证书路径以配置文件所在目录为准。可换为已有域名证书的私钥和 fullchain 绝对路径；端口、绑定地址或证书修改后执行 npm run check && npm run service:restart。配置 https:false 或 enabled:false 关闭此监听。TLS 最低 1.2。私钥必须是 0600，目录建议 0700；启动前检查密钥、证书匹配和端口冲突，TLS 配置无效不会静默降为 HTTP。

本地初始化命令 npm run tls:init 只在无现有 HTTPS 配置、无证书文件时执行，拒绝覆盖证书。服务器证书有效期 365 天，CA 有效期 3650 天；没有配置自动续期。正式公网证书需要实际域名和相应签发/续期流程，本地 CA 不等同于公网信任证书。

证书文件位于已忽略的 config/tls/ 下，不包含在代码提交中。HTTPS API 鉴权仍使用原虚拟 key，无需新 key；未改变上游 URL 或凭证配置。

## WebUI TLS 登录

8789 使用现有管理员密码；TLS 会话 cookie 独立于 HTTP，含 Secure、HttpOnly、SameSite=Strict，不能在 HTTP 端口重放。HTTPS Origin 必须与当前 Host 完全匹配，保留 CSRF 校验。使用自定义域名时，把无协议、无端口的域名填入 adminHttps.allowedHosts，同时提供覆盖该域名的证书。首次管理员密码设置仅允许从服务器本机进行，已设置的密码不变。
