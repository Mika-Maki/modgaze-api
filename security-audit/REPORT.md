# Modgaze 代码安全审计

## 结论与范围

[verified] 报告中的三项主要风险（F1/F2/F3）和两项静态发现均已在工作树修复，未提交、未部署。修复后全量测试 351/351 通过；三个审计复现脚本已改为“修复后应拒绝”的断言并全部退出0。

[inference] 修复后可安全用于受控的单管理员、可信客户端部署；仍不应把虚拟 Key 隔离等同于完整的多租户上游资源隔离。

[verified] 审计基线：ef77292995eda23cbf16ef26167454bbb9a8f410；运行环境 Node v26.9.0。修复前 npm test：284/284 通过（/tmp/amerge-security-tests-20261110.log）；修复后 npm test：351/351 通过，0 失败、0 跳过，退出码0（/tmp/amerge-security-fixes-full.log）。

本轮覆盖代理鉴权、模型/Responses授权、限流、管理会话/CSRF/Host、关键前端转义、配置与日志、启动脚本。使用假凭据、临时目录、临时回环端口；没有读取真实凭据内容、访问真实供应商、操作线上服务或修改业务代码。测试通过不代表没有安全缺口。未执行真实浏览器攻击测试、外网扫描或拒绝服务压力测试。

## F1 共享上游对象引用缺少租户授权（条件性高风险）

[verified] 位置：src/router.mjs:228-249、261-263、453-470。validateReferences 拒绝未记账 Responses、conversation、item_reference，但允许 input_file.file_id、file_search.vector_store_ids、code_interpreter.container、Chat 文件引用；随后以共享 upstreamApiKey 转发。

入口：持有有效虚拟 Key 的客户端调用 POST /v1/responses 或 /v1/chat/completions。前提：上游凭据/项目覆盖其他用户资源，调用者知道或获得资源ID，供应商按该上游凭据授权这些引用。

[verified] 本机 mock 验证四类引用均返回200，原始对象ID未被拦截，mock 收到共享上游凭据；每次 curl 退出码0。对照：未知 previous_response_id 返回404，上游调用数不增加。

[inference] 满足前提时，可借共享凭据访问文件、检索向量库或使用其他用户容器，破坏隔离。没有使用真实供应商对象验证跨租户读取，mock 返回内容不是实际数据泄露证据。单用户专用上游项目风险较低。

修复前复现：node security-audit/router-repro.mjs 显示4类引用均转发。修复后同一脚本对4类引用断言403且上游调用为0，退出码0；输出中的临时端口在脚本结束时已关闭。

修复：在供应商协议语义层，对文件、向量库、容器等资源引用建立调用Key→对象所有权或显式授权映射；未支持的引用默认拒绝；或每租户使用独立上游项目/凭据。不要递归封禁所有名为file_id的用户文本/工具schema字段，以免误伤普通数据。

回归：调用者B引用A的资源必须在上游调用前返回403/404；B自己的授权资源成功；覆盖Chat/Responses及工具输入；保持普通文本/schema不受影响。

防守可见性：现有request日志无法区分对象授权意图。新增结构化 object_type、调用Key指纹、对象ID的不可逆摘要、authorization_result、request_id，不记录对象内容或密钥；对跨调用者引用拒绝/未知资源引用设置告警。现有200日志不能证明资源访问合法。

## F2 启动脚本可能生成其他本地账户可读的审计日志（中风险）

[verified] 位置：tunnelup.sh:22、41；scripts/service.mjs:13、47-48；src/server.mjs:54。tunnelup没有设置私有umask，mkdir和重定向受调用者umask影响；service的新建权限0700/0600不能修正已存在0755目录/0644文件。

[verified] 在可遍历临时项目、umask0022下，tunnelup创建run=0755、日志=0644。启用audit/systemPrompt后，uid/gid65534可读合成System Prompt，同时读取0600配置得到EACCES。service使用预先存在0644日志时同样泄露。两次API请求均200/curl退出0，整体验证退出0。

前提：上级目录可遍历、本机存在不可信账户、日志含敏感字段。不能据此宣称当前/root/amerge目录已发生泄露；本轮只在隔离副本证明该部署缺陷。System Prompt默认关闭、audit默认关闭。

