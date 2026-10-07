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
- **Tauri 版本硬下限 ≥ 2.12.1**：sidecar 孤儿回收（`register_sidecar` / `cleanup_before_exit` / `kill_process_tree`）在 2026-09-18 的 PR #14443 才落地，更早的版本会漏杀进程树（NSIS 安装器用 `TerminateProcess`、更新器用 `std::process::exit`，两条路径都绕过 `Exit` 事件）。
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
- Modify: `src/shared/components/OAuthModal.js`（redirectUri 选择与 poll 分支）
- Modify: `src/lib/oauth/utils/server.js`（把 6 组近重复的 session 注册/查询泛化）
- Test: `tests/unit/oauth-loopback-callback.test.js`

**Interfaces:**
- Consumes: 既有 session/poll 原语（`/api/oauth/[provider]/register-session`、`/poll-status`，当前只支持 codex/xai/trae/windsurf/zed/xiaomi-mimo）
- Produces: `GET /callback?code=&state=` 直接完成换取并落库；modal 用既有 poll 拿结果

- [ ] **Step 1: 写失败测试** —— 覆盖：通用供应商回环 redirect 落到 route handler → 换取 → 连接落库；`state` 不匹配时拒绝；`/callback` 页面路径仍保留（系统浏览器降级路径不得回归）
- [ ] **Step 2: 新增 `src/app/callback/route.js`** —— 复用既有 `exchangeTokens` 与 `createProviderConnection`，不新写换取逻辑
- [ ] **Step 3: 泛化 session 注册表** —— 消除 `server.js` 里 6 组 `registerXxxSession` / `getXxxSessionStatus` 的复制粘贴
- [ ] **Step 4: 改 `OAuthModal`** —— 通用供应商改走回环 + poll；保留 `callback/page.js` 作为系统浏览器降级路径（三通道代码可留，但它不再是主路径）
- [ ] **Step 5: 三层验证** —— 单元测试 + 真实服务端冒烟（临时 DATA_DIR/端口）+ `npx vitest run` 全量 + `verify-no-regression.mjs`

**出口条件：** 桌面版上至少一个通用供应商（claude 或 gemini-cli）全程一键完成，无需手粘；回归与基线一致。

---

### Phase 2：负载裁剪与 x64 缺陷修复（不依赖换壳，可并行）

- [ ] **Step 1: 剔除 sharp 死重** —— `next.config.mjs:31` 设了 `images: { unoptimized: true }`，`src/` 与 `open-sse/` 对 sharp 零引用，但 nft 仍把 `@img/sharp-*`（17.3 MiB）拖进 `.next/standalone`。用 `outputFileTracingExcludes` 排除，**产物必须重建后确认 17.3 MiB 真的消失**（它当前被 trace 进 `.next/server/chunks/`，不能只靠推断）
- [ ] **Step 2: 验证图片仍正常** —— `npm run smoke` + 面板图片路径逐一目视（`images.unoptimized: true` 下 `/_next/image` 不走 sharp，风险低但不能不验）
- [ ] **Step 3: 修 x64 装错架构的缺陷** —— 负载只在本机（arm64）构建一次，`dist:mac` 却带 `--x64`。Phase 2 排除 sharp 后此缺陷自动消失；**若 Step 1 未能排除，则必须改为按目标架构分别构建负载**，否则 x64 dmg 是坏包
- [ ] **Step 4: 纠正两处仓库内过时结论** —— ① `docs/packaged-runtime-footprint.zh-CN.md` 的「48.8MB 语言包可回收」已不成立（实测已安装的 `iRouter.app` 只有 14 个 `.lproj` / 4.7 MiB）；② `desktop/scripts/build-server.mjs:137` 声称去掉 `better-sqlite3` 省「~12MB」，实际负载侧只省 2.1 MiB（12 MiB 是根 `node_modules` 的数字，Next 追踪本就没拷）
- [ ] **Step 5: 清理产物堆积** —— `desktop/build/` 现存 1.0 GiB，含 `dist-preview/` 这份同一个 v0.3.3 的重复拷贝，而 `package.json` 已是 0.3.7。给 `package.mjs` 加构建前清理

**出口条件：** 网关负载实测 ≤ 62 MiB 解压；x64 缺陷已消除或有按架构构建的证据。

---

### Phase 3：Tauri 壳骨架（Rust）

**Files:**
- Create: `desktop-tauri/`（新壳层目录；`desktop/` 在 Phase 6 切换完成后移除）
- Modify: `custom-server.js`（守卫随机 token）

