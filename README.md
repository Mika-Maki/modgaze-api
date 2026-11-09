# Modgaze 本地后端与 WebUI 控制台

[![CI](https://github.com/Mika-Maki/modgaze-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Mika-Maki/modgaze-api/actions/workflows/ci.yml)

零第三方依赖，Node.js 22+。默认路由监听 <http://127.0.0.1:8787>，管理台监听 <http://127.0.0.1:8788>。路由按 API key 隔离模型和目标地址；客户端只需要改成本地 base URL，继续发送原来的 key、模型 ID 和原生请求，不需要、也不接受目标 baseURL 参数。

管理台提供完整的本地控制面：上游分组增删改、上游 Key 更新、协议路由、模型目录、虚拟 Key 生成/轮换/撤销、直通 Key、连通性测试、运行参数、配置备份恢复、导入导出、审计与实时流量。管理台本身需要管理员密码登录；密码使用 **scrypt + 随机盐** 做哈希后保存，不存储明文，可在服务器本地重置。

## Quickstart

要求 Node.js 22+，零第三方依赖，不需要 `npm install`。默认路由监听 `http://127.0.0.1:8787`，管理台监听 `http://127.0.0.1:8788`，默认都只绑定回环地址。

```bash
cd /root/amerge
npm run import          # 首次生成最小 config/local.json，并一次性打印本地 key
npm run check           # 校验配置
npm run service:start   # 后台启动；前台调试用 npm start
curl -fsS http://127.0.0.1:8787/healthz
```

1. 打开管理台 <http://127.0.0.1:8788>，首次进入设置管理员密码（至少 10 位），之后每次用该密码登录。
2. 在「上游分组」新建分组：填写上游 baseURL、上游 Key、协议和模型。已有 router-preparetion.md 时也可以一次性导入完整配置：`npm run import:preparation -- --source PATH`（不指定 `--source` 会在项目根目录、再上一级目录查找；默认拒绝覆盖，重建加 `--force`，写盘前自动备份到 run/backups）。
3. 客户端 base_url 用 `http://127.0.0.1:8787/v1`（Anthropic SDK 用 `http://127.0.0.1:8787`），key 填第 2 步分组里的凭证；推荐在「本地密钥」生成虚拟 Key（`mr-...`，要求该分组已配置上游 Key）。

验证模型发现（把 `<虚拟 Key>` 换成实际 key）：

```bash
curl -fsS http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer <虚拟 Key>"
```

`npm run import` 生成的是占位配置：单个分组指向不可达的 example.invalid，附带一次性打印的本地 key，只用于验证启动、鉴权和 /v1/models；换成真实上游前不会成功转发生成请求。config/local.json 内含真实 key，不要上传或提交。停止服务用 `npm run service:stop`，日志在 run/modgaze.log。需要后端 HTTPS（8786 / 8789）时见 [docs/https.md](docs/https.md)；只把 API 8787 通过 Cloudflare Tunnel 暴露时见 [docs/tunnel.md](docs/tunnel.md)。

## 启动与管理

首次生成配置、启动与首次登录见上面的 Quickstart。日常操作：

打开管理台：<http://127.0.0.1:8788>。第一次打开时会要求创建管理员密码（至少 10 位）；之后每次打开使用该密码登录。密码哈希保存在 `config/admin-auth.private.json`（0600），不会出现在日志、配置导出或 API 响应里。

重置管理员密码（在服务器终端执行，支持任意时候本地重置）：

```bash
cd /root/amerge
npm run admin:password                 # 交互式设置新密码
npm run admin:password -- --status     # 查看是否已设置（不显示哈希）
npm run admin:password -- --generate   # 生成随机密码，明文只打印一次
npm run admin:password -- --remove --yes  # 删除密码文件，下次打开重新初始化
```

重置后旧 WebUI 会话会在下一次请求时失效，重新登录即可。管理员密码与会话都不影响路由客户端使用的虚拟 Key。

重启或停止：

```bash
npm run service:restart
npm run service:stop
```

前台运行使用 npm start；Linux 后台管理使用 service:*，日志 run/modgaze.log，PID 身份文件 run/service.json。两者互斥：后台服务占用 8787/8788 时再跑 npm start 会以 `EADDRINUSE` 退出，先 npm run service:stop 再前台启动。管理台与路由在同一进程内启动；如需关闭管理台，可在启动时加 `--no-admin`。默认关闭访问日志；开启 accessLog 后只记随机 request_id、method、protocol、status、duration_ms，不记 key、正文、查询、模型或上游地址。后台进程独立于当前会话，但未安装开机自启服务。

通过管理台保存配置会热重载路由（正在进行的请求不受影响）。手动改 `config/local.json` 后，可在管理台点「重载配置」或执行 `npm run service:restart`。监听地址/端口和管理台端口变更需要重启进程后生效。npm run import 在配置已存在时不会覆盖；从源文档重建（npm run import:preparation）默认拒绝覆盖，确认后用 `npm run import:preparation -- --force`，会替换手工配置，先自行备份或先点「立即备份」。

## WebUI 管理台（8788）

管理台只绑定回环地址，不对外开放。打开 <http://127.0.0.1:8788> 后：

- **控制中枢**：屏幕中央是由 SVG + CSS 绘制的巨眼；瞳孔跟随鼠标方向移动，点击任意位置会瞬间收缩。四张玻璃态模块卡环绕眼睛排列，鼠标经过时对应的血管连线亮起并出现流动脉冲；底部 Dock 显示本地端点与实时请求计数。
- **上游分组**：新建、编辑、克隆、启用/禁用、删除分组；更新分组级上游 API Key；管理 chat / responses / messages 分组路由与模型级路由覆盖。
- **模型**：添加/编辑/删除模型；设置上游模型名、上下文窗口、最大输出、输入模态、reasoningEfforts、defaults；支持逐行批量导入。上下文和输出上限可以留空，界面显示为「∞」，路由器不会主动截断请求。
- **本地密钥**：生成、查看、复制、重命名、轮换、删除虚拟 Key；管理兼容旧客户端的直通 Key；导出全部虚拟 Key（含明文，下载前有确认）。
- **连通性测试**：从服务端直接请求上游（模型列表或最多 16 tokens 的真实生成），或用虚拟 Key 请求本机路由，验证鉴权与模型发现。测试结果中的上游 Key 会被脱敏。
- **系统与维护**：修改监听地址、路由端口、管理台端口、请求体上限、超时和访问日志；热重载配置；重启 service 托管进程；查看运行时与文件路径。
- **备份与恢复**：每次写配置前自动备份，保留最近 40 份；可手动打标签、下载、恢复、删除。
- **配置导入导出**：导出脱敏或完整配置；粘贴/选择 JSON 先校验再导入；校验失败不会写盘。
- **审计**：保留登录、分组、设置等管理动作历史；新增可配置请求审计，支持 Request IP、Input / Output / Reasoning Token、System Prompt、Model、Group、Key 指纹独立开关，并按 Tunnel 传来的真实 IP 分类。请求审计默认关闭，配置热生效；详见 [请求审计与 Tunnel 真实 IP](docs/request-audit.md)。

### 视觉系统与动效

- 视觉层独立在 `public/assets/abyss.css`，不改动基础组件样式文件；深空暗红/黑色径向背景、暗色玻璃、暖金与血红是默认基色。Modgaze 固定为深渊深色模式，不提供浅色主题切换；页面声明 `color-scheme: dark`，并忽略浏览器的 `prefers-color-scheme`。
- 巨眼由 `public/assets/js/eye.js` 生成纯 SVG 几何，用 `Math.atan2` 把鼠标方向映射为瞳孔位移，CSS `cubic-bezier` 负责平滑；点击时先同步收缩到 `scale(.53)`，再由 Web Animations 弹回。
- `public/assets/js/orbit.js` 根据眼睛和卡片的实时尺寸计算四角环绕位置，并以 SVG 贝塞尔曲线绘制粗细、透明度与颜色渐变的血管；卡片悬停/键盘聚焦会点亮对应血管并显示流动脉冲。
- `public/assets/js/views/hub.js` 只负责中枢数据与卡片结构；页面进入、卡片离场、控制台子页入场、弹窗与按钮都有独立的微交互。

### 登录与会话

- 管理员密码只保存 scrypt（N=32768, r=8, p=1）+ 24 字节随机盐 + 64 字节哈希；密码文件权限 0600，失败关闭。
- 登录成功后使用 HttpOnly、SameSite=Strict 会话 Cookie；非 GET 管理请求必须带每个会话独立的 CSRF Token。
- 12 小时绝对过期、2 小时空闲过期；管理员密码变更或本地重置会立即让旧会话失效；服务重启后需重新登录。
- 连续登录失败会触发递进限流；Host 和 Origin 都会校验，防止 DNS rebinding 与跨站请求。
- 管理台只监听 `127.0.0.1`；如需远程访问，请自行使用 SSH 隧道或可信反向代理，不要把 8788 直接暴露到公网。

## 按组并发 / RPM 与管理保护

上游分组的新建、编辑及详情页均可设置共享并发/RPM，`0` 表示无上限（默认）；同组全部 Key 共用配额，不同组独立。管理端另有全局、每来源和登录限额，支持 0 无限；保存热生效，429 返回 Retry-After，轮询自动退避。8787 明文与 Tunnel 回源方式保持不变。配置、默认值及兼容变化见 [安全修复与按组限流](docs/security-limits.md)。

## API

| 接口 | 行为 |
| --- | --- |
| POST /v1/chat/completions | OpenAI Chat Completions，JSON / SSE |
| POST /v1/completions | 旧版文本 Completions，使用 chat 路由，上游必须支持该端点 |
| POST /v1/responses | OpenAI Responses，JSON / SSE |
| POST /v1/responses/compact | Responses compact 原生请求转发 |
| GET / DELETE /v1/responses/:id | 检索 / 删除上游 Response |
| GET /v1/responses/:id/input_items | 上游输入项列表 |
| POST /v1/responses/:id/cancel | 取消上游后台 Response |
| POST /v1/messages | Anthropic Messages，JSON / SSE |
| POST /v1/messages/count_tokens | Anthropic token 计数转发 |
| GET /v1/models | 当前 key 的模型与容量元数据 |
| GET /v1/models/:id | 当前 key 的单模型元数据，ID 含斜线时 URL 编码 |
| GET /healthz | 本地存活检查，不调用上游 |

支持 Authorization: Bearer KEY 或 x-api-key: KEY；两种鉴权同时出现且不一致则 401。Anthropic 请求默认补 anthropic-version: 2023-06-01，显式版本和 anthropic-beta 原样转发。OpenAI-Beta、OpenAI-Organization、OpenAI-Project、Idempotency-Key、SDK x-stainless-* 等白名单头可以转发，不转发 Cookie、代理凭证或客户端路由头。

## 客户端连接

OpenAI 客户端 base_url = <http://127.0.0.1:8787/v1>；Anthropic 客户端 base_url = <http://127.0.0.1:8787>（SDK 自行追加 /v1/messages）。**推荐 key 填管理台生成的虚拟 Key（mr-...）**，客户端不需要知道真实上游 key；直通 Key 只用于兼容旧客户端。相同模型名可因 key 不同而自动到不同服务，无需添加 provider 前缀。没有默认超级 key，也不允许未知 key 兜底。

以下 API_KEY 使用 shell 环境变量，不能用一个供应商的 key 调另一个分组：

~~~bash
cd /root/amerge
read -rsp 'API key: ' API_KEY; echo
export API_KEY
curl --fail-with-body -sS http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $API_KEY"

# 适用于已导入的 aresapi Responses key；不要用 Chat-only key 调用。
curl --fail-with-body -N http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"your-responses-model","input":"你好","reasoning":{"effort":"high"},"stream":true}'

# 适用于已导入的 aihub-grok Chat key。
curl --fail-with-body -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"your-chat-model","messages":[{"role":"user","content":"你好"}],"reasoning_effort":"high","stream":true}'