修复前复现：node security-audit/deployment-verified-repro.mjs 显示run=0755、log=0644且uid65534可读。修复后脚本断言run=0700、log=0600、其他UID读取EACCES，退出码0；未启动真实cloudflared或接触8787。

修复：启动最前设置umask077；校验run目录与日志所有者、普通文件/目录类型、拒绝符号链接；对已存在目录/文件强制0700/0600；Node打开后对同一文件描述符fchmod，避免只依赖创建mode。只在路径、所有者、符号链接检查后修正权限。

最小方向示例（不是完整已应用补丁）：

~~~diff
+umask 077
 mkdir -p "$RUN"
+# 另需校验既有目录/日志所有者与类型，拒绝符号链接，收紧既有权限。
~~~

回归：umask0022、旧0644日志、旧0755目录、符号链接四类；其他UID读日志必须EACCES。监控日志权限漂移、磁盘剩余空间、日志增长率。

[verified] 持久化本身是文档说明的功能，不单列为隐藏泄露：docs/request-audit.md:64明确audit独立于accessLog输出stdout，service落盘且不追溯删除、没有新增轮转策略。maxEntries只限制内存，不能限制磁盘；仍应配置保留期/轮转并避免不必要记录Prompt。

## F3 未认证且被限流的管理请求仍读取和编译全部配置（中风险）

[verified] 位置：src/admin.mjs:82-86、494-500；src/admin-store.mjs:392-395；src/config.mjs:12-23、37-58。refreshRateLimits在请求准入和会话验证之前执行store.read，读取JSON、克隆和编译配置。singleflight仅合并重叠读取，不缓存已完成结果。

[verified] 配置admin.rpm=1并初始化合成管理员密码，不携带会话连续4次GET /api/state，状态为401、429、429、429；真实ConfigStore.read调用增量为1、2、3、4，全部curl退出0。未登录、被限流的3个请求仍进行全量配置工作。

[inference] 能访问管理入口的攻击者可通过顺序请求持续消耗磁盘/CPU，大配置放大影响；未压测或证实服务中断。Host白名单不是原始HTTP客户端的认证凭据。

修复前复现：node security-audit/admin-admission-repro.mjs 显示401/429/429/429期间读取次数为1/2/3/4。修复后同一脚本断言读取增量为0，退出码0。

修复：将配置刷新从请求路径移出，使用受控周期刷新/变更通知并缓存；先做廉价准入。保留独立低频刷新以支持错误限流配置的本地恢复。仅把刷新放在429之后又不提供恢复通道，会重新引入锁死风险。

回归：限流拒绝后多次请求不增加全量编译次数；配置改动在有界刷新周期内生效；低限额配置可恢复。监控config_compile_count/duration、管理429与事件循环延迟；拒绝量增加时编译次数不应同速增加。

## 其他静态发现与边界

[verified:已修复] 原cf/tunnel.sh:19、cf/quick.sh:22、tunnelup.sh:61把环境值插入shell字符串。现改为scripts/secure-launch.mjs以固定脚本和位置参数启动，环境值中的空格、引号、`;`、`$()`均保持单个参数。新增部署回归用含注入字符的BIN/LOG/TOKEN/TARGET验证无INJECTED/SUBSTITUTION文件生成。

[verified:已修复] 原src/admin-routes-system.mjs:30引用未定义audit，:227引用未定义serviceStatus。现createAdmin注入两者；全部成功分支统一return true，消除已发送响应后又走fallback 404的路径。GET /api/audit（登录后200）与POST /api/service/restart（非托管进程409）已有测试。

[verified:代码检查及现有测试] 已有较完整的防护：管理员scrypt密码存储、随机会话、HttpOnly/SameSite=Strict、CSRF与Host/Origin检查、密码变更使会话失效；按Key与有效路由绑定Responses；不跟随上游重定向；解压后响应体上限；配置/备份安全读取；前端转义与CSP。未证实未认证管理接管、CSRF绕过或XSS，但未做浏览器穷尽验证。管理员配置任意上游地址属于当前全权限控制面的设计，不单独计SSRF漏洞。

## 执行记录与限制