- [ ] **Step 1: 最小可运行壳** —— Tauri 窗口加载 `http://127.0.0.1:20128`；webview 侧配置 `remote` capability，URL 白名单只含该 origin
- [ ] **Step 2: 网关子进程** —— Bun 作为 `externalBin` sidecar 拉起，参数与今天一致（`--port`、`DATA_DIR=~/.irouter`、`HOSTNAME=127.0.0.1`、`IR_PANEL_GUARD=1`）
- [ ] **Step 3: 孤儿回收** —— 调 `register_sidecar` + `cleanup_before_exit`；**必须实测三条死亡路径**：正常退出、窗口关闭后托盘常驻、更新安装器强杀（`TerminateProcess` 那一类）
- [ ] **Step 4: 守卫令牌化** —— 壳每次启动生成随机 token，经子进程环境变量与窗口 UA 注入；改 `custom-server.js:23-41`（应用处 `:161`）从固定值改为校验该 token。**这是安全边界**，不是便利设施：固定值写在开源仓库里，任何本地进程都能伪造
- [ ] **Step 5: IPC 面最小化** —— 只暴露：设置读写、更新三动作（检查/下载/安装）、打开设置模态。**逐条与 `desktop/preload.js:11-62` 的 12 个方法对照，写清每个方法保留或删除的理由**
- [ ] **Step 6: 就绪探测** —— 复刻 `main.js:1602-1620` 的语义：先探测再显示窗口，避免白屏

**出口条件：** macOS 上双击可起，面板可用，`/v1` 可转发；杀进程不留孤儿。

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
- [ ] 移植 `download.js` 与 `installer.js`（`open` / `cmd /c start` / `xdg-open` 三种调起）
- [ ] **实测每平台的替换体验**：macOS 调起 dmg、Windows 调起 NSIS、Linux 调起 deb。若 macOS 上自研调起 dmg 的体验不可接受，**单独评估**是否改用 `tauri-plugin-updater`——届时必须一并接受签名密钥对义务
- [ ] 保留 `ignoreVersion` 语义（`main.js:800`）

**出口条件：** 与 Electron 版逐项对照，无功能缺失；`IROUTER_IMPORT_DECISION` 等自动化接缝可用。

---

### Phase 5：三平台打包

- [ ] macOS：dmg，per-arch（**不做 universal**——实测 universal 会让原身体积翻倍，VS Code 就是 303 MiB → 530 MiB 的例子）
- [ ] Windows：NSIS + zip；`webviewInstallMode` 用默认 `downloadBootstrapper`（**不塞 127MB 的离线包**）
- [ ] Linux：deb + tar.gz，声明 `Depends: libwebkit2gtk-4.1-0`
- [ ] 产物命名与 `updater/asset.js` 的匹配规则对齐（改名会让老版本的更新检查失效）
- [ ] 三平台各自复核体积预算表，超线即回到 Phase 2/4 找原因

**出口条件：** 三平台产物齐备，macOS dmg ≤ 70MB。

---

### Phase 6：切换、验收与清理

- [ ] 端到端验收（三平台各一遍）：装 → 起 → 面板可用 → `/v1` 转发 → 托盘 → 自启 → 单实例 → 更新 → 配置导出/导入 → 杀进程无孤儿
- [ ] **内存复核**：基线是 668 MB（5 进程，见 `docs/packaged-runtime-footprint.zh-CN.md`）。系统 webview 仍有开销，量级估算 200–300 MB，**实测后写回 ADR-0007**（那里现在标的是估算）
- [ ] **回归**：`npx vitest run` + `node tests/__baseline__/verify-no-regression.mjs test-results.json`，与基线一致
- [ ] 移除 `desktop/`（Electron 壳），或保留一个 tag 作为退路后移除
- [ ] 更新 `CONTEXT.md`（若有新术语）与 `README` / `README.zh-CN` 的构建与产物章节
- [ ] **在 ADR-0007 里把估算数字替换为实测**（体积、内存、dmg）

**出口条件：** 三平台验收清单全绿，ADR-0007 无残留估算。

---

## 风险与回退

| 风险 | 触发条件 | 回退动作 |
| :--- | :--- | :--- |
| **Bun 跑不通完整网关** | Phase 0 Step 2 任一红 | 停。ADR-0007 重开；备选 Node SEA（macOS 越线）或 Rust 重写（那时才值得算） |
| **Three-platform 同步导致问题并发** | 任一平台卡住超一个相位 | 允许把该平台降级为「跟进」，但**不得降低验收线**——降级只影响交付顺序，不影响标准 |
| **sidecar 漏杀孤儿** | Phase 3 Step 3 任一死亡路径失败 | 升级 Tauri 版本或自研 PID 文件 + 启动时回收（今天 `main.js:197,226-285` 已有等价实现可移植） |
| **自研更新体验不可接受** | Phase 4 实测 | 单独评估 `tauri-plugin-updater`，接受密钥义务后再定 |
| **体积超线** | Phase 5 | 回到 Phase 2 查负载；**不做**有损替换 |
| **迁移中途放弃** | — | 成本最高。Phase 0–2 都是**独立净收益**（Bun 验证、OAuth 一键化、负载裁剪、缺陷修复），即使停在 Phase 2 也不白做；Phase 3 之后放弃才会两头空 |
