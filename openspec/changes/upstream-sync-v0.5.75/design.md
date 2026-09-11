## Context

- iRouter 的 `main` 含上游 v0.5.69（commit `eb712ca8` 与其**逐字节相同**）作为真实祖先，其上 55 个本地提交；本仓库已 fetch 上游 `origin` = `https://github.com/decolua/9router.git`
- 本次同步目标 = upstream HEAD `17c4cc76`（= `v0.5.75` tag `83af3f18` + `17c4cc76` claude-code auto-compact/1M、`73cb8914` xiaomi-mimo 双认证），`package.json` 版本仍为 `0.5.75`
- 试跑实测（两个 target 各跑一次，临时分支已清理）：merge `v0.5.75` 与 merge `17c4cc76` **都只冲突 `.gitignore`**；`chatCore.js`（我们加 `effortCap` vs 上游加 `shouldDefaultClaudeToolType`）、`providers/[id]/page.js`（我们改 CSS token vs 上游加 Cline 导入按钮）、`driver.js`（我们改降级告警 vs 上游加 Node≥24 守卫）三个双改文件全部自动合并，双方改动同时存活
- 版本号现状：`src/shared/constants/config.js` 被我们改成硬编码 `version: "0.0.9"`（上游为 `version: pkg.version`）；`desktop/main.js` 用 CSS `::after` 覆盖侧栏品牌/版本为 `app.getVersion()`，并在冒烟检查中断言两者相等；`open-sse/shared/clineAuth.js` 的 `User-Agent: 9Router/${pkg.version}` 与上游一致

## Goals / Non-Goals

**Goals:**

- 上游 v0.5.69 → HEAD 的全部改动进入本项目，本地 55 个提交的定制零丢失
- 用户可见版本号一律 `0.1.0`；上游基线号仅保留在源码内部（UA / `X-Msh-Version` / `_meta.appVersion`）
- 消除"硬编码版本号随发版过期"的维护点（下次同步不再需要手改 `config.js`）
- 建立可复用的同步机制与验收门槛，让下一次同步是一条可重复的路径而非一次性操作

**Non-Goals:**

- 不做部分摘取（Q2 决策：全量对齐）；不在此次改动上游未触及的本地定制
- 不改壳层功能（Q11 决策 (B)：仅版本号 + description 元数据）
- 不引入 submodule 或补丁机制（ADR 0002/0003 已否决）
- 不把 32 个非中文语言字典补齐（Q9 决策 (A)）

## Decisions

1. **merge target = upstream HEAD `17c4cc76`**（Q14 决策 (B)）。理由：冲突面与 `v0.5.75` tag 完全相同（都只有 `.gitignore`），却额外拿到 `driver.js` 的 Node ≥ 24 守卫——该守卫消除本项目 Node 26 环境上的进程级 SIGSEGV 风险，且它与 xiaomi-mimo 提交捆绑，单独摘取需手工切 diff。代价是引入未发布的 xiaomi-mimo 双认证（以纯新增文件为主，最坏情况是面板多一个 provider 入口）。

2. **集成机制：`sync/v0.5.75` 分支上整标签 merge，review 后并入 `main`**（Q3 决策）。理由：只有 3 个重叠代码文件且都是不同 hunk，merge 冲突接近于零；按簇 revert 比 cherry-pick 27+2 个提交（含跨文件依赖，qoder 重写即 5 个新文件 + 3 处调用点）省一个数量级操作，且保住血缘便于下次同步。