- 修复前 npm test：284通过，退出0；修复后 npm test：351通过，退出0。
- router-repro.mjs：修复前4种对象引用放行；修复后全部403、上游0调用，退出0。
- 原有deployment-repro.mjs首次因夹具漏复制package.json，隔离服务不能启动而超时退出1；保留原文件，新增deployment-verified-repro.mjs补齐该公开元数据后完整验证成功。未修改业务代码。
- admin-admission-repro首次未初始化密码，得到409而非预期401，断言失败；补齐合成密码后得到401/429/429/429。修复后读取增量0，断言通过。
- 临时服务/目录由夹具清理；进程检查未发现modgaze-deployment-repro残留。全量测试后台任务已收取退出0结果。
- security-audit/router-repro.mjs和deployment-repro.mjs在审计开始时已存在；阅读后才执行，没有将其既有内容当作结论。新增了本报告、修正后的部署夹具、管理准入夹具。安全修复已应用到工作树，未commit、未部署、未修改真实配置/日志。

建议顺序：多用户共享凭据场景先修F1；所有部署统一修F2；可远程访问管理入口时修F3。上述复现已转换成“拒绝未授权引用、其他UID不可读、429不触发全量编译”的回归断言。

## 修复实施

[verified] 以下改动在工作树完成，未提交。全量测试 351/351、0失败；新增回归主要在 test/resource-policy.test.mjs、test/admin-admission.test.mjs、test/deployment-security.test.mjs，另有 test/admin-security.test.mjs 扩展。

| 项 | 改动 | 关键位置 | 回归 |
|---|---|---|---|
| F1 资源引用 | 新增语义检查，未记账的 file_id/vector_store_ids/容器/prompt.id/音频ID等在转发前403；仅检查协议权威槽，不扫描函数schema/参数/metadata；query别名同样拒绝 | src/resource-policy.mjs、src/router.mjs | 17类拒绝路径（含工具/defaults/query）、上游0调用、内联内容仍200、宽数组无spread栈溢出 |
| F2 日志权限 | 启动umask077；经目录fd逐级校验（拒绝符号链接/非目录/非本人），run=0700；日志/pid用O_NOFOLLOW+O_NONBLOCK+同inode校验，旧0644修正为0600，拒绝硬链接/FIFO/其他用户文件；fd直接交给子进程 | scripts/private-files.mjs、scripts/service.mjs、tunnelup.sh | 4个入口×(新建/旧权限)、symlink/hardlink/FIFO/directory/foreign、路径替换后fd仍指向原inode、其他UID EACCES、共享父目录权限不变 |
| F2 shell拼接 | 环境值不再插入shell字符串；固定循环脚本身份+位置参数 | scripts/secure-launch.mjs、cf/*.sh、tunnelup.sh | 含空格/引号/分号/命令替换的BIN/TARGET/LOG/TOKEN以单参数到达假cloudflared；无注入文件 |
| F3 管理准入 | 移除每请求全量读取；独立默认5s定时刷新、失败保留上次有效限额、保存时版本屏障+串行化；close清理timer | src/admin.mjs | 24次401+24次429零读取、短周期恢复坏限额、reload旧快照不覆盖、close在途/未listen、unref |
| 管理接口 | 注入audit/serviceStatus；成功分支统一return true | src/admin-routes-system.mjs、src/admin.mjs | GET /api/audit 200；非托管restart 409；不再fallback 404 |
| 文档 | 说明兼容变化、监控字段、日志轮转示例、旧日志不追溯删除 | README.md、docs/security-limits.md、docs/request-audit.md | 人工核对 |

修复后的行为变化对调用方可见：使用供应商已上传资源ID的请求现在返回403（含同一用户），需改用内联内容或实现按Key的资源授权账本；管理限额本地修正最多需一个刷新周期（默认5秒）恢复。

验证命令：

~~~bash
npm test
node security-audit/router-repro.mjs
node security-audit/admin-admission-repro.mjs
node security-audit/deployment-verified-repro.mjs
~~~

未做：真实供应商对象跨租户读验证、外网/压力测试、浏览器攻击验证、commit/部署、线上日志权限修正。线上旧日志权限仍需在新启动脚本生效后由部署者检查，历史文件不会被自动删除或改写。