# 适用于已导入的 deepseek-official Messages key。
curl --fail-with-body -N http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $API_KEY" -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{"model":"your-reasoning-model","max_tokens":4096,"messages":[{"role":"user","content":"你好"}],"thinking":{"type":"enabled"},"stream":true}'
unset API_KEY
~~~

上面的生成示例会调用真实上游并可能计费；自动化测试只调用本机 mock。

## 虚拟 API Key 与脱敏

推荐使用虚拟 key 给本地客户端，不把真实服务商 key 发给客户端：

```json
{
  "groups": [{
    "id": "provider-a",
    "virtualApiKeys": ["mr-local-client-key"],
    "upstreamApiKey": "真实服务商 key",
    "routes": {"responses": {"baseURL": "https://provider.example/v1", "auth": "bearer"}},
    "models": [{"id": "provider-model"}]
  }]
}
```

收到 `mr-local-client-key` 后，路由器只把 `upstreamApiKey` 放入上游 Authorization 或 `x-api-key`；虚拟 key 不会回退直传。虚拟 key 缺少有效上游凭证时启动失败。现有 `apiKeys` 仍兼容真实 key，但新客户端应使用 `virtualApiKeys`。

在 WebUI「本地密钥」里可以直接生成、复制、重命名、轮换和撤销虚拟 Key，保存后立即热重载，不需要重启。也可以继续用命令行批量补齐当前导入配置：

