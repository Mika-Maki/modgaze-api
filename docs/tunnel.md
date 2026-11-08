# Cloudflare Tunnel：API 与可选 WebUI

[← 返回 README](../README.md)

默认只发布 **API 8787**。若需发布 WebUI，按下方“可选 WebUI 域名”配置显式公网来源；不需要关闭 Host、Origin 或登录校验。

## 1. 一键启动（named tunnel）

前提：

- 域名已接入 Cloudflare（NS 已指向 Cloudflare）
- 已创建 tunnel，token 在 `/etc/cloudflared/token`（0600）
- Dashboard 里已有 Public Hostname：`api.<域名>` → **http://127.0.0.1:8787**
- 该主机名有 CNAME 指向 `<tunnel-id>.cfargotunnel.com`（Proxied / 橙色云）

```bash
cd modgaze-api
./tunnelup.sh start     # 启动 Modgaze + cloudflared named tunnel
./tunnelup.sh status
./tunnelup.sh url       # 优先 TUNNEL_HOST，其次本地域名文件
./tunnelup.sh stop
```

脚本默认使用 `config/local.json`；可用 `MODGAZE_CONFIG` 覆盖。仓库中的 `cf/tunnel.host` 只保留 `api.example.com` 示例。真实域名写入 `cf/tunnel.host.private`（一行，权限 0600，Git 忽略），或通过 `TUNNEL_HOST` 设置；`TUNNEL_HOST_FILE` 可指定其它本地文件。脚本优先使用私有文件，缺少私有文件时才读取示例。不要把真实域名、hosts 映射、Tunnel token、证书或本地日志提交到仓库。

```bash
cp cf/tunnel.host cf/tunnel.host.private
chmod 600 cf/tunnel.host.private
# 编辑 cf/tunnel.host.private，将示例换成自己的域名
```

## 2. Dashboard 两项必须正确

**Public Hostname 的 Service 必须是 HTTP：**

```text
http://127.0.0.1:8787
```

写成 `https://localhost:8787` 会 502 —— 8787 是明文 HTTP，TLS 在 Cloudflare 边缘终止。

**DNS 记录：**

| 类型 | 名称 | 目标 | 代理 |
| --- | --- | --- | --- |
| CNAME | `api` | `<tunnel-id>.cfargotunnel.com` | Proxied（橙色云） |

`<tunnel-id>` 就是 tunnel UUID（token 里的 `t` 字段，或 Dashboard 的 Tunnel 详情页）。没有这条记录，`api.<域名>` 会 NXDOMAIN，浏览器可能报 TLS 类错误。

## 3. 无域名 quick tunnel（可选）

```bash
cf/quick.sh start
cf/quick.sh url
cf/quick.sh stop
```

地址形如 `https://<随机名>.trycloudflare.com`，每次重连都变；只适合临时测试。

## 4. Clash fake-ip 的坑

本机若运行 Clash TUN（fake-ip 模式），`*.v2.argotunnel.com` 会被解析成 `198.18.x.x`，cloudflared 的 pre-check 能过但注册后被 edge 断开。两种修法：

1. 推荐：在 Clash 的 `fake-ip-filter` 里加 `+.argotunnel.com`，重启 Clash；
2. 或把真实 edge IP 写进 `/etc/hosts`：

```bash
curl -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=region1.v2.argotunnel.com&type=A'
# 取 Answer[].data，写两行，例如：
# 198.41.192.7 region1.v2.argotunnel.com
# 198.41.200.13 region2.v2.argotunnel.com
```

## 5. 验证

```bash
curl -fsS https://api.<域名>/healthz
curl -fsS https://api.<域名>/v1/models -H "Authorization: Bearer mr-..."
curl -N -sS https://api.<域名>/v1/responses \
  -H "Authorization: Bearer mr-..." -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-flash","input":"你好","stream":true,"max_output_tokens":64}'
```

## 6. 请求审计按访客 IP 分类

在 WebUI → 系统与维护 → 审计日志中开启请求审计和 Request IP，IP 来源选择 `Cloudflare / CF-Connecting-IP`，可信代理保持本机回源地址 `127.0.0.1`、`::1`。请求将按 Tunnel 传来的访客 IP 分类，不会全部归到 cloudflared 的回环地址。仅可信 socket 对端的头生效；其他来源或无效头回退到 socket IP。字段开关、Token、Prompt、Key 指纹、查询接口和保留规则见 [请求审计文档](request-audit.md)。

## 7. 可选 WebUI 域名

例如发布 `https://web.example.com`，在 `config/local.json` 顶层加入：

```json
"adminPublicOrigin": "https://web.example.com"
```

Cloudflare Public Hostname 的 Service 设置为 `http://127.0.0.1:8788`，保留原始公网 Host。保存后重启 Modgaze（此项不热加载）。`adminPublicOrigin` 必须是精确 HTTPS origin，可包含公网非默认端口，但不能包含账号密码、路径、查询或片段；不支持通配符。

HTTP 回源只接受回环地址上的本地代理；不信任任意 `X-Forwarded-*` 头。浏览器 Origin 必须与公网来源一致，Cookie 使用 Secure/HttpOnly/SameSite=Strict，登录及 CSRF 校验不变。公网不能执行首次密码设置；先在服务器本地运行 `npm run admin:password`。

`adminAllowedHosts`（注意不是 `adminAllowHosts`）仅用于 HTTP 直连监听端口的主机名白名单；HTTPS 直连对应 `adminHttps.allowedHosts`。这些列表不会自动把公网 443 映射为内部 8788，也不替代 `adminPublicOrigin`。

验证：

```bash
curl -fsS https://web.example.com/api/auth/status
curl -fsS -H 'Origin: https://web.example.com' https://web.example.com/api/auth/status
```

未登录访问 `/api/state` 应仍返回 401；错误 Host、跨站 Origin 应返回 403。

## 8. 注意事项

- Cloudflare 免费版请求体上限 100 MB；Modgaze `maxBodyBytes` 64 MiB，够用。
- 源站 100 秒不响应会 524；长思考请求必须 `stream: true`，SSE 正常透传。
- 管理台默认不接受边缘终止后的公网 Host；只有配置上面的 `adminPublicOrigin` 后才支持指定的公网 HTTPS 来源。
- API 仍然需要 `mr-...` 虚拟 key；建议在 Cloudflare 侧再开 Rate limiting。
- token 等同连接凭证，只放 `/etc/cloudflared/token`（0600），不要提交。
