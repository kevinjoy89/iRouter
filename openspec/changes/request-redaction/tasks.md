## 1. 修复请求级自动重试（先行，独立于脱敏）

- [x] 1.1 `src/sse/handlers/chat.js`：`handleChat` 内 `request.json()` 提到 `withAutoRetry` 之外，`handleChatOnce` 增加 `body` 形参（缺省兜底自解析）；注释说明"body 原地改写必须保持幂等"这一新增约束。**已在其他会话提交（`fc0d600d`）并随 v0.1.1 发布**
- [x] 1.2 新增 `tests/unit/chat-retry-body-reuse.test.js`：5 用例
- [x] 1.3 验证测试确实捕获缺陷：还原修复前代码 → 3 用例失败且信息为 `expected 400 to be 200`；恢复后 5/5 通过

## 2. 引擎（`open-sse/dlp/`，纯函数、零 `@/` import）

> **与计划的偏差**：原计划拆 6 个文件（rules/detect/decode/apply/inspect/index）。实际实现为单一
> `open-sse/dlp/index.js`（约 600 行）——候选正则、动作优先级、预算对象在三者间共享，
> 拆开只会增加跨文件参数传递。对外只暴露 `inspectRequestBody` / `loadPolicy` / `validatePolicy` /
> `buildKnownSecretPattern` / `entropy` / `validIdCard` / `validBankCard`。
> 原计划的 `maxBytes` 参数未实现——参考实现在代理层做体积判断（bytes），而我们的入口已是解析后的
> 对象，体积语义属调用方（见 Non-Goals：压缩体与超大体积不在本版范围）。

- [x] 2.1 规则加载 + 校验（version / rules / defaults / flags / validator / action / placeholder / secret_group / json_keys / keywords / min_entropy / allowlist / max_matches / enabled），错误在加载期抛出；`confbox/yaml` 解析；按 `路径+mtime` 缓存，规则文件改动无需重启
- [x] 2.2 `dlp_rules.yaml`：移植参考实现 14 条（去掉 `csv_credentials`，理由见 design.md）；PII 三条 `enabled: false`；YAML 语法从 Python 调整为 JS（`(?m)` 内联标志 → `flags:`，`.*?` + DOTALL → `[\s\S]*?`）
- [x] 2.3 检测：规则遍历、`keywords` 预筛、`min_entropy`、`validator`（`cn_id_checksum` / `luhn`）、`secret_group`（用 `d` 标志取捕获组偏移）、`max_matches`、`allowlist`；**一律 `matchAll` 迭代，规避 `lastIndex` 并发污染**；已知密钥合并正则（长度降序、≥8、元字符转义）
- [x] 2.4 嵌套编码：base64 / base64url / hex / percent 候选 + 递归深度 + 候选数/字节数预算，超预算置 `limitExceeded`；超大候选跳过且不消耗预算（防"前置大块压制真实秘密扫描"）
- [x] 2.5 span 选择（重叠时按 起点 → 动作优先级 → 长度）与替换（`placeholder` 模板 `{rule}`）；**只有 action=redact 的 span 参与替换**（对齐参考实现——block 只上报不改写）；豁免标记区间跳过 + 标记剥除 + 未配对/嵌套按普通正文处理
- [x] 2.6 JSON 结构感知遍历（`messages[].content` 限 user/tool、`input` 的 `*_call_output`、顶层 `prompt`/`query`；system/assistant/协议字段不扫；识别不了结构则递归全字符串）；`_BINARY_KEYS` 内联二进制跳过
- [x] 2.7 `inspectRequestBody(body, opts)` 单一入口，**内部全量 try/catch → fail-open**（记日志、返回原文 + `error`）
- [x] 2.8 `tests/unit/dlp.test.js`：51 用例（参考 `test_dlp_api.py` 的引擎语义部分 + 规则加载/校验、fail-open、并发不串味、校验器、熵）

## 3. 运行时挂载