```bash
cd /root/amerge
npm run virtual-keys
chmod 600 config/local.json config/virtual-keys.private.json
npm run check
npm run service:restart
```

虚拟 key 写入 `config/virtual-keys.private.json`，文件权限为 0600；命令输出不会打印任何 key。真实 key、虚拟 key 和上游响应中出现的 key 会替换为 `[REDACTED]`；SSE 跨 chunk、gzip/deflate/br 响应也会脱敏，解压后的响应不再保留压缩编码头。

## 原生参数、上下文与图片

- 不裁剪 messages / input / system / instructions，也不创建隐藏系统提示词。完整会话、工具调用与结果、结构化输出、缓存控制、未知扩展字段按原生 JSON 透传。
- Chat 的 reasoning_effort、Responses 的 reasoning、Anthropic 的 thinking / output_config 原样转发，显式 null / false / 0 保留。不强制全局 high，不把某个模型的 max 当所有模型通用能力。
- 图片支持各自协议的原生表示：Chat image_url（远端 URL / data URL）、Responses input_image、Anthropic image.source（base64 / URL）。路由器不下载图片、不转码、不剥离图片块；是否支持该输入由上游模型决定。
- 请求 JSON 在校验后规范化转发，避免重复 model / token / 对象引用字段被上游按不同规则解释；保留原生字段语义，配置 upstreamModel 或 defaults 时再应用对应覆盖/默认值。响应 JSON 和 SSE 保持流式字节转发（已配置凭据去敏除外），包括工具增量、usage、reasoning/signature、事件名和结束帧，带背压、解压后体积限制及客户端断开取消。
- /v1/models 给出 context_window、max_output_tokens、input_modalities、reasoning_efforts、metadata_source、supported_endpoints。上下文容量是配置/本地适配器声明，**不是远端实测**；不会把容量误填成生成 max_tokens，不做估算 token 截断。
- reasoningEfforts 作为发现元数据保留原映射（含 null），不是自动转换指令。客户端仍应发送所用协议的合法参数；例如 off:null 不代表必然关闭上游思考。
- Responses 生命周期和 previous_response_id 通过调用 Key、分组、创建时模型路由及上游凭据指纹校验所有权；不同 Key 不互读，未知对象返回 404。所有权账本仅在内存保留（最多 10000 条，1 小时），重启前/过期/淘汰对象拒绝访问；未实现归属映射的 conversation / item_reference 引用拒绝，不再直接透传。