3. **版本号口径（Q4 + Q12 + Q13 决策）**：两套版本号，职责分离
   - **上游基线号**（`0.5.75`）：留在根 `package.json` 与 `cli/package.json`（由 merge 自动带上），供 `clineAuth.js` 的 UA、`appConstants.js` 的 `X-Msh-Version`、`db/version.js` 的 `_meta.appVersion` 使用——与上游完全对齐，排查"跑的是哪个基线"以此为准
   - **产品版本号**（`0.1.0`）：`desktop/package.json` 为唯一真源；`desktop/scripts/build-server.mjs` 构建网关时读它并以 `NEXT_PUBLIC_APP_VERSION` 注入；`config.js` 取 `process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0"`，面板侧栏与 Profile 页因此都显示 `0.1.0`，与壳层 CSS 覆盖值和冒烟断言天然一致
   - 为何不保留 `config.js` 的硬编码：硬编码会在下次发版时再次说谎；为何不让 `config.js` 回到上游的 `pkg.version`：那会让面板显示 `0.5.75`，违背"桌面版可见版本号一律 0.1.0"的决策
   - 为何用 `NEXT_PUBLIC_` 环境变量而非运行时读文件：`config.js` 被客户端组件导入（`Sidebar.js` 有 `"use client"`），运行时 `fs` 不可用；构建期内联是唯一直通客户端的路径，且仓库已有 `NEXT_PUBLIC_CLOUD_URL` / `NEXT_PUBLIC_BASE_URL` 先例

4. **`.gitignore` 冲突解**（Q8 决策）：合并双方尾部追加块——我们的 `node_modules/`、`.next/`、`out/`、`desktop/build/`、`.pi/`、`*.log`、`*.dmg`、`*.AppImage`、`*.exe`、`.tmp-ocr/` 与上游的 `9router-*` 全部保留，中文分节注释保留。

5. **i18n 补键范围**（Q9 决策 (A)）：只补 zh-CN 与 zh-TW。待补键：
   - 两字典都缺：`Import from /models`、`Error fetching models`、`Please add an active Cline connection first`、`models`
   - 仅 zh-TW 缺：`Fetching...`
   - 其余 4 个上游新键（`Successfully added`、`No models returned`、`Failed to fetch models`、`All models already exist, no new models added`）两字典均已有，无需动
   - 缺键时 `translate()` 回退原文，英文界面无感，故 32 个非中文语言不补

6. **验收门槛**（Q10 决策）：四件事全过才算完成，见 tasks.md 第 4 节。

7. **不摘取上游 revert 提交**：上游 `248d7da0` 是对同区间内某个 sibling 提交的 revert（9 个文件的 Responses usage plumbing），整个区间在这些文件上净零。整标签 merge 天然得到正确的净结果，**不得**单独 cherry-pick 该提交。

## Risks / Trade-offs

- **24h session cookie 与自建面板守卫同域**：`dashboardSession.js` 新增 `maxAge: 24h` 改变了我们 `login/page.js` + `proxy.js` + `dashboardGuard.js` 的登出/重登面。两者都是增量改动、不直接冲突，但必须实机验证：登录 → 关闭面板 → 重开 → 会话仍有效；退出登录 → cookie 被清。
- **用量配额新键流经我们重写过的组件**：上游新增 `gemini_weekly` / `claude_gpt_weekly` 配额行，`parseQuotaData`（`ProviderLimits/utils.js`）的调用点落在我们改过的 `ProviderLimits/index.js`。需确认新键在配额表按"周窗口"渲染，且**不被**误当作计费模型行进定价/Est. Cost 逻辑（本项目有自定义定价页与 PricingModal）。
- **`better-sqlite3` 守卫改变驱动选择**：Node ≥ 24 上将不再尝试 `better-sqlite3` 而直接走 `node:sqlite`。本机实测该模块能 load，但守卫按版本号硬跳过——这是上游的有意设计（SIGSEGV 不可捕获）。注意本机实测走的是 WAL 模式数据库，说明当前未使用 sql.js 兜底。
- **引入未发布的 xiaomi-mimo 功能**（21 文件 / ~1900 行）：本项目不接小米 MiMo，该功能处于休眠状态；风险限于面板多一个 provider 入口与新增路由文件。
- **测试基线必然移动**：上游改动推动 `providers-baseline.json`（Codex `cliVersion`/UA）等快照。必须**有意识地**重新快照并 review 差异，不得让 baseline 静默漂移以掩盖回归。
- **`effortCap` 与上游 Claude 改动的语义叠加**：我们的 effort 钳制在 `applyThinking` 层，上游在 `formats/claude.js` 新增 cache_control 预算与 tool-type 门控，作用于 `system`/`tools`/`messages`。无直接冲突，但 `/v1/messages` → claude-target 是本项目 `/v1/messages` 流量的咽喉，需回归验证。