- [x] 3.1 `src/sse/handlers/chat.js`：body 解析后、转发前调用；block → 422 `sensitive_data_blocked`；redact → 替换 body；audit → 记日志不改写。与重试共用同一 body，故重试期间不会漏脱敏
- [x] 3.2 `src/sse/handlers/embeddings.js`、`imageGeneration.js`：同一调用
- [x] 3.3 `src/lib/dlp/index.js`：app 侧调用方——settings 读取、已知密钥收集（多字段、去重、≥8、30s 缓存）、`invalidateKnownSecrets()`；settings PATCH 时失效。日志只记规则名不记值
- [x] 3.4 `settingsRepo.js`：`dlpMode: "off"`、`dlpRules: []`、`dlpMaxBodyBytes`、`dlpAllowExemptions: false`、`dlpKnownSecrets: true`；`DEFAULT_SETTINGS` 改为具名导出（便于测试断言默认值）

## 4. UI 与文档

- [x] 4.1 Profile 页 Observability 卡片下方新增 Request Redaction 卡片：模式四选一（off/audit/redact/block）+ 已知密钥开关 + 豁免开关；文案写明 **outbound only，本机落盘仍是明文**
- [x] 4.2 术语已落 `CONTEXT.md`（请求脱敏 / 敏感信息规则 / 豁免标记 / 已知密钥 / 出站与落盘脱敏）；ADR 0005 已落
- [x] 4.3 **多语言补全（真机反馈）**：卡片首版 11 条文案全部漏入字典，中文界面整片显示英文。补 zh-CN / zh-TW 各 16 条（含共享组件 `Select an option` 占位符，影响全站所有下拉）
  - 顺带纠正 design.md 的错误表述：`runtime.js:83` 的 `skipTags` 比对的是**直接父元素**，`<option>` 不在列表内 → option 文本**会被翻译**（原「select 子树不翻译」不准确）。据此把 option 文案从裸枚举词（`Off`/`Block`）改回带说明的整句：整句作 key 还避免了通用词碰撞
  - 移除内联 `<code>`/`<strong>`：`code` 在 skipTags 内，内联会把整句切成多个文本节点导致漏翻
  - 新增 `tests/unit/i18n-runtime.test.js` 3 用例（字典覆盖 / 无内联标记 / skipTags 边界）；已验证「删字典条目 → 测试失败」

## 5. 测试与验证

- [x] 5.1 全量回归：**`✅ No regression. (now fails=105, baseline known=105, all known)`**，2568 tests / 2404 pass；DLP 两套 62 用例全绿
- [x] 5.2 `npx eslint` 改动文件零告警（`profile/page.js` 存一处**既有**告警：`set-state-in-effect` 位于未改动的 `:90`，已用 `git stash` 验证 HEAD 上同样存在）
- [x] 5.3 真机冒烟（隔离实例 PORT=20131 + 独立 `DATA_DIR`，不干扰运行中的 20128）：四档模式全部按预期工作
  - `off` / `audit`：请求照常转发（404 no credentials），audit 记 `ℹ️ [DLP] audit rules=ai_tokens`
  - `redact`：`⚠️ [DLP] redacted rules=ai_tokens,encoded_secret count=1`，base64 编码的 key 同样被剥除
  - `block`：`HTTP 422 {"error":{"type":"sensitive_data_blocked","rules":["ai_tokens"]}}`，上游未被调用
  - 豁免标记：开启时包裹的 token 通过（404），关闭时同一载荷 422
  - 已知密钥：明文 → `["known_secret"]`；**base64 编码 → `["encoded_secret","known_secret"]`**（递归解码 + 精确匹配同时命中）
- [x] 5.4 冒烟实例已停止、临时 `DATA_DIR` 已清理，原 20128 网关未受影响（复测仍 401）
- [x] 5.5 **打包产物验证（发现并修复一处会导致功能静默失效的打包 bug）**：
  - `open-sse/dlp/index.js` 原用 `fileURLToPath(import.meta.url)` 定位规则文件，但 Next 把引擎打进 `.next/server/chunks/*.js` 时该值被冻结为**构建机绝对路径**；用户机器上不存在 → `loadPolicy` 抛错 → fail-open → UI 显示已开启但从不脱敏。改为按 `DLP_RULE_FILE` → cwd → 模块探测；新增 5 个回归用例
  - 验证方式为**打包产物本身**（起包内 `custom-server.js`）：block → 422 `sensitive_data_blocked`；redact → 日志 `redacted rules=ai_tokens,encoded_secret count=1`