## 服务端配置

config/local.json 的 groups 按真实 key 合并。每组 apiKeys 决定哪些凭证能访问它，routes 决定协议目标；models 限定模型集合。model.routes 可覆盖组路由以支持相同 key 下不同模型的目标。baseURL 只能在服务端配置，不出现在模型发现响应。

~~~json
{
  "host": "127.0.0.1",
  "port": 8787,
  "adminPort": 8788,
  "groups": [{
    "id": "example",
    "name": "Provider A",
    "note": "团队共享通道，按月对账",
    "enabled": true,
    "apiKeys": [{"env": "LOCAL_ROUTER_KEY"}],
    "upstreamApiKey": {"env": "PROVIDER_KEY"},
    "routes": {"responses": {"baseURL": "https://api.openai.com/v1", "auth": "bearer"}},
    "models": [{
      "id": "client-visible-model",
      "upstreamModel": "provider-model",
      "contextWindow": 128000,
      "maxOutputTokens": 16384,
      "input": ["text", "image"],
      "reasoningEfforts": {"low": "low", "high": "high"},
      "defaults": {"responses": {"reasoning": {"effort": "high"}}}
    }]
  }]
}
~~~

apiKeys 支持多个本地别名 key；不配置 upstreamApiKey 时直接转发收到的原 key。凭证优先级 route.upstreamApiKey > group.upstreamApiKey > 请求 key；生产导入配置默认直传。环境引用在加载配置时解析。别名只改请求 model，响应中的 model 仍保留上游原值。defaults 仅递归填缺省字段，绝不覆盖显式设置。

`adminPort` 默认 8788，也可用 `--admin-port N` 或 `MODGAZE_ADMIN_PORT` 覆盖（旧的 `MODELROUTER_ADMIN_PORT` 仍兼容）；`--no-admin` 只启动路由不启动管理台。`name`、`note`、`enabled`（默认 true）是管理台使用的展示/控制字段；`enabled: false` 的分组仍保留在文件中用于脱敏和恢复，但不会接受客户端鉴权。`virtualKeyMeta` / `apiKeyMeta` 是管理台保存的标签与创建时间元数据（按 Key 的 SHA-256 前缀索引，不含 Key 本身），可安全保留。

