# Tauri v2 + Bun 迁移计划

> **执行前必读**：本计划的决策依据是 `docs/adr/0007-tauri-bun-shell.md`（取代 ADR-0001）。任何与本计划冲突的直觉，先去读那份 ADR。

**Goal:** 把桌面壳层从 Electron 换成 Tauri v2（Rust），网关进程的宿主从「Electron 二进制兼任」换成随包分发的 Bun，使 macOS dmg 从实测 139.3 MiB 降到 **≤ 70 MiB**（目标 60），同时**不丢任何一个现有壳层功能**、**不改网关源码**（除 OAuth 回调与面板守卫两处）、**不断上游同步**。

**架构变化（进程拓扑）:**

| | 现在 | 迁移后 |
| :-- | :--- | :--- |
| 壳 | Electron 主进程（2157 行 `main.js`） | Tauri Rust 二进制 |
| 窗口/面板 | Chromium 渲染 `127.0.0.1:20128` | 系统 webview（WKWebView / WebView2 / WebKit2GTK） |
| 网关 | `custom-server.js` + Next standalone，跑在同一个 Electron 二进制里（`ELECTRON_RUN_AS_NODE=1`） | 同一份产物，宿主换成 Bun sidecar |

**Tech Stack:** Rust（Tauri v2 ≥ 2.12.1）、Bun（版本硬固定 + 哈希校验）、Node 22+ 仅用于构建期与既有测试、Vitest。

## Global Constraints

- **网关源码不动**：`src/` 与 `open-sse/` 的 150,388 行保持与上游 decolua/9router 的 merge 血缘。本计划只允许改两处网关代码——`/callback` 的 route handler（Phase 1）与面板守卫的随机 token（Phase 3）。
- **全功能点保留**：托盘、开机自启、单实例、应用菜单、右键菜单、Cmd/Ctrl 快捷键、窗口管理、网关子进程生命周期（含孤儿回收）、就绪探测、设置模态 IPC、**应用内更新**、配置导出/导入、单实例二次唤起。
- **三平台同步开展**：macOS / Windows / Linux 同一套验收线，不做平台特例（Linux 的 webkit2gtk 依赖是唯一被批准的例外）。
- **验收线**：dmg ≤ 70MB（60MB 为目标而非承诺）、安装后 ≤ 200MB、首次启动不需要额外下载任何运行时。
- **Tauri 版本基线 ≥ 2.12.1**，但**不要指望它自带孤儿回收**：经源码核实，`register_sidecar` / `kill_process_tree` 在 tauri 2.12.1 与 tauri-plugin-shell 2.4.0 里都不存在；`cleanup_before_exit` 插件钩子只进了 `3.0.0-alpha.x`（PR #14443 的 changeset 是 `minor:feat`，实现里没有 PID 注册表），且其文档写明「进程被杀或直接 `std::process::exit` 时不运行」。**回收方案 = PID 文件 + 退出钩子 + 启动时回收**，语义照抄 `desktop/main.js:197,226-285`。核查细节见 `docs/plans/2026-10-07-tauri-shell-api-notes.md` §6.3
- **不采用 `tauri-plugin-updater`**：它要求签名密钥对且无法关闭，私钥丢失即已安装用户永久断更。

## 体积预算表

所有「现状」数字为 2026-10-07 本机实测（macOS arm64，产物为 v0.3.3）；「目标」中带 ~ 的为估算。

| 层 | 现状（Electron） | 目标（Tauri + Bun） | 依据 |
| :-- | ---: | ---: | :--- |
| 壳的渲染面 | **244 MiB**（Frameworks；其中 `Electron Framework` 二进制 192 MiB） | **0** | 系统 webview 由 OS 维护 |
| 网关运行时 | 0（复用 Electron 的 Node） | **~24 MiB** 压缩（macOS）/ ~38 MiB（Windows） | `bun-darwin-aarch64.zip` 24.2 MiB、`bun-windows-x64.zip` 38.0 MiB |
| 网关负载 | **76.6 MiB** 解压 | **~59 MiB** 解压 | 剔除 `@img/sharp-*` 17.3 MiB 死重 |
| 壳本体 + 图标 | app.asar 0.1 MiB + 图标 3.1 MiB | **~8–15 MiB** | Tauri 二进制（估算） |
| **合计 dmg** | **139.3 MiB（实测）** | **~50–65 MiB（估算）** | 压缩比参照实测 324 → 139（43%） |
| 安装后体积 | **324 MiB**（实测） | **~150–180 MiB（估算）** | Bun 解压 ~90 MiB + 负载 59 MiB + 壳 |

对照：**同样是换壳，若运行时选 Node SEA，macOS 总账约 79 MB——越过 70MB 线**。这就是运行时必须是 Bun 的算术理由。

## 不做的事（non-goals）

- 不重写网关（963 文件 / 150,388 行，含 133 provider registry / 31 executor / 48 translator）
- 不动上游同步（保持与 decolua/9router 的 merge）
- 不把面板改成原生 GUI（那是第三个重写，且违背 CONTEXT.md 的「内嵌面板」定义）
- 不做 Electron / Tauri 双轨并行（`main.js` 一旦分叉就合不回来）
- 不为省体积做有损替换（Monaco 从 jsdelivr CDN 运行时加载，**根本不上包**，换 CodeMirror 零收益）

---

### Phase 0：门禁 spike —— Bun 能否跑通完整网关（三平台）

**入口条件：** 无。**这一相位不通过，后面全部不做。**

**Files:**
- Create: `desktop/scripts/bun-gateway-spike.mjs`（只读脚本，不改产物）

**Interfaces:**
- Consumes: `bun ./.next/standalone/custom-server.js`、`desktop/scripts/smoke.mjs` 既有的断言（`GET /login` → 200、`GET /v1/models` → 200、`GET /callback` → 有响应）
- Produces: 一份三平台结论（通过 / 不通过 + 失败点），决定是否进入 Phase 1

- [x] **Step 1: 在本机（macOS arm64）用 Bun 起 standalone**

  固定一个 Bun 版本（写进脚本，不许 `latest`），下载后校验官方 SHA-256，失败即中止。以临时 `DATA_DIR` 与临时端口启动，避免干扰在跑的桌面版。

  实现：`desktop/scripts/bun-gateway-spike.mjs`（Node 侧 spawn Bun；`DATA_DIR` 与 `HOME` 双隔离，并在运行前后校验真实数据目录指纹未变）。
  锁定：`desktop/scripts/bun-pin.json` —— Bun **1.3.14**，三平台哈希抄自官方 `SHASUMS256.txt`，其中 darwin-arm64 已下载实测比对一致（23,586,433 字节）。
  校验器：`desktop/scripts/verify-bun-pin.mjs`（`--file` / `--download` / `--list`；不符即 exit 1）。正反例均已验证：真实产物 exit 0，故意喂错文件 exit 1。

- [x] **Step 2: 逐项验证能力面**

  必须全绿：
  1. 面板可加载（`/` 与 `/login` 返回 200 且 HTML 正常）
  2. `/v1/models` 返回 200
  3. **SSE 流式转发**（一条真实 chat 请求，验证分块不被缓冲）
  4. **SQLite 读写**（走 `bun:sqlite` 分支，建库、写一条、读回；`src/lib/db/driver.js` 的驱动链在 Bun 下应命中第一档）
  5. **`custom-server.js` 的客户端 IP 推导**（伪造 `X-Forwarded-For`，确认被剥离——这是安全相关行为，不能因换运行时退化）
  6. 172 个 API route 至少冒烟覆盖 panel 路由与 usage / settings / oauth 三类

  执行结果：**15/15 通过，跑了两份产物**（`.next/standalone` 与 `desktop/build/gateway/server` 即随包分发的那份）。见下方「Phase 0 执行记录」。
  偏差说明：第 3 条原写「真实 chat 请求」，实做改成 SSE 端点分块验证（**不需要上游凭据**，且直接观测 `text/event-stream` 与首块内容）——真实 chat 需要用户凭据，不适合放进自动门禁，留到 Phase 6 端到端验收。