- [x] 5.6 **面板 UI 验证走打包产物的真实 Electron 窗口**（`npm run smoke:packaged`），不用浏览器——浏览器直连面板被 `custom-server.js:23-41` 的面板守卫连接级掐断（`IR_PANEL_GUARD=1` 时生效），那是产品设计意图，不是可绕过的路径
  - 新增断言 `面板文案中文=true (卡片/凭据/豁免/档位/英文残留)`；已验证「包内删字典条目 → `面板文案中文=false` → smoke FAIL」
  - 发布包：`desktop/build/dist/iRouter-0.1.2.dmg`（149M，sha256 `03482d7b…`），含字典 1896 条

## 5b. 可观测性（真机反馈：开了 redact 却在日志里看不到任何命中）

用户反馈把模式设为 `redact` 后，日志中看不到命中记录，无法判断是「没命中」还是「没生效」。
排查结论：**实现正确，但可观测性有缺陷**。用已安装产物实测确认引擎工作正常
（`[DLP] redacted rules=ai_tokens count=1`，且该行确实进入面板控制台日志页）；
根因是**原先只在命中时打日志**——「扫了但没命中」与「根本没跑」在日志里完全相同。
另测得该用户的真实流量中，可扫描字段（`messages[].content` 等）命中数为 0，
3 处 `sk-` 形状串全部位于 `response`，而响应按 ADR 0005 本就不在扫描范围内。

- [x] 5b.1 引擎新增 `scannedFields` / `scannedChars` 计数（`open-sse/dlp/index.js` 的 `inspectJson` 字符串访问处累加），作为「确实扫过」的证据
- [x] 5b.2 新增 `logDlpOutcome()`（`src/lib/dlp/index.js`，放在 DLP 模块而非 `chat.js`——三个 handler 都要用，从 `chat.js` 导入会形成环依赖）：命中记 `warn` 并带规则名/次数；audit 命中但不改写记 `info` 且文案为 `matched(no-rewrite)` 以示区分；零命中记 `info` 并带扫描量；`mode=off` 不留痕
- [x] 5b.3 三个入口（chat / embeddings / images）统一调用，**每个请求都留痕**
- [x] 5b.4 真机验证：隔离实例发普通请求 → `ℹ️ [DLP] no match mode=redact scanned=1field/47char`；发含 token 请求 → `⚠️ [DLP] redacted rules=ai_tokens count=1 scanned=1field/44char`；两行均出现在面板控制台日志页
- [x] 5b.5 单测：`dlp-wiring.test.js` 增 5 用例（零命中 / 命中 / audit 区分 / off 不留痕 / chat 入口零命中确实调用）

**仍存的可观测性缺口（未做）**：`requestDetails` 的 `request` 字段经 `truncateField`
（5KB 上限）后只剩前 200 字符 `_preview`，详情页因此看不到被改写的**具体位置**。
本次只做到「知道扫了多少、命中哪条规则」，未做到「看到改了哪里」。

## 6. 未做（Non-Goals，见 design.md）
- [ ] 落盘脱敏（`requestDetails` 表仍是明文）——独立立项
- [ ] 入站 gzip/deflate 解压后扫描
- [ ] audio/video 请求体（`formData()` / 二进制）
- [ ] 逐条规则 UI 开关（需要定制的走 `DLP_RULE_FILE`）
- [ ] `DLP_FAIL_CLOSED` 开关（ADR 0005 明确不做）
- [ ] `saas_tokens` 的 `sk` 关键词误报率实测（design.md Open Questions 保留，当前与参考实现保持一致）
