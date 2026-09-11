## Why

iRouter 的网关源码基于上游 decolua/9router **v0.5.69** 定制（ADR 0003：源码并入仓库根目录，升级 = 对比上游手工合并）。上游已发布 v0.5.75，其后另有 2 个未发布提交。这一区间的改动里有本项目直面的三类问题：

- **正确性缺陷落在我们正在用的路径上**：`claude-to-openai.js` 对"裸对象 content"的归一（走 `/v1/messages` → 自建 OpenAI 兼容节点的**必经之路**）、`codexToolSchema` 剥离校验器拒绝的 `\p{...}` pattern、`connectionsRepo` 在连接重新校验通过后清理残留健康状态（限流标记不清导致节点长期不恢复）。
- **进程级崩溃风险**：上游 `driver.js` 在 Node ≥ 24 上跳过 `better-sqlite3`——该原生插件在 Node ≥ 24 加载时 SIGSEGV，是 `try/catch` 兜不住的崩溃。本项目运行环境为 Node 26，打包版则在构建期剔除该模块；此守卫必须进。
- **新增能力**：视频 provider 适配层（OpenRouter / Vertex Veo）、Qoder 附件与上下文分层、Cline/ClinePass 信封解包与鉴权修复、Antigravity 周配额、Codex 图像模型、Kiro 线上格式修复等。

试跑 merge 证实冲突面极小：整标签 merge 与到 upstream HEAD 的 merge **都只冲突 `.gitignore` 一个文件**；我们与上游同时改过的 3 个代码文件（`chatCore.js`、`providers/[id]/page.js`、`driver.js`）全部自动合并，双方改动同时存活。

## What Changes

- **merge 上游至 HEAD `17c4cc76`**（`v0.5.75` tag + 2 个未发布提交），落 `sync/v0.5.75` 分支后并入 `main`；口径为全量对齐，本地定制全部保留
- `.gitignore` 冲突手工解：合并双方尾部追加块（我们的桌面打包/本地产物忽略项 + 上游 `9router-*`）
- **版本号统一到 `0.1.0`**：根 `package.json` 与 `cli/package.json` 随 merge 变为 `0.5.75`（上游版本，供 UA/`X-Msh-Version` 等头与上游对齐）；面板可见版本号与 `desktop/package.json` 一律 `0.1.0`
  - `src/shared/constants/config.js` 改为 `process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0"`，由 `desktop/scripts/build-server.mjs` 在构建期从 `desktop/package.json` 注入——消除"硬编码版本号随发版过期"的维护点
  - `desktop/package.json` `0.0.9` → `0.1.0`，description 的基线描述同步为 v0.5.75
- **i18n 补键**：merge 带入 9 个新 `translate()` key，其中 4 个在全部 34 个字典缺失（`Import from /models`、`Error fetching models`、`Please add an active Cline connection first`、`models`），另 `Fetching...` 在 zh-TW 缺失。补 zh-CN + zh-TW 两种（其余 32 个语言为上游原样）
- **测试基线重新快照**：`tests/__baseline__/providers-baseline.json` 随上游 Codex `cliVersion`/UA 变化需重新快照；上游新增的 11 个测试文件随之纳入
- 新增 ADR 0004 记录**版本号口径**决策（ADR 三门槛只过这一条：难逆转、不知情者会"顺手统一"、三个选项里挑了一个）；`CONTEXT.md` 更新"定制基线"词条并新增"上游同步"术语。本次同步的 merge target 与集成机制按同一门槛判定**不立** ADR（可逆、属 ADR 0003 已定政策范围），记在 `design.md` 决策 1–2

## Capabilities

### New Capabilities

- `upstream-sync`: 上游同步——基线推进的机制、冲突面判定与验收门槛（详见 design.md）

### Modified Capabilities

<!-- 无：openspec/specs/ 为空；既有 effort-cap / auto-retry / console-log-revamp 等能力不受影响（见 Impact） -->

## Impact

- **9Router 源码（仓库根目录）**：整标签 merge，92 + 23 个文件变更；本地定制零丢失（3 个重叠文件均为不同 hunk 的自动合并）
- **无数据库迁移**：上游 `src/lib/db/migrations/` 未改动；`connectionsRepo.js` 仅在既有 JSON `data` 列内清键；`_meta.appVersion` 会由 `0.5.69` 刷新为 `0.5.75`（既有行为，无迁移逻辑依赖）
- **无新增 npm 依赖**：两个 `package.json` 的差异仅是版本字符串；`next.config.mjs`、`custom-server.js`、`.env.example` 上游零改动
- **本地定制面核对**（全部与上游改动不相交，除已确认自动合并的 3 个文件）：auto-retry、effort cap（`chatCore.js` 的 `effortCap` 透传三处存活）、i18n 运行时与 34 个字典、console-log 页重写、desktop 壳层与面板守卫、用量定价
- **安全修复随之进入**：Vertex 视频 job id 的路径穿越/SSRF 校验、dashboard session cookie 24h `maxAge`、Cline 凭据不再被错误加 `workos:` 前缀、OpenRouter 视频 action/content-type 校验
- **风险点**：`src/lib/auth/dashboardSession.js` 的 24h cookie 与我们自建的面板守卫/登录路径同域，需实机验证登出/重登；用量配额展示（`ProviderLimits/utils.js` 新增 `gemini_weekly`/`claude_gpt_weekly` 键）流经我们重写过的配额组件与定价逻辑，需确认新键不被当作计费模型行
