# 请求审计与 Tunnel 真实 IP 分类

入口：WebUI → 系统与维护 → 审计日志（`#/system/audit`）。请求审计与原有管理动作审计分开；原有 `accessLog` 的最小访问日志格式不变。

## 开启与字段选择

开启「请求审计」，勾选所需字段并保存，立即热生效。下面示例合并到配置的顶层，不要替换已有 `groups`：

```json
{
  "audit": {
    "enabled": true,
    "fields": {
      "requestIp": true,
      "inputTokens": true,
      "outputTokens": true,
      "systemPrompt": false,
      "reasoningTokens": true,
      "model": true,
      "group": true,
      "key": false
    },
    "ipSource": "cloudflare",
    "trustedProxies": ["127.0.0.1", "::1"],
    "maxEntries": 500,
    "maxPromptChars": 16384
  }
}
```

没有 `audit` 配置时总开关默认关闭；字段的默认值如上。System Prompt 与 Key 默认不记录，各字段都可独立关闭。总开关开启时固定保留时间、Request ID、方法、协议、状态、结果和耗时；总开关关闭则不产生请求审计记录。

- **Request IP**：请求来源 IP，按下述可信代理规则解析；页面按此 IP 分类、汇总请求数和错误数，并展开查看详情。关闭后历史内存中的 IP 也移除，页面不再按 IP 分组。
- **Input / Output / Reasoning Token**：采集上游实际返回的 usage，不按文本估算。支持 Chat Completions、Responses、Anthropic Messages 的 JSON / SSE，含 gzip、deflate、br 解压后的响应。Anthropic 分阶段 usage 合并，累计值不重复相加。未返回的字段显示 `—`，明确返回零才显示 `0`。
- **System Prompt**：提取实际发送请求（含模型 defaults）中的 system / developer 文本、Responses instructions 或 Anthropic system；不记录用户对话正文或图片内容。已配置的凭证会脱敏，随后截取到字符上限；这不改变上游请求本身。
- **Model / Group**：本地模型 ID 与分组 ID；上游模型映射不改变这里的本地 Model。
- **Key**：已认证客户端凭证 SHA-256 的前 16 位指纹，可与管理台 Key ID 关联；不记录原始 Key 或上游凭证。认证失败不保存提交的凭证。

## Cloudflare Tunnel

本项目 Tunnel 回源是 `http://127.0.0.1:8787`。保持默认 IP 来源 **Cloudflare / CF-Connecting-IP**，可信代理保持 `127.0.0.1`、`::1`，即可读取 cloudflared 转发的访客 IP，而不是把所有访客归入回环 IP。

只有 TCP socket 的直连对端在 `trustedProxies` 中，才读取代理头。非可信对端一律按直连 IP 分类；头缺失、无效或出现多个 CF 地址时回退到直连 IP，不猜测真实来源。IPv4-mapped IPv6 统一为 IPv4，IPv6 使用规范化地址分组。

可选来源：

| `ipSource` | 行为 |
| --- | --- |
| `cloudflare` | 读取可信直连代理传来的 `CF-Connecting-IP`；不会回退到任意 XFF |
| `x-forwarded-for` | 仅可信直连对端可用；从右向左跳过可信代理，取首个不可信地址；非法链回退 socket |
| `socket` | 只使用 TCP 直连对端地址，不读取来源头 |

可信代理目前仅支持**精确 IP**，不支持 CIDR、主机名、端口或通配符。cloudflared 若运行在其他主机/容器，应填其实际回源 socket IP。不要填访客 IP。可信代理必须覆盖/正确追加来源头；同机进程也可伪造回环请求的代理头，因此此配置不区分本机进程和 cloudflared。仅通过 Tunnel 暴露 API、源站仅绑定回环的部署可避免公网直连冒充可信代理。Cloudflare Pseudo IPv4 重写模式会影响 `CF-Connecting-IP` 的值；需要原始 IPv6 时不要启用该重写模式。

审计 IP 配置只改变审计归类，**不改变现有限流、鉴权或路由语义**。

## 保存、查询和保留范围

- `PATCH /api/settings` 接受 `{ "audit": { ... } }`，嵌套 `fields` 按字段合并；不影响其他设置。保存经过校验、备份和热重载。
- `GET /api/state` 返回 `settings.audit` 和 `requestAudit`。WebUI「刷新记录」获取最新请求，并保留未保存的审计设置草稿；不会额外轮询完整审计数据。
- `GET /api/request-audit` 返回 `{ok, entries, byIp, total}`；`?ip=203.0.113.7` 精确筛选一个 IP。查询接口需要管理员登录，修改还需要现有 CSRF Token。
- `maxEntries` 为 1–2000，默认 500；汇总仅计算当前保留窗口，不是全历史累计。内存记录重启清空。
- `maxPromptChars` 为 1–65536，默认 16384（JavaScript 字符串长度单位）；关闭字段会从既有内存记录删除，重新开启不会补回。总开关关闭会清空内存记录；进行中的请求也服从结束时的禁用设置。
- 开启后，每个完成/失败/中断请求向 stdout 输出一行 `event: "audit"` JSON，与 `accessLog` 开关独立。使用 `service:*` 启动时进入 `run/modgaze.log`；其他启动方式由 stdout 收集器决定存储位置。日志文件不按 IP 创建目录，IP 分类在 WebUI 和查询接口完成。已输出的文件日志不会被后续关闭字段操作追溯删除，也没有新增日志轮转策略。
- 每个 JSON 响应 / SSE 事件最多解析 1 MiB；超过时跳过该响应/事件的 usage 提取，原始代理数据仍按已有响应上限转发，不伪造 Token。SSE 不强制改写 `stream_options.include_usage`；需要完整 Chat 流式用量时由客户端/上游启用 usage。

配置由 WebUI 保存后无需重启；首次升级到包含此功能的代码仍需重启正在运行的旧进程。

## 日志保留与轮转

`maxEntries`不限制stdout文件的大小或保留期。启动脚本保证项目run目录0700、日志0600；收集器与归档也必须保持等价权限。默认不要启用System Prompt，关闭字段不会删除已写出的历史日志。

如使用Linux logrotate，可为实际安装路径配置下面的独立规则（示例安装路径为 `/opt/modgaze`，部署时替换，不是当前实例路径；本项目不会自动安装系统规则）：

```conf
/opt/modgaze/run/modgaze.log /opt/modgaze/run/modgaze-tunnelup.log /opt/modgaze/run/cloudflared-tunnelup.log {
    daily
    maxsize 50M
    rotate 7
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
}
```

以服务账户或root执行轮转，保留私有归档权限，并将规则按业务量加入足够频繁的调度；`maxsize`仅在轮转任务执行时检查，不是写入硬上限。`copytruncate`避免重启长连接，但复制与截断之间可能丢失少量日志；要求无损审计时应将stdout交给支持安全轮转的日志收集器，而非copytruncate。为磁盘剩余空间、日志增长速度及日志/归档权限漂移设置告警。未自动修改线上日志、安装规则或删除历史记录。
