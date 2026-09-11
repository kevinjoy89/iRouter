## Context

- 参考实现：`~/iWorkspace/open-source/llm-retry-proxy`，引擎 `retry_proxy/dlp.py`（594 行）+ 规则 `retry_proxy/dlp_rules.yaml`（131 行，v2，15 条）+ 注入点 `retry_proxy/api.py:586-648`（约 60 行）。同一项目也是 auto-retry（ADR 0003）的来源。
- 参考引擎的关键性质：**纯函数**，输入 `(body_bytes, enabled_rules, ...) → DlpResult`，不读配置、不碰网络、不依赖框架。`load_policy` 是唯一 IO（读 YAML），走 `lru_cache`。
- iRouter 侧事实（已核实）：
  - 请求体在 `src/sse/handlers/chat.js:65` `await request.json()` 首次成为完整对象；`Request` 只能读一次。
  - 该读取**当前位于 `withAutoRetry` 闭包内**（`chat.js:54-58`），配合 `DEFAULT_AUTO_RETRY.enabled = true`（`open-sse/services/autoRetry.js:10`），限流重试的第 2 次尝试必然抛 `TypeError: Body is unusable` → 返回 400。已用仓库真实模块复现。
  - pre-translate hook（`open-sse/rtk/*`）运行在 `translatedBody` 上，即**翻译之后**（`open-sse/handlers/chatCore.js:258/264/279/285/292`）；脱敏必须在**客户端 body** 上做，才能统一覆盖全部 translator。
  - 无统一入站入口：18 个路由文件、8 处独立 body 读取。chat 家族 6 条路由（`chat/completions`、`messages`、`responses`、`api/chat`、`responses/compact`、`v1beta/models/[...path]`）共享 `handleChatOnce`。
  - `confbox@0.2.4` 已是 prod 直接依赖、零运行依赖，`confbox/yaml` 可用（`parseYAML`/`stringifyYAML` 实测通过），TOML 已在用（`src/app/api/cli-tools/codex-settings/route.js:9`）。**无需新增依赖**。
  - `requestDetails` 默认落盘完整 `messages`（`requestDetailsRepo.js:31` 判据 `OBSERVABILITY_ENABLED !== "false"`），但读取侧已 redact（`src/app/api/usage/request-details/route.js:57-65`）、备份已排除（`src/lib/db/backup.js:17`）。

## Goals / Non-Goals

**Goals:**

- 转发前检测并改写敏感内容，三档动作可切，默认关闭
- 规则集为数据文件，可与参考实现逐行 diff
- 引擎纯函数、可单测、fail-open（ADR 0005）
- 顺带修复请求级自动重试的整体失效

**Non-Goals:**

- **落盘脱敏**（`requestDetails` 表）——独立立项，见 ADR 0005
- **入站 gzip/deflate 解压后扫描**（参考 `decode_inbound_body`）——需同步改 `Content-Encoding` 转发语义，而 iRouter 的客户端与网关在本机回环，压缩请求体不是现实威胁面；留待有真实需求时再做
- **audio / video 请求体**——`formData()` 与 `.text()`+`arrayBuffer()` 路径，请求体常为二进制，需要单独的判定语义
- **逐条规则 UI 开关**——14 个 Toggle 的 UI 工作量与收益不匹配；需要定制的走 `DLP_RULE_FILE`
- **`DLP_FAIL_CLOSED` 开关**——见 ADR 0005
- 逐条移植参考实现的 `csv_credentials` 规则——其正则针对参考项目自己的 `key_pool.csv` 格式，与 iRouter 号池结构无关
- **请求体体积上限**（参考的 `DLP_MAX_BODY_BYTES` / 超限 413）——参考实现是代理，手里只有字节，故在解压与体积两处设门；我们的入口已是解析后的对象，体积语义属调用方，且本机回环不存在"匿名大体积攻击"面。`dlpMaxBodyBytes` 仅作为设置项保留，当前不参与判定

## Decisions