baseURL 使用 API 前缀而不是完整端点：/v1 不再重复追加；根域名追加 /v1；/anthropic 追加 /v1 后成为 /anthropic/v1/messages。已包含版本的自定义前缀也保留。不要填 /chat/completions 或 /messages 完整路径。

默认最大请求体 64 MiB（包含 base64 图片）；maxBodyBytes 可调整。upstreamTimeoutMs 默认 120000，为上游 socket 空闲超时；requestTimeoutMs 默认 600000，为从接收请求头后开始计算的请求体接收与上游响应共享总期限。长思考/大输出可调高。配置必须 0600，私密 config 目录 0700；示例文件使用前需 chmod 600。支持 --config PATH、`MODGAZE_CONFIG`，或兼容的 `MODELROUTER_CONFIG`。

## 边界与故障行为

**这是三种原生协议的透明路由，不是三协议互译器。** 某模型只配置 Responses 时，不能经 Chat 或 Messages 自动调用它。只有来源已声明的协议会导入；缺失协议返回 400，不凭空假设网关支持。上游自行实现的扩展字段继续透传。

未知 key=401，未授权模型=404，非法 JSON/路由参数=400，请求体接收超时=408，请求体超限=413，不支持压缩请求体=415，连接失败=502，未开始响应前的超时=504。流已经开始后发生异常会断开，不伪造成功结束帧。上游错误状态、错误正文、Retry-After、限流头原样返回；因此上游正文自己包含的域名等信息并不被路由器审查/清洗。

不跟随上游重定向、不自动重试生成请求、不做跨供应商降级，以避免泄漏凭证、重复计费和对话串组。路由绑定 loopback；管理台只绑定 loopback 且需要登录，不开放任意 URL 转发，不自动读取/跟随客户端传入的 base_url。默认无 CORS，仅面向本地后端/SDK。非流式请求正文在内存中受限缓冲，流式响应不整段缓存。未实现 token 计费、全局并发配额、文件上传、Realtime/WebSocket、跨协议转换或本地持久对话库。管理台不设置 Token 使用上限；各模型的上下文/输出上限只是发现元数据，由上游真实能力决定。

## 文件

- src/router.mjs：配置校验、key 分组、模型发现、原生协议代理、热重载与指标回调。
- src/server.mjs：私密配置加载、环境 key 引用、路由 + 管理台启动/退出。
- src/config.mjs：配置读取、原子写入、备份、权限与秘密引用校验。
- src/admin.mjs：8788 管理台 HTTP 服务、会话、CSRF、管理 API、静态资源。
- src/admin-auth.mjs：scrypt 加盐密码哈希、密码文件读写。
- src/admin-store.mjs：配置变更事务、分组/密钥/模型/路由校验与展示脱敏。
- src/metrics.mjs：进程内实时请求指标。
- src/secrets.mjs：流式敏感值脱敏。
- scripts/admin-password.mjs：本地管理员密码设置/重置/状态。
- scripts/init-config.mjs：生成最小 config/local.json（npm run import），不需要准备文档。
- scripts/import-preparation.mjs：从 router-preparetion.md 生成完整本地配置（npm run import:preparation）。
- scripts/service.mjs：Linux 后台服务启停，不依赖 systemd。
- scripts/virtual-keys.mjs：为现有配置批量生成虚拟 Key。
- public/index.html、public/styles.css、public/assets/app.js、public/assets/js/*：无外部依赖的 WebUI。
- test/router.test.mjs、test/virtual-keys.test.mjs、test/regressions.test.mjs：路由与脱敏回归。
- test/admin-auth.test.mjs、test/admin.test.mjs：密码哈希、登录/CSRF、管理 CRUD、备份、上游测试回归。
- .github/workflows/ci.yml：GitHub Actions 流水线，在 Node 22/24/26 上执行 npm test。
- docs/https.md：HTTPS/TLS 配置教程（证书生成、监听配置、客户端信任、管理台 TLS）。
- docs/tunnel.md：Cloudflare Tunnel 只暴露 API 8787 的配置、常驻脚本与 fake-ip 处理。
- tunnelup.sh：一键启动 Modgaze + Cloudflare named tunnel（token 模式），支持 start/stop/status/url。
- config/example.json：无真实密钥的独立配置示例。

验证使用 npm test；它不验证真实供应商当前可用性、实际上下文窗口或账单。远端鉴权、余额、模型权限仍由对应供应商判断。

## License

MIT，见 [LICENSE](LICENSE)。

Copyright (c) 2026 Mika-Maki