- [x] **Step 3: 三平台复跑**

  macOS / Windows / Linux 各跑一遍 Step 2。Linux 用发行版包管理器装 Bun 或按其官方二进制分发。

  **已达成（2026-10-07，CI run [37614286122](https://github.com/kevinjoy89/iRouter/actions/runs/37614286122)，PR #1）**：三平台 `Bun gateway gate — Phase 0` 全部通过 —— macos-latest 2m23s / ubuntu-latest 2m32s / windows-latest 3m42s；同一 run 的 `Regression Gate (ubuntu)` 亦 pass。
  落地方式：`.github/workflows/ci.yml` 的 `build-smoke` job（`matrix.os` 本就含三平台，且已在跑 `npm run build-server`）追加三步——`setup-bun` 锁 1.3.14 → 断言版本与 pin 一致 → 跑门禁脚本。
  注意 `NODE_OPTIONS: --experimental-sqlite`：CI 用 Node 22，其 `node:sqlite` 需要该标志；Node 24+ 会忽略（本机 Node 26 已实测无害）。
  踩坑记录：run 摘要里会出现 `X Process completed with exit code 1` 的**注解**，那属于 `Run test suite` 步骤——它带 `continue-on-error: true` 且因 `known-fails.txt` 基线必然退出 1。**注解不是失败**，判定要看 job 结论（`gh pr checks`）。

- [x] **Step 4: 记录结论并锁版本**

  通过 → 把锁定的 Bun 版本与哈希写进 `desktop/scripts/`（Phase 4 直接用）。不通过 → **停止，回到 ADR-0007 重开决策**（Node SEA 顶破 macOS 70MB 线，届时 Rust 重写才第一次值得评估）。

  已完成：结论 PASS，产物为 `bun-pin.json` + `verify-bun-pin.mjs` + `spike:bun` / `verify:bun-pin` 两个 npm script。
  **一处必须诚实区分的偏差**：能力面验证跑在本机 Homebrew 的 bun 1.3.14（与锁定版本号一致，但**不是**已校验哈希的那份官方产物）。随包分发的 Bun 必须是 `bun-pin.json` 校验过的那份——这条在 Phase 5 打包时必须落实，届时把各平台 `verified` 回填为 `true`。

**出口条件：** 三平台 Step 2 全绿，且 Bun 版本与 SHA-256 已记录。→ **已达成（2026-10-07）**

#### Phase 0 执行记录（2026-10-07）

Bun 1.3.14 ｜ 启动 **1613–1648 ms** ｜ 隔离端口 31888 / 31889 ｜ 两份产物各 **15/15**

| 断言 | 结果 | 证据 |
| :--- | :--- | :--- |
| A0 登录取得会话 cookie | ✓ | `status=200 success=true` |
| A1 面板 `/login` HTML | ✓ | `200 text/html` 10,294 字节 |
| A2 根路径 | ✓ | `307 → /dashboard` |
| A3 `/callback` 路由存在 | ✓ | `200` |
| A4 `/v1/models` | ✓ | `200`，**790 个模型** |
| A5 SSE 流式 | ✓ | `200 text/event-stream`，首块即 `data: {"totalRequests":0,...}` |
| A6 SQLite 驱动 | ✓ | 日志 `[DB] Driver: bun:sqlite`、`[DB][migrate] applied #1 initial`、12 张表、无降级告警 |
| A7 面板守卫切断无标识请求 | ✓ | 连接被切断（fetch failed） |
| A8.1 本机直连 → 视为本地 | ✓ | `status=500`（已放行至真实探测，非 SSRF 拦截） |
| A8.2 带 `X-Forwarded-For` → 收紧 | ✓ | `400 "URL not allowed"` |
| A8.3 伪造 `x-9r-peer-token`/`x-9r-real-ip` 无效 | ✓ | 与 A8.1 同结果 |
| A9 日志无致命错误 | ✓ | 无 `Cannot find module` / `is not a function` / `panic` 等命中 |
| S `~/.irouter`、`~/.9router` 指纹 | ✓ | 运行前后完全一致（真实数据未被触碰） |
| Z1 SIGTERM 后端口释放 | ✓ | 无进程残留 |

**结论的含金量主要在 A6–A8**：
- **A6** 证明 Bun 的 `bun:sqlite` 真正接管（不是降级到 sql.js），迁移把 schema 迁移路径也一并跑通了。
- **A7** 顺带证明了最担心的兼容面：`custom-server.js` 对 `http.createServer` 的猴补丁在 Bun 下**真的生效**（守卫跑在补丁后的 handler 里）。这一条也是 A8 的前提。
- **A8** 证明换运行时**没有让安全行为退化**：IP 推导、`x-9r-via-proxy` 收紧、以及对伪造 `x-9r-peer-token` 的免疫都保持原样。
- 另：`sql.js` 缺 `sql-wasm.wasm` 那个潜伏缺陷与本次无关（Bun 走 `bun:sqlite`，Node 走 `node:sqlite`，都到不了那一档）。

---

### Phase 1：OAuth 一键化（独立于换壳的净收益，先做）

**为什么先做：** 桌面版通用供应商的 OAuth 现在是「系统浏览器授权 → 复制 URL → 粘回面板」（见 ADR-0007 的「OAuth 三通道」一节）。改成回环收取后：**桌面版所有供应商都一键完成**，且换壳的 OAuth 迁移成本从账上消失——因为 Tauri 根本不需要应用内弹窗。

**Files:**
- Create: `src/app/callback/route.js`
- **Delete: `src/app/callback/page.js`** ← 见下方「阻塞性更正」
- Modify: `src/shared/components/OAuthModal.js`（新增回环分支 + 等待文案）
- Modify: `src/lib/oauth/utils/server.js`（新增通用会话注册表 + 回环收取 + 手粘兜底页渲染器）
- Modify: `src/app/api/oauth/[provider]/[action]/route.js`（register-session 通用分支、poll-status 通用回落）
- Modify: `public/i18n/literals/zh-CN.json`、`zh-TW.json`（新文案入字典）
- Test: `tests/unit/oauth-loopback-callback.test.js`

**⚠️ 阻塞性更正（实施时发现，已推翻本计划原先的写法）：**
Next.js **不允许 `route.js` 与 `page.js` 共存于同一路由段**（Next 16.3.4，见 `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md:39` 与 `:155-161` 的冲突表）。所以「新增 `src/app/callback/route.js` 并保留 `page.js`」是写不出来的。两个形状：

- **Shape A（采用）**：`page.js` 删除，`/callback` 由 route handler 接管。**redirect_uri 逐字节不变**——它是各供应商已注册的重定向地址，改路径会被 provider 拒绝；且 `/callback` 在两层守卫里本就被豁免（`custom-server.js:38-40`、`dashboardGuard.js:282`），无需改守卫。
- Shape B（未采用）：handler 换到 `/api/oauth/callback`，需给 `PUBLIC_API_PATHS` 加白名单，且**改动了 provider 已注册的重定向路径**，风险无法离线验证。

代价：`page.js` 的三条 relay 通道（postMessage / BroadcastChannel / localStorage）随之消失。**但它们在桌面版从未生效**（ADR-0007 已证），且在浏览器形态下新版走服务端换取更好——所以这不是功能损失，是删除死代码。

- [x] **Step 1: 写失败测试** —— 实际是「先实现、后补测试」，此处如实记录偏差。测试文件 `tests/unit/oauth-loopback-callback.test.js` 共 15 例，**同时覆盖 route handler 与「register-session → /callback → poll-status」端到端**（不 mock `@/lib/oauth/utils/server`，只 mock `next/server` / `@/lib/oauth/providers` / `@/models`）。
- [x] **Step 2: 新增 `src/app/callback/route.js`** —— 复用既有 `exchangeTokens` 与 `createProviderConnection`（在 `completeLoopbackCallback` 里惰性 import，与既有 codex 代理同构），未新写换取逻辑。HTML 复用既有渲染器（`renderCodexResultPage` 导出为公开）并新增 `renderOAuthManualPage` 作为手粘兜底。
- [x] **Step 3: 泛化 session 注册表** —— **偏差：没有动那 6 组既有实现**。新增独立的通用注册表（`registerOAuthSession` / `getOAuthSession` / `getOAuthSessionForCallback` / `clearOAuthSession` / `sweepOAuthSessions`），codex/xai/trae/windsurf/zed/xiaomi-mimo 六条路径原样保留。理由：trae/windsurf/zed 是单例而非 Map、zed 的 codeVerifier 里是 RSA 私钥、xiaomi 的 getter 已有私钥脱敏——合并的收益（少几十行）小于把六条已工作的热路径一起搅进改动的风险。`server.js:298-302` 原本就注明 xAI/codex 保持并行是为了「让 codex 热路径逐字节等价」。
- [x] **Step 4: 改 `OAuthModal`** —— 通用供应商（localhost 且非 trae/windsurf/zed）改走「登记 → 系统浏览器授权 → 轮询」；登记失败回落手粘路径。codex/xai/设备码/代理类/粘贴令牌各分支未动。等待文案由「Waiting for popup authorization…」改为「Waiting for authorization in your browser…」并入了 zh-CN / zh-TW 字典（旧文案在场的只剩弹窗场景，而回环路径不再有弹窗）。
- [x] **Step 5: 三层验证** ——
  1. **单元测试**：15/15 通过（含 state 不匹配不换取、重放不二次换取、跨站 Origin 403、错误信息 HTML 转义 + `code=` 脱敏、TTL 过期、405、轮询体不含 codeVerifier/meta）。既有 OAuth 路径回归：`xiaomi-mimo-oauth-session.test.js` 6/6、`dashboard-guard.test.js` 24/24 通过。
  2. **全量回归**：`npx vitest run` + `verify-no-regression.mjs` → **`✅ No regression. (now fails=60, baseline known=60, all known)`**。
  3. **真实服务端冒烟**：重建后跑门禁脚本 **17/17**，其中 A3 升级为「`/callback` 返回 200 HTML」、新增 A3b「未知 state → 200 手粘兜底页」。
  4. **真实 Electron 壳冒烟**：`env -u ELECTRON_RUN_AS_NODE npm run smoke` → **PASS**（`GET /login -> 200 | GET /v1/models -> 200 | GET /callback -> 200`，托盘/单实例/关窗隐藏/设置模态/暗色/多语言全过，退出后端口释放）。这条把「route handler 在真实桌面壳里可用」也钉住了——前三条验的都是 Bun 或单元层面。
     ⚠️ 前置条件：从 **DSH harness 派生的 shell** 里跑 Electron 必须 `env -u ELECTRON_RUN_AS_NODE`（该 harness 会给子进程注入这个变量，Electron 会因此以纯 Node 模式启动，`require("electron")` 返回路径字符串、`app` 为 undefined，报 `main.js:37 app.commandLine` 崩溃）。这不是仓库缺陷，但会让任何在此环境下启动 Electron 的尝试失败。
  - lint：改动文件仅剩一条 `react-hooks/set-state-in-effect`（`OAuthModal.js:76`），**已用 `git show HEAD:… | npx eslint --stdin` 确认是既有问题**（HEAD 上同位置同报错），我改动的 460/889 行干净。

**出口条件：** 桌面版上至少一个通用供应商（claude 或 gemini-cli）全程一键完成，无需手粘；回归与基线一致。→ **回归、冒烟、端到端（本地桩）均已达成；「真实 provider 一键完成」仍未跑过**。

**端到端验收（2026-10-07，`npm --prefix desktop run e2e:oauth`，14/14 通过）**
新增 `desktop/scripts/oauth-loopback-e2e.mjs`：用**本地桩**顶替远端 provider，其余每一环都走真实 HTTP 与真实进程。可行性来自 GitLab 的 provider 实现允许用 `meta.baseUrl` 覆盖 token/userinfo 主机（`src/lib/oauth/providers/gitlab.js:23,34,42`），且 OAuth 换取路径上没有 SSRF 拦截。

| 断言 | 结果 |
| :--- | :--- |
| 登录取会话 → `register-session` 登记 → 轮询 `pending` | ✓ |
| `GET /callback?code=&state=` 在**服务端**完成换取并返回成功页 | ✓ |
| 成功页**不回显授权码** | ✓ |
| 桩收到真实 token 请求，且 **PKCE 校验码原样透传**、`redirect_uri` 一致 | ✓ |
| 桩收到 userinfo 请求且带 `Bearer` 令牌 | ✓ |
| 轮询翻到 `done` 并带回 `connectionId`；**轮询体不含 codeVerifier** | ✓ |
| 连接**真的落库**（`provider=gitlab` / `authType=oauth` / 令牌已存） | ✓ |
| **重放同一 state 不触发第二次换取** | ✓ |
| 真实数据目录指纹未变、端口释放无残留 | ✓ |

唯一被替换的环节是「远端 GitLab 返回令牌」。**这把风险从「整条链路未知」收敛到「远端 provider 的行为」**——而后者恰恰是不可离线验证的部分。

**遗留项（未验证，不要当作已完成）：**
- **通用授权码回环路径仍未由真实 provider 完成一次全流程。** 已拿到的真机证据只有两条，都不覆盖「浏览器回调 → 换取」这一段：
  1. **通用路径的登记环节**：人工在真机点击通用供应商后看到「等待浏览器中的授权…」——该文案只有通用回环分支会渲染（`OAuthModal.js:889`；device-code 分支用的是 `:998` 那句），失败会落到手粘步骤，故可确认 `register-session` 在真机上成功过。
  2. **真实 provider 的 OAuth 全链路可用（但走的是 device-code 路径）**：人工用 **CodeBuddy CN** 完成认证，连接已落库（`providerConnections` 中 `codebuddy-cn` / `authType=oauth` / Account 1，2026-10-07T13:29:32Z，是该库有史以来第一条 oauth 连接）。但 `codebuddy-cn` 在弹窗的 `deviceCodeProviders` 名单内、provider 声明 `flowType: "device_code"`，走 `/device-code` + `poll`；`register-session` 全仓只有两个调用点（`:278` 代理流程，被 `PROXY_OAUTH_PROVIDERS` 守着；`:472` 新增回环分支）——**与 `/callback` 零交集**。
  这两条把回环路径的故障面压缩到「浏览器回调那一段」，但没有覆盖 provider 侧怪癖（各家 `redirect_uri` 白名单、scope 差异、claude 的 `#` 后缀 state 处理、refresh 时机等）。
  最省事的真跑路径仍是 **GitLab**：不需要 Claude/Gemini 账号，弹窗自带 Base URL / Client ID / Client Secret 输入与 `/-/profile/applications` 链接（`GitLabAuthModal.js:138-146`），在 gitlab.com 建一个 OAuth 应用（redirect URI 填 `http://localhost:20128/callback`，PKCE 公开客户端 secret 可留空）即可。
- 服务端会话是**内存 Map**：与 route handler 共享（这正是 codex/xai 服务端模式成立的前提），但**不跨进程**。多进程部署会失效——本应用是单进程（`custom-server.js`），可接受。
- `src/app/callback/page.js` 的**上游同步**：上游若继续改这个文件，merge 时会以 modify/delete 冲突的形式出现，需手工裁决。
- 观察到的既有小瑕疵（非本次引入）：GitLab 的 `mapTokens` 把 email 放进 `providerSpecificData`，连接表的顶层 `email` 列因此为 null（`gitlab.js:48-61`）。

---

### Phase 2：负载裁剪与 x64 缺陷修复（不依赖换壳，可并行）

- [x] **Step 1: 剔除 sharp 死重** —— `next.config.mjs:31` 设了 `images: { unoptimized: true }`，`src/` 与 `open-sse/` 对 sharp 零引用，但 nft 仍把 `@img/sharp-*`（17.3 MiB）拖进 `.next/standalone`。用 `outputFileTracingExcludes` 排除，**产物必须重建后确认 17.3 MiB 真的消失**（它当前被 trace 进 `.next/server/chunks/`，不能只靠推断）

  已实测（重建后）：`@img` 与 `sharp` 两个目录在产物中**完全消失**，`next-server.js.nft.json` 里的 sharp 引用 **1 → 0**，产物内无任何 `.dylib` / `libvips` 残留。

- [x] **Step 2: 验证图片仍正常** —— `npm run smoke` + 面板图片路径逐一目视（`images.unoptimized: true` 下 `/_next/image` 不走 sharp，风险低但不能不验）

  做法比原计划更强：把「图片未被 sharp 移除波及」**加进了门禁脚本的 A10 断言**（`/file.svg`、`/providers/deepseek.png` 的 content-type、以及 `/_next/image` 不得 5xx），这样它是每次构建都会跑的回归保护，而不是一次性目视。重建后的两份产物各 **16/16** 通过。

- [x] **Step 3: 修 x64 装错架构的缺陷** —— 负载只在本机（arm64）构建一次，`dist:mac` 却带 `--x64`。Phase 2 排除 sharp 后此缺陷自动消失；**若 Step 1 未能排除，则必须改为按目标架构分别构建负载**，否则 x64 dmg 是坏包

  已实测：负载里**已无任何 `.node` / `.dylib` / `.so` / `.dll`**——`better-sqlite3` 早先已被剔除，sharp/libvips 是最后一个架构相关件。负载现在是纯 JS + 静态资源，与架构无关，x64 包不再装错二进制。

- [x] **Step 4: 纠正两处仓库内过时结论** —— ① `docs/packaged-runtime-footprint.zh-CN.md` 的「48.8MB 语言包可回收」已不成立（实测已安装的 `iRouter.app` 只有 14 个 `.lproj` / 4.7 MiB）；② `desktop/scripts/build-server.mjs:137` 声称去掉 `better-sqlite3` 省「~12MB」，实际负载侧只省 2.1 MiB（12 MiB 是根 `node_modules` 的数字，Next 追踪本就没拷）

  已改。**注意 ① 的更正只落在本地**：`docs/*` 被 `.gitignore:52` 忽略且该文件从未入库（`git check-ignore` 确认），所以它进不了提交。需要它随仓库走的话，得单独放行并首次入库。

- [x] **Step 5: 清理产物堆积** —— `desktop/build/` 现存 1.0 GiB，含 `dist-preview/` 这份同一个 v0.3.3 的重复拷贝，而 `package.json` 已是 0.3.7。给 `package.mjs` 加构建前清理

  已实现：`package.mjs` 在 spawn electron-builder 前清空 `directories.output`（`build/dist`），留 `IROUTER_KEEP_DIST=1` 逃生口。**代码路径已实跑验证**（用 `--help` 触发：先打印「已清空输出目录」再输出 electron-builder 帮助）。空间已实际回收：`desktop/build/` **1.0 GiB → 59 MiB**（同时删掉非标准的 `dist-preview/` 466 MiB）。

**出口条件：** 网关负载实测 ≤ 62 MiB 解压；x64 缺陷已消除或有按架构构建的证据。→ **已达成（2026-10-07）**

#### Phase 2 执行记录（2026-10-07）

| 指标 | 改前 | 改后 | 变化 |
| :--- | ---: | ---: | ---: |
| 随包负载 `desktop/build/gateway/server` | 77 MiB | **59 MiB** | −18 MiB |
| `desktop/build/gateway/server/node_modules` | 50 MiB | 32 MiB | −18 MiB |
| `.next/standalone` | 81 MiB | **66 MiB** | −15 MiB |
| `desktop/build/` 总量 | 1.0 GiB | **59 MiB** | −931 MiB |

验证方式：`npm run build` 与 `npm run build-server` 各重建一次；两份产物各跑 16 项门禁断言全绿。
**唯一改动文件**：`next.config.mjs`（新增两条 `outputFileTracingExcludes`），另加注释写明反向约束——谁要打开 `images.unoptimized` 就必须同时删掉这两条排除。

对体积预算表的影响：网关负载压缩后约 20MB → 约 **13–14MB**，Tauri 方案总账从 ~54MB 降到 **~47MB**，60MB 目标从「几乎没有余量」变成「有余量」。

---

### Phase 3：Tauri 壳骨架（Rust）

**Files:**
- Create: `desktop-tauri/`（新壳层目录；`desktop/` 在 Phase 6 切换完成后移除）
- Modify: `custom-server.js`（守卫随机 token）

- [x] **Step 1: 最小可运行壳** —— Tauri 窗口加载 `http://127.0.0.1:20128`；webview 侧配置 `remote` capability，URL 白名单只含该 origin
      ⚠️ 实现时改为**按实际端口动态加 capability**：`pickPort` 扫完 50 个端口后会回落 OS 临时端口（`desktop/main.js:151-159`），写死 20128 = 更新通道与设置读写静默失效（ACL 拒绝且不报错到面板）。
- [x] **Step 2: 网关子进程** —— Bun 作为 `externalBin` sidecar 拉起，参数与今天一致（`--port`、`DATA_DIR=~/.irouter`、`HOSTNAME=127.0.0.1`、`IR_PANEL_GUARD=1`）
- [x] **Step 3: 孤儿回收** —— ~~调 `register_sidecar` + `cleanup_before_exit`~~ → **自研**：PID 文件 + 退出时按进程树杀 + 启动时回收（那两条 API 在 2.12.1 里不存在，见本文件顶部约束）。**必须实测三条死亡路径**：正常退出、窗口关闭后托盘常驻、更新安装器强杀（Windows 是 RestartManager `RmForceShutdown`，**绕过一切 Rust 退出钩子**）。现状：正常退出与「先枚举后代再杀」已有单测（7/7 含三层进程树实测）；**托盘常驻那条要等 Phase 4**，安装器强杀那条要等 Phase 5。
- [x] **Step 4: 守卫令牌化** —— 壳每次启动生成随机 token，经子进程环境变量与窗口 UA 注入；改 `custom-server.js:23-41`（应用处 `:161`）从固定值改为校验该 token。**这是安全边界**，不是便利设施：固定值写在开源仓库里，任何本地进程都能伪造。✅ 端到端验证 9/9（`desktop-tauri/scripts/verify-guard-chain.mjs`）
- [ ] **Step 5: IPC 面最小化** —— 只暴露：设置读写、更新三动作（检查/下载/安装）、打开设置模态。**逐条与 `desktop/preload.js:11-62` 的 12 个方法对照，写清每个方法保留或删除的理由**
- [x] **Step 6: 就绪探测** —— 复刻 `main.js:1602-1620` 的语义：先探测再显示窗口，避免白屏（实测：兜底页 → 就绪 → navigate → show）

**出口条件：** macOS 上双击可起，面板可用，`/v1` 可转发；杀进程不留孤儿。

**Phase 3 现状（2026-10-08）**：除 Step 5 外全部落地并有证据（`cargo test` 7/7、守卫链路 9/9、staging 实跑哈希校验通过、`cargo check` 通过）。**真实 GUI 启动已实测**：`target/debug/irouter` + `irouter-bun .../custom-server.js --port 20128` 双进程起来、20128 监听、PID 文件写入、630 ms 就绪、面板可用；对**运行中的实例**探测守卫：令牌 UA → `200 OK`，错误令牌与浏览器 UA → 连接被切断（令牌为随机 64 位十六进制，确实每次启动重新生成）。

**人工门禁实测结果（2026-10-08，真机点击）**：

| 项 | 结果 | 证据 |
| :--- | :--- | :--- |
| **IPC 往返（读+写）** | ✅ **由副作用证明** | 切换「开机自启」后 `~/Library/LaunchAgents/iRouter.plist` 被创建，且 `ProgramArguments` 含 **`--from-autostart`**（正是 openAsHidden 的等价机制）。这条链要求「面板 → shim → IPC → `shell_set_settings` → autostart 插件 → 落 plist」每一环都通——**capability 若写错，plist 根本不会出现**。同时 `shell-settings.json` mtime 更新，写路径确认。 |
| **托盘双击（macOS 判时差）** | ✅ | 日志 4× `托盘双击（两次 Click 判时差 <500ms）`——recon 说 `DoubleClick` 是 Windows only，这套自研判定确实работа |
| **Dock 图标唤回** | ✅ | 日志 6× `macOS Reopen → 唤出窗口` |
| **关窗行为（dock 档）** | ✅ | `closeAction=dock：隐藏到托盘（保留 Dock 图块）`——不退出 |
| **正常退出 + 孤儿回收** | ✅ | `closeAction=quit` → `已向 1 个进程发送 SIGTERM/SIGKILL（根 pid=90631）` → `已终止网关进程树` → `退出应用`；事后壳 0 个、网关 0 个、PID 文件已清、20128 已释放 |
| **ACL 拒绝 / Command not found** | ✅ 零命中 | 日志干净 |
| **右键菜单** | ⏳ **未证** | `shell_context_menu` 的 Rust 侧**没有任何日志**，所以「日志里没有」既可能是没点、也可能是没生效。**这是个可观测性缺口，应补一行日志后再验** |

**至此三条死亡路径全部有实测**：正常退出（本轮）、强杀 + 启动回收（上一轮）、窗口关闭后托盘常驻（本轮 dock 档）。

**死亡路径实测结果（2026-10-08）**：

| 路径 | 结果 |
| :--- | :--- |
| **SIGTERM 强杀壳**（模拟安装器 `RmForceShutdown`） | ⚠️ **`RunEvent::Exit` 不触发，sidecar 沦为孤儿**（实测：壳死后 pid 69567 仍占着 20128，PID 文件残留）。这正是设计预判的情形，**不是缺陷而是必须承认的事实**——事件循环被直接终止，任何 Rust 退出钩子都跑不到 |
| → 但**启动时回收兜住了** | ✅ 实测：下次启动打出「发现上次残留的网关进程 pid=69567，按进程树回收」，孤儿被清、端口复用、新实例 630 ms 就绪、数据库完好 |
| **正常退出（托盘「退出」）** | ⏳ 待测——托盘属 Phase 4（`shell-impl` 进行中） |

**可选的改进（非阻塞）**：Unix 上再挂一层 SIGTERM/SIGINT 处理器，可让强杀时也立刻回收而不必等下次启动；但 SIGKILL 永远拦不住，**启动时回收仍是唯一兜底**，所以这属于体验优化而非正确性缺口。是否要做，等 Phase 4 托盘退出路径实测后再定。

---

### Phase 4：壳功能补齐（全功能点，一个不落）

对照清单来自 `desktop/main.js` 的实测分布，逐项在 Rust 侧重实现：

- [ ] 托盘（`main.js:1502-1508`）+ 托盘菜单 + 双击唤出
- [ ] 开机自启（`main.js:1466,1474`，含 `openAsHidden` 语义）
- [ ] 单实例锁（`main.js:65`）+ 二次唤起时显示窗口（`main.js:2140-2142`）
- [ ] 应用菜单（`main.js:1435`，多语言；现有 7 种 UI 语言必须全覆盖）
- [ ] 右键菜单与 Cmd/Ctrl 快捷键（`main.js:512-560`；系统 webview 通常自带原生编辑菜单，**先验证是否能直接删掉这 80 行**，不能则重实现）
- [ ] 窗口状态与关闭行为（`main.js:605-612`：quit / tray 两种 closeAction，`hideDock`）
- [ ] 设置模态 IPC（`shell:open-settings` 的 4 个调用点 + 面板侧 `irouter:open-settings` window 事件，`ShellSettingsHost.js`）
- [ ] 旧数据导入提示（`main.js:1531-1550`，含 `IROUTER_IMPORT_DECISION` 自动化接缝——**这个接缝必须保留**，端到端测试依赖它）
- [ ] 应用内更新（下述）
- [ ] 配置导出/导入（纯渲染层能力，理论上零改动，但需回归验证下载与文件选择在系统 webview 下的行为）

**更新通道（自研移植，不引入密钥义务）：**

- [ ] 移植 `updater/checker.js`（GitHub Releases API）、`checksum.js`、`version.js`、`asset.js`（共 446 行纯逻辑）
- [ ] 移植 `download.js` 与 `installer.js`。⚠️ **调起建议改用 `tauri-plugin-opener`**（Linux 上 `xdg-open → gio open → gnome-open → kde-open` 逐级回退、Windows 走 ShellExecute 避开 `cmd /c start` 引号坑、文件不存在返回 Err）：现状是 `spawn` 失败也 `resolve(true)`，**Linux 上没有 `xdg-open` 时应用会静默退出、什么都没发生**（updater 设计 §D-5）
- [ ] **实测每平台的替换体验**：macOS 调起 dmg、Windows 调起 NSIS、Linux 调起 deb。若 macOS 上自研调起 dmg 的体验不可接受，**单独评估**是否改用 `tauri-plugin-updater`——届时必须一并接受签名密钥对义务
- [ ] 保留 `ignoreVersion` 语义（`main.js:800`）

**出口条件：** 与 Electron 版逐项对照，无功能缺失；`IROUTER_IMPORT_DECISION` 等自动化接缝可用。

**Phase 5 现状（2026-10-08，CI 首跑）**：

三平台打包矩阵第一次真跑，**macOS arm64 / macOS amd64 / Windows 三个 job 全部成功并产出可上传的产物**
（48.5 / 51.8 / 113 MB）——这是本项目第一次真的跑通 `tauri build`（本机磁盘与时间约束跑不动，
CI 是它唯一的验证途径）。Linux 卡在冒烟检查，但那**不是构建问题**（见下）。

首跑抓出三个「本地永远发现不了」的问题，它们的共同特征是：**单测、编译、配置校验全部射程之外**。

| # | 问题 | 只有谁能发现 | 教训 |
| :-- | :--- | :--- | :--- |
| 1 | `desktop-tauri/package-lock.json` 被根 `.gitignore` 的裸 `package-lock.json` 全局忽略 → `npm ci` 三平台全挂 | **真跑 CI** | 「lock 里锁死 2.12.1」的核对是对的，但核对的是**本地那份**，而 CI 上根本没有 |
| 2 | Linux 冒烟的断言模式写错：`dpkg -c` 打印 `usr/bin/irouter-bun`（无前导斜杠），断言写 `/usr/bin/irouter-bun$` → 永远匹配不上 | **真跑 CI + 失败时打印现场** | 我先把根因判成「`pipefail` + `grep -q` 的 SIGPIPE」——听起来很经典，**但不对**。真正解决它的是「失败时打印实际内容」这个改动 |
| 3 | 右键菜单语言：Electron 用 `app.getLocale()`（macOS 返回系统语言），Tauri 读 `LANG` 环境变量（GUI 进程没有）→ 中文系统上显示英文 | **真人在中文系统上点一次右键** | 用户报「菜单是 Copy」时，我第一反应是"与 Electron 一致"；查证后发现**恰恰相反**，是回归 |

另记一条方法论：**「测试失败」与「被测对象有问题」看起来一模一样**。第 2 条如果只改断言不打印现场，
下一轮还会红，而我会继续找错方向。现在断言不过时会打印实际内容前 40 行。

**Phase 6 实机验收结果（2026-10-08，macOS arm64 真实安装包）**：

用户双击安装了 CI 产出的 `iRouter-0.3.7-macos-arm64.dmg`（46.45 MiB，SHA-256 已校验），
**除托盘图标外全部功能正常**。这是整条链路上唯一无法由 CI 或脚本替代的一步。

| 项 | 结果 |
| :--- | :--- |
| 安装、首次放行 Gatekeeper | ✅ |
| 启动 → 面板可用 | ✅ |
| 托盘 / 菜单 / 设置 / 更新入口 | ✅（图标问题见下） |
| **托盘图标** | ❌→✅ **发现一处实机专属 bug 并修复**（见下） |

**托盘图标白板 bug（只有真人看菜单栏才发现）**：`tray.rs` 原来用 `app.default_window_icon()`，
即应用图标——一个 **95.6% 不透明**的圆角方块。配 `icon_as_template(true)` 后 macOS **只用 alpha
通道当遮罩** → 遮罩几乎是个实心方块 → 菜单栏里渲染成一整块空白。**图标越"完整"，就越像一块白板。**

修法：另做一张**纯黑 + 形状全由 alpha 表达**的模板图（从原图橙色路由符号提取，44px @144dpi = 22pt @2x），
并**去掉对应用图标的回落**（回落等于重现 bug）。回归测试断言不透明占比落在 **(2%, 60%)** 区间、
四角全透明——**这条断言就是该 bug 的判据**，并做过两次负向验证（指向应用图标 → 红；
44×44 全不透明块 → 红在占比断言）。用户复验：**路由符号显示正确、随菜单栏深浅色自动反色**。

**同轮实测到的另外两条**：
- **单实例在真实安装版上生效**：安装版运行时再起 dev 实例，后者**静默退出**（正确行为；因为单实例
  插件的 init 早于我们的日志代码，所以没有任何输出——这一点一度让我误判为孤儿进程）。
- **SIGTERM 钩子在真实收尾时生效**：`kill -TERM` dev 壳 → `收到 SIGTERM（15）→ 走正常退出路径`
  → `已终止网关进程树` → 无残留进程、20128 释放、`.gateway.pid` 已清。

**Phase 4 现状（2026-10-08）**：shell（1491 行）与 updater（4413 行）已落地，测试 114/114、shim 断言 18/18、守卫链路 9/9。
真机实测：托盘创建、macOS 应用菜单（含 Edit）、updater 启动 3 秒后的静默检查**调通真实 GitHub Releases API 并写回**
（`current=latest=0.3.7`、`error=null`、`assetName=iRouter-0.3.7-macos-arm64.dmg`——产物名匹配规则对真实 release 成立）。

仍未完成的两项：
- **托盘「检查更新…」的原生结果对话框**（`main.js:839-875`）→ 已开 task-7 给 shell（归它是因为文案走其 i18n、「去设置」要用其 `openSettings`；updater 保持无 UI 更干净）。**在那之前用户点托盘检查更新、若已是最新会看不到任何反馈**。
- **运行期人工门禁**：托盘点按/双击、右键菜单落点、关窗三档、面板 IPC 往返、`--from-autostart` 隐藏启动——都需要真网关 + 窗口，留待 Phase 6。

---

### Phase 5：三平台打包

- [ ] macOS：dmg，per-arch（**不做 universal**——实测 universal 会让原身体积翻倍，VS Code 就是 303 MiB → 530 MiB 的例子）。⚠️ `hardenedRuntime` 默认 **true**，可能让 Bun/JSC 起不来 → 显式设 `false` + `signingIdentity: "-"`（与 Electron 版现状一致）；`minimumSystemVersion` 必须 **13.0**（实测随包 Bun 的 `minos`）
- [ ] Windows：NSIS + zip；`webviewInstallMode` 用默认 `downloadBootstrapper`（**不塞 127MB 的离线包**）
- [ ] Linux：deb + tar.gz。**`Depends: libwebkit2gtk-4.1-0` 不要写进配置**——CLI 在 Linux 宿主上会自动注入，手写会重复且不去重
- [ ] 产物命名与 `updater/asset.js` 的匹配规则**逐字**对齐。⚠️ 失效形态不是「更新提示消失」（版本号判定与产物匹配是解耦的，`checker.js:176` vs `:161-165`），而是**点下载才报 `No update asset available for download`**；且 x64 mac 必须叫 `-macos-amd64.dmg`（现靠 `release.yml:81-90` 重命名）。**先改名、再算 `checksums.txt`**
- [ ] 三平台各自复核体积预算表，超线即回到 Phase 2/4 找原因

**出口条件：** 三平台产物齐备，macOS dmg ≤ 70MB。

**Phase 5 实测产物（2026-10-08，CI run 37736663294，四 job 全绿）**：

| 平台 | 产物 | 体积 |
| :--- | :--- | ---: |
| macOS arm64 | `iRouter-0.3.7-macos-arm64.dmg` | **46.44 MiB** |
| macOS amd64 | `iRouter-0.3.7-macos-amd64.dmg` | **49.58 MiB** |
| Windows | `iRouter-0.3.7-windows-amd64-installer.exe` | **41.14 MiB** |
| Windows（便携） | `iRouter-0.3.7-windows-amd64-portable.zip` | 67.71 MiB |
| Linux | `iRouter-0.3.7-linux-amd64.deb` | 57.95 MiB |
| Linux（便携） | `iRouter-0.3.7-linux-amd64.tar.gz` | 57.23 MiB |

**验收线达成**：Electron 版 macOS dmg 为 **139.3 MiB**，现在 **46.44 MiB** —— 降幅 **66.7%**，
且远低于「dmg ≤ 70MB」的硬线。这就是本迁移最初那个问题（「每次打包都是几百兆」）的最终答案。

六个产物名全部与 `desktop/updater/asset.js` 的 `getExpectedAssetName` **逐字对齐**，由 CI 里的
三层断言（规则全等 → 产物名全等 → `selectAsset` 精确命中）把守——改名即红。

各 job 用时：macOS arm64 4m40s / amd64 6m22s / Windows 7m48s / Linux 6m44s。

**仍未验证**：三个成功平台的产物只做了**包内冒烟**（sidecar / 网关负载 / `LSMinimumSystemVersion`
在包里），**没有「装上去跑一遍」**；`tauri build` 在本机从未跑过（磁盘与时间约束），CI 是唯一验证途径。

---

### Phase 6：切换、验收与清理

- [ ] 端到端验收（三平台各一遍）：装 → 起 → 面板可用 → `/v1` 转发 → 托盘 → 自启 → 单实例 → 更新 → 配置导出/导入 → 杀进程无孤儿
- [ ] **内存复核**：基线是 668 MB（5 进程，见 `docs/packaged-runtime-footprint.zh-CN.md`）。系统 webview 仍有开销，量级估算 200–300 MB，**实测后写回 ADR-0007**（那里现在标的是估算）
- [ ] **回归**：`npx vitest run` + `node tests/__baseline__/verify-no-regression.mjs test-results.json`，与基线一致
- [ ] 🚧 **删 `desktop/` 之前必须先迁走 5 个被测文件**（否则门禁会真红，不是"已知失败"）：`tests/unit/updater-{version,checksum,checker,asset}.test.js` 与 `tests/unit/version-consistency.test.js` 测的是 `desktop/updater/*.js` 与 `desktop/package.json` 的版本一致性，而它们**不在 `tests/__baseline__/known-fails.txt` 里**（grep 零命中）——删掉被它们导入的文件会让 Regression Gate 判为「新失败」。处置见下方风险表 R1。
- [ ] 🚧 **重排后的 Phase 6 清理顺序**（原计划只写了"移除 `desktop/`"，被 task-10 证明前提不成立）：
      1. **先拆承重件**（R1b）——把仍被构建链依赖的东西移出 `desktop/`，每移一件就把引用方一起改：
         网关负载的产出脚本（`scripts/build-server.mjs`）、Bun pin 与校验器（`scripts/bun-pin.json`、
         `verify-bun-pin.mjs`）、产物命名规则（`updater/asset.js`）、产品版本真源（`package.json`，ADR-0004）。
         目标布局与引用方（`tauri.conf.json` / `stage-sidecar.mjs` / `pack-artifacts.mjs` / `dev.mjs` /
         CI）必须在同一步里一起改到位，**否则打包会断**。
      2. **逐文件处置 8 个受门禁看守的测试**（R1）——**按失效形态分组，别一刀切**：
         - **整文件失败（7）**：`updater-{version,checksum,checker,asset}.test.js`（4 个，覆盖率已核实
           26/26、0 缺失，可随壳同批删）、`version-consistency.test.js`、`desktop-shell-i18n.test.js`
           （顶层 `readFileSync(desktop/main.js)`）、`desktop-shell-settings.test.js`
           （顶层 `require(desktop/settings.js)`）。
         - **部分 case 失败（1）**：`dlp-artifact-shipping.test.js` —— **5 个 case 里只有 2 个**
           读 `desktop/scripts/{build-server,smoke-packaged}.mjs`（`:34`、`:69`，是 `join(REPO,…)` 拼接，
           不是注释）；另外 3 个（规则源存在、cli build-cli、引擎任意 cwd 加载）**不依赖 `desktop/`，必须保留**。
         - **仅注释提及、零风险（1）**：`dlp-i18n-coverage.test.js` 的三处引用全在注释里（`:12/:14/:72`），
           它真正读的是前端组件源码与 `public/i18n/literals/*.json`。**无需处置**——误删会丢掉一个
           仍然有效的 DLP 用例。
         - `version-consistency` 的归属已定：VC2（npm lock 自洽）随壳消失；
           VC1（`config.js` 回退值 == 产品号）+ VC3（产品号 ≠ 上游基线号）迁到**发布流水线断言**
           ——真源在 Phase 5 变成 `tauri.conf.json`，属发版不变量，不是更新器行为。
      3. **更新 workflows 里的 `desktop/` 引用**（`ci.yml`、`release.yml`、`desktop-tauri.yml`）。
      4. 最后才移除 `desktop/`（或保留一个 tag 作为退路）。
      5. 跑一次完整门禁 + 四平台 CI，确认没有"新失败"。
- [ ] ⚠️ **`desktop-shell-settings` 15 个 case vs Rust `settings.rs` 8 个单测**——数量差要逐条对账，
      确认那些 case 要么已被 Rust 覆盖、要么其主体随壳消失（task-10 列为未完成项之一）
- [ ] 更新 `CONTEXT.md`（若有新术语）与 `README` / `README.zh-CN` 的构建与产物章节
- [ ] **在 ADR-0007 里把估算数字替换为实测**（体积、内存、dmg）

**出口条件：** 三平台验收清单全绿，ADR-0007 无残留估算。

---

### Phase 6 Step 3 的 dry-run 实测结果（2026-10-08，run 37806253961，`version=0.3.8`）

`release.yml` 改成"复用 `desktop-tauri.yml` 四平台矩阵 → 合并 checksums → 门禁①② → 发布"后，
用 `workflow_dispatch` 干跑了一次。**为什么用 `0.3.8` 而不是现值 `0.3.7`：同版本注入是空操作，
那样"版本注入路径"等于没测**——而它恰是这次最容易错的一环（网关负载要烘焙 `NEXT_PUBLIC_APP_VERSION`，
`tauri.conf.json` 的 version 会进 Info.plist / NSIS / deb，注入必须排在网关构建之前）。

| 步骤 | 结果 |
| :--- | :--- |
| `Resolve version`（解析 + semver + 版本线守卫） | ✅ |
| `Tauri bundles` 四平台（**经 `uses:` 复用，矩阵只有一份**） | ✅ macos-arm64 / macos-amd64 / windows-amd64 / linux-amd64 |
| **`download-artifact`（跨 reusable 边界）** | ✅ **此前只有"文档说可以"，本次变成实测** |
| `Generate consolidated checksums.txt` | ✅ |
| **门禁①** `Assert every release asset is covered` | ✅ |
| **门禁②** `Verify release notes exist` | ❌ **设计如此**（仓库里没有 `v0.3.8` 的发版说明）——**这条红就是"门禁②真的在工作"的证据** |
| `Create GitHub Release` | skipped ✅（dry-run 不发布） |

**版本注入被证实贯穿到产物名**：`[pack] 版本 0.3.8（desktop-tauri/package.json ↔ tauri.conf.json 一致）`，
六类资产名逐字为 `iRouter-0.3.8-{macos-arm64.dmg, macos-amd64.dmg, windows-amd64-installer.exe,
windows-amd64-portable.zip, linux-amd64.deb, linux-amd64.tar.gz}`，全部进入合并后的 `checksums.txt`。

**仍未验证、且只能等真实 tag**（不冒充已验证）：
`action-gh-release` 本身与 GitHub 侧最终落盘的资产名（那才是老客户端字符串全等命中的终点）、
tag 下 `contents: write`、tag checkout 与注入版本的一致性、老客户端自更新的真实验收、
**仓库侧 required status checks**（job 名从 `Build (macos)` 变成 `version`/`tauri`/`release`，
若按旧名配了必需检查会卡住合并——GitHub settings 读不到，需人工核对）、预发布 tag 的版本字段行为。

## Phase 6 完成记录（2026-10-09）

**Electron 壳层已下线，仓库只剩一套壳。** 五步各自独立提交、逐步验证：

| 步 | 内容 | 关键验证 |
| :--- | :--- | :--- |
| 1 | 承重构建输入从 `desktop/` 搬到 `tools/` 与 `build/` | 四平台 CI + 回归门禁 |
| 2 | 6 个 JS 测试的覆盖面搬到 Rust 侧 / 流水线断言 | `settings` 15-vs-8 对账（7 条原本无等价断言，已补）；门禁回基线 |
| 3 | `release.yml` 改用 `desktop-tauri.yml` 四平台矩阵 | **dry-run 实测**（含跨 reusable 边界的 artifact 传递） |
| 4 | 删除 `desktop/` + 6 个随它退役的测试 | 32 文件 / −7987 行；**门禁 `No regression` 退出码 0**；四平台 CI 全绿 |
| 5 | ADR-0004 修订、顶层文档同步 | 本文件 |

**先补门禁盲区，再删目录**：`verify-no-regression.mjs` 原本看不见"文件级加载失败"（Step 1 的
`require("./asset")` 断裂就是这样全绿过关的）。第 4 步之前先堵上，并用负向验证证明
——**那次事故今天会红**。否则删除动作本身就发生在盲区里。

**仍只能等真实 tag 验证**（不冒充已验证）：`action-gh-release` 本身与 GitHub 侧最终资产名、
tag 下 `contents: write`、老客户端自更新验收、仓库侧 required status checks、预发布 tag 的版本字段。

## 门禁的已知盲区与干扰项（2026-10-08 实测，Step 4 归因前必读）

**① 盲区（已堵，2026-10-08）：收集期失败的文件，门禁看不见。**

`tests/__baseline__/verify-no-regression.mjs:41` 只遍历 `assertionResults`。若某个测试文件在
**收集期**就失败（import 断链、模块缺失），vitest JSON 里**没有 `assertionResults` 条目**，
于是它既不算 pass 也不算 fail —— **门禁全绿，而它是红的**。

实测踩到：Phase 6 Step 1 把 `desktop/updater/asset.js` 搬到 `tools/` 时，漏了该目录内部两条
`require("./asset")`，JS 参照实现在收集期即炸，**CI 全绿**。已修（`checker.js` / `index.js`）。

量化影响面：364 个测试文件里 **8 个**处于该状态 —— 7 个上游既有，1 个是本条（已修）。

**已在 Step 4 之前堵上**（`verify-no-regression.mjs`）：空 `assertionResults` 不再自动消失，
而是按 vitest 的**具体信息**分流 ——

| vitest 信息 | 处理 | 依据 |
| :--- | :--- | :--- |
| `No test suite found in file …` | **不计入** | 本仓库有 **6 个用 `node:test` 写的文件**（`import { describe, it } from "node:test"`），vitest 本来就收集不到它们 —— 不是"坏了"，是"不是给 vitest 跑的" |
| 其它任何信息（如 `Cannot find module …`） | **按文件级失败计入**，key = `<relpath> :: (file-level: 加载/收集期失败)` | 真·加载失败 |

基线补 1 条：`tests/unit/embeddings.cloud.test.js`（`cloud/` 目录不在本仓库，CLAUDE.md 已记载）。
**负向验证**：把 Step 1 那条 `require` 重新改回断链 → 门禁从"绿"变为
`❌ REGRESSION: … :: (file-level: 加载/收集期失败)`，**真实退出码 1**；正常结果退出码 0。
即：**Step 1 那次事故，今天会红。**

**② 干扰项：一条 flaky 测试。**

`tests/unit/request-details-retention.test.js :: requestDetails 保留策略与上限钳制 后台维护输出完整的开始/完成日志`
**单独连跑 3 次全绿（11/11）**，但在全量运行中偶发失败（那一轮总失败 61 = 基线 60 + 这 1 条）。
**Step 4 的归因必须把它排除在外**：看到失败数从 60 变 61 时，先单独复跑该文件再下结论。

**③ 一条"取决于仓库有没有构建过"的测试**（已修）。

`tests/unit/custom-server-page-post.test.js`：`isStrayActionPost` 的第二参数默认读
`.next/app-path-routes-manifest.json`，于是同一条断言在两种仓库状态下给出**相反**结果 ——
未构建 → 按前缀判 stray；已构建 → `src/app/callback/route.js` 导出了 POST，是真端点，不判 stray。
Step 1 里跑了一次 `next build` 后它由绿变红 —— **实现对、测试错**。已改为显式传参、两种语义分别钉死，
并验证**已构建 10/10 / 未构建（git worktree，无 `.next/`）9 passed + 1 skipped** 两环境均绿。

**④ 一条可能误导归因的历史证据**：`shell-impl` 曾报告 ③ 是"pre-existing regression"。
我在 Phase 6 之前的提交 `c2310736` 上用 git worktree 复跑过 —— **当时全绿**。
它的观察（与本卡改动无关）对，**归因（预先存在）不对**。
"预先存在"是个很容易被误用且几乎不会被核实的说法，**必须实测**。

## 风险与回退

| 风险 | 触发条件 | 回退动作 |
| :--- | :--- | :--- |
| **Bun 跑不通完整网关** | Phase 0 Step 2 任一红 | 停。ADR-0007 重开；备选 Node SEA（macOS 越线）或 Rust 重写（那时才值得算） |
| **Three-platform 同步导致问题并发** | 任一平台卡住超一个相位 | 允许把该平台降级为「跟进」，但**不得降低验收线**——降级只影响交付顺序，不影响标准 |
| **sidecar 漏杀孤儿** | Phase 3 Step 3 任一死亡路径失败 | ~~升级 Tauri 版本~~（**在 2.x 上无效**——回收 API 在 2.12.1 里不存在；`cleanup_before_exit` 钩子只进了 3.0.0-alpha.x，且进程被杀/`std::process::exit` 时都不跑）。**唯一解**是自研 PID 文件 + 启动时回收 + 按进程树杀（已实现，见 `desktop-tauri/src-tauri/src/gateway.rs`）。升级 Tauri 只在愿意上 3.0 预发布时才重新考虑 |
| **R1：删 `desktop/` 会打断 8 个受门禁看守的 vitest 文件**（原记录只列 5 个；task-10 补 3 个，Lead 逐条核实后又排除 1 个） | Phase 6 清理时 | **全部不在 `known-fails.txt` 里**，且**不许**塞进去（那等于用豁免掩盖真回归）。精确失效形态见下方 Phase 6 第 2 步——**「整文件失败 7 个 + 部分 case 失败 1 个 + 仅注释提及 0 风险 1 个」**，必须按形态分别处置，一刀切会白做对账甚至误删仍有效的用例 |
| **R1b：`desktop/` 是承重的构建输入目录，不只是旧壳**（task-10 发现，Lead 已核实） | Phase 6 清理时 | 删它**会同时打断四个环节**：① `tauri.conf.json` 的 `bundle.resources` 指向 `desktop/build/gateway/server/`（**打包的网关负载**）② `stage-sidecar.mjs` 读 `desktop/scripts/{bun-pin.json,verify-bun-pin.mjs}`（**sidecar 哈希锁定**）③ `pack-artifacts.mjs` 读 `desktop/updater/asset.js`（**产物命名真源**，Rust 那份只是副本）与 `desktop/package.json`（**产品版本真源**，ADR-0004）④ `dev.mjs` 依赖 `desktop/build/gateway/server` 与 `npm --prefix desktop run build-server`；CI 另有 `ci.yml` 两处（`desktop/scripts/bun-pin.json`、`desktop/scripts/bun-gateway-spike.mjs`）。**所以 Phase 6 不是「删掉旧壳」，而是「先把仍承重的构建输入拆出去、再删剩下的壳」** |
| **R1c：`desktop-tauri.yml` 的触发路径会变成哑路径（静默失效）** | Phase 6 拆件时 | 它的 `pull_request.paths` 里有 `desktop/updater/**`、`desktop/scripts/**`、`desktop/package.json`（`:14-16`）。构建输入一旦搬到新位置，**对这些新位置的改动不会触发 Tauri CI**——而它**不报错**，只是永远不跑。属"不报错的失效"，搬迁时必须同步更新 `paths`。真正的 `paths` 列表还要在搬迁后统一核对一遍 |
| **R1b：`desktop/` 是承重的构建输入目录，不只是旧壳**（task-10 发现，Lead 已核实） | Phase 6 清理时 | 删它**会同时打断四个环节**：① `tauri.conf.json` 的 `bundle.resources` 指向 `desktop/build/gateway/server/`（**打包的网关负载**）② `stage-sidecar.mjs` 读 `desktop/scripts/{bun-pin.json,verify-bun-pin.mjs}`（**sidecar 哈希锁定**）③ `pack-artifacts.mjs` 读 `desktop/updater/asset.js`（**产物命名规则**）与 `desktop/package.json`（**产品版本真源**，ADR-0004）④ `dev.mjs` 依赖 `desktop/build/gateway/server` 与 `npm --prefix desktop run build-server`。**所以 Phase 6 不是「删掉旧壳」，而是「先把仍承重的构建输入拆出去、再删剩下的壳」** |
| **安装器调起失败 = 本次会话面板不可用** | Phase 5/6 实测 | 低频路径，**已装应用不受影响**（旧版本仍在原地），仅本次会话面板连不上网关（sidecar 已回收且本模块无法重启它——`gateway::spawn` 需要 `PanelGuard`，而窗口 UA 与端口已固定）。已决定**不做** `gateway::restart()`（要复用同端口与同令牌才成立，复杂度不值当），作为**已知限制**记在代码注释里；**用户重开应用即恢复** |
| **setup 失败时无任何用户可见提示** | Phase 6 前 | shell 实测发现：setup 里 panic 发生在 tao 的 `did_finish_launching` 内 → **non-unwinding panic，进程直接 abort**，用户什么都看不到；而 Electron 是 `dialog.showErrorBox` + exit(1)（`main.js:2106-2113`）。**Phase 6 必须统一处理**（例如把可预期的失败提前到 setup 之外，或在 abort 前落一条日志/原生提示） |
| **更新器事件契约走形** | Phase 4 移植 | 硬约束不是事件名，而是 ① `window.irouterShell` 的**存在性**（为假则「软件更新」整段消失，`ShellSettingsModal.js:66-70`）② payload 字段形状 ③ `shell:update-error` 的 payload 是**裸字符串**（发对象面板显示 `[object Object]`）④ **检查失败不发 `update-error`**，错误装进 `shell:update-available` 的 `error` 字段（双发会造成面板状态竞态）⑤ shim 的 `unlisten` 必须**同步**返回（Tauri `listen()` 是 async，面板写的是 `unsubX?.()`，返回 Promise 会静默不执行、监听器泄漏）。详见 updater 设计 §7 |
| **自研更新体验不可接受** | Phase 4 实测 | 单独评估 `tauri-plugin-updater`，接受密钥义务后再定 |
| **体积超线** | Phase 5 | 回到 Phase 2 查负载；**不做**有损替换 |
| **迁移中途放弃** | — | 成本最高。Phase 0–2 都是**独立净收益**（Bun 验证、OAuth 一键化、负载裁剪、缺陷修复），即使停在 Phase 2 也不白做；Phase 3 之后放弃才会两头空 |