1. **引擎落 `open-sse/dlp/`，硬约束零 `@/` import**。与 `open-sse/rtk/` 归类一致（同为请求改写 hook）。DLP 引擎本身不需要 settings 与凭据——签名是 `(body, rules, opts) → result`；设置读取与已知密钥收集留在 app 侧调用方。这样 open-sse 对 app 的耦合面不扩大（现有 7 处 `@/` import 全部指向薄叶子，不指向有状态 repo）。
2. **注入点在 body 解析之后、转发之前**，作用于**客户端 body**，不是 `translatedBody`。理由：翻译后脱敏需要覆盖每种目标格式；客户端 body 上做一次即统一覆盖。且 `clientRawRequest.body` 自然与出站一致，日志不会出现"记的是明文、发的是脱敏"。
3. **重试修复与脱敏共用一次改动**：`handleChat` 把解析提到重试外，`handleChatOnce` 增加 `body` 形参（缺省时兜底自解析，保持直接调用本函数的测试可用）。重试复用同一对象是安全的——对 body 的原地改写（`stripUnsupportedModalities`、`prefetchRemoteImages`、`applyEffortToBody`）均为幂等，且"整个账号回退循环共用一个 body 对象"本就是既有模式（`chat.js:310-416` 循环内仅 `body: { ...body, model }` 浅拷贝传参）。
4. **第一版覆盖 chat 家族 + embeddings + images**，不做全部 8 处。前者改 1 处（`handleChat`）覆盖 6 条路由；embeddings 的 `input` 与 images 的 `prompt` 是"批量粘文本"的高风险面且都是纯 JSON，各一行。audio/video 见 Non-Goals。
5. **规则集 = 仓库内置 YAML + `DLP_RULE_FILE` 覆盖**。保留参考实现规则文件的注释（它同时是文档），可与上游 diff。用 `confbox/yaml`。
6. **动作三档 + 默认 off**。参考实现默认也是 off；iRouter 是既有产品的桌面版，升级不得改变流量行为。规则各自可带 `action` 覆盖全局模式（`_rule_action` 语义）。
7. **fail-open，不移植 `fail_closed`**。见 ADR 0005。
8. **豁免标记：引擎实现，默认关**。`dlpAllowExemptions` 默认 `false`，与参考实现一致。redact 模式需要逃生舱——误报切碎 prompt 时用户得能表达"这段确实要发"。
9. **已知密钥精确匹配：做**。iRouter 存着全部上游凭据，可构造合并正则（长度 ≥ 8、非空、按长度降序、进程内缓存）。零误报是这个功能里最稀缺的属性，且能抓到"把 A 供应商的 key 粘给 B 供应商"这一最典型泄漏。代价是进程内多一份明文副本——这些 key 本就明文躺在同进程可读的 SQLite 里。
10. **UI：Profile 页**（一个三选一下拉 + 已知密钥/豁免两个 Toggle），不新开页面、不塞进 token-saver 页（后者语义是省 token，混入安全功能会让两边文案都别扭）。
11. **JS 移植的技术要点**（对齐参考实现行为，不照抄语法）：
    - **正则状态**：Python `finditer` 无状态；JS 模块级正则带 `g`/`y` 时 `.exec()` 共享 `lastIndex`，并发请求会互相污染。**必须用 `matchAll` 或每轮新建正则**——这是移植里最容易埋的并发 bug。
    - **`_BINARY_KEYS` 跳过**：参考实现对超长 base64 做 `_BASE64.fullmatch` 判定是否内联二进制。**实测证伪了设计初稿的"灾难性回溯"判断**：该正则与三个候选正则在 JS 下均为线性（2MB base64 全串 7.6ms；200KB 候选 0.3–1.0ms）。故**照搬参考实现语义，不做改写**。真正的资源保护来自解码预算而非正则改写。
    - **熵计算**：Python 按 code point，JS 按 UTF-16 码元。非 ASCII 输入的熵值会有细微差异——注释说明，不追求逐位一致。
    - **重序列化**：`json.dumps(ensure_ascii=False)` → `JSON.stringify`。差异：JS 对象中整数样式的字符串键会被提前排序，大整数丢精度。对 LLM 请求体影响很小，但需注释，否则将来会有人对着"body 被重排了"debug。修正 `Content-Length` 由调用方负责。
    - **`secret_group` / `placeholder` 校验**在规则加载期完成，与参考实现相同（配置错误应在启动/首次加载暴露，而不是静默失去防护）。
12. **单测直译参考实现的 `tests/test_dlp_api.py`**（249 行）作为验收标准，外加规则文件的加载/校验用例。

## Risks / Trade-offs

- **误报会切碎正常上下文**（尤其 redact 档）。缓解：默认 off；`keywords` 预筛；`min_entropy` 阈值；`validator`（身份证校验位 / Luhn）压误报；`allowlist`（`your_key` / `example` / `placeholder` 一类示例值）；豁免标记作为逃生舱。
- **性能**：每条文本字段 × 规则数。缓解：`keywords` 预筛让多数规则在关键词缺席时零开销；`max_matches` 限制单字段命中数；解码递归有候选数/字节数预算。参考实现已有这些机制，照搬。
- **已知密钥正则随凭据数量增长**。缓解：长度降序 + 进程内缓存 + 变更失效；凭据数量在桌面场景是几十量级。
- **重复读取已修复，但重试复用同一 body 对象意味着"上一次尝试对 body 的改写会被下一次继承"**。已核实现有改写全部幂等（见 Decisions 3）。**代价**：若将来新增非幂等的 body 改写，会静默影响重试。已在 `chat.js` 修复处注释说明。
- **`requestDetails` 仍存明文**（ADR 0005 的已知边界）。UI 文案必须写明，否则用户会误以为开了脱敏本机就干净。

## Migration Plan

无数据迁移。`mergeWithDefaults` 兜底新增设置项。升级 tag 时冲突面：`src/sse/handlers/chat.js`（解析位置）、`embeddings.js`、`imageGeneration.js`、`settingsRepo.js`、Profile 页 + 新增 `open-sse/dlp/` 目录。

## Open Questions

- 参考实现规则集里的 `saas_tokens` 有一条 `keywords: [... 'sk']`——`sk` 子串极常见（`sk-` 前缀的 key、`task`、`ask` 等词都含），在 JS 侧是否保留待实测误报率后再定。
- 规则集的 PII 三条（`email` / `phone_cn` / `ip_address`）保持 `enabled: false`；v1 不暴露逐条开关，故对普通用户不可达。是否需要"PII 预设"一键开启，观察真实需求。
