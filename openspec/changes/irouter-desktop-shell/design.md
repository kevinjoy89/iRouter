## Context

- 上游 `9router/` 为 submodule 锁 v0.5.69，零改动约束（见 docs/adr/0002-pinned-upstream.md）；面板与网关同属一个 Next.js standalone 进程，`custom-server.js` 支持 `--port`；`DATA_DIR` 环境变量决定数据目录；`better-sqlite3` 为可选依赖，`sql.js` 是官方回退路径。
- 壳层技术已定：Electron（选型理由见 docs/adr/0001-electron-shell.md）。动机与范围见 proposal.md Why / What Changes。

## Goals / Non-Goals

**Goals:**

- 全部壳层代码位于 `desktop/`，单命令产出可安装的 macOS dmg；构建可复现（锁 tag + 固定构建机 Node 版本）
- 网关行为与 CLI 形态一致：复用上游的端口、数据目录、存储机制，壳层只注入环境与进程管理

**Non-Goals:**

- 不做签名、公证、自动更新（自用分发，Q4 已定）
- 不修改上游源码与面板内容
- 本迭代不产出 Windows/Linux 安装包（electron-builder 配置就位但不构建）
- 不搭 CI（保留可能性，设计上不排斥）

## Decisions

1. **服务端运行方式：`ELECTRON_RUN_AS_NODE` 子进程**
   Electron 自带 Node，以 `ELECTRON_RUN_AS_NODE=1` 纯 Node 模式跑 standalone 的 `custom-server.js`。零额外运行时，目标机器无需装 Node。
   子进程可执行文件：macOS 上必须 spawn `Contents/Frameworks/iRouter Helper.app` 里的 Helper 二进制，而不是 `process.execPath`——主二进制被 LaunchServices 当成独立应用，会在 Dock 多出一个 "exec" 图块（实测 `ELECTRON_RUN_AS_NODE` 和 `__CFBundleIdentifier` 都阻止不了）；Helper bundle 已声明 `LSUIElement=true`，与 VS Code 跑扩展宿主同套路。非 macOS 回退到 `process.execPath`。
   实现发现（已修正）：standalone 的 `server.js` 只读 `process.env.PORT`，**忽略 `--port` 参数**；绑定地址取 `process.env.HOSTNAME`，上游默认 `0.0.0.0`（全网卡）。因此壳层必须显式注入 `PORT=<实际端口>` 与 `HOSTNAME=127.0.0.1`（桌面版不把网关暴露到局域网）。
   环境净化：构建与子进程均需剔除宿主泄漏的 `__NEXT_*` / `PORT` / `HOSTNAME` / `NEXT_DIST_DIR` 等变量——实测不洗会直接崩溃（`TypeError: generate is not a function`）或绑到错误端口。
   备选：Bun 编译单文件 / Node tar sidecar（属 Tauri 方案，ADR 0001 已否决）。

2. **构建管线（`desktop/scripts/build-server.mjs`）**
   - 在 `9router/` 执行 `npm install`（幂等）与 `npm run build`（= `next build --webpack` + postbuild 把 `static/`、`public/`、`custom-server.js` 并入 `.next/standalone`）
   - 复制 `.next/standalone` → `desktop/build/gateway/server`（干净房间，不回写 9router 目录）
   - 删除 `desktop/build/gateway/server/node_modules/better-sqlite3`，避开 Electron ABI 原生模块重编译；实测网关优先用内建 `node:sqlite`，`sql.js` 为更深层回退
   - 产物经 electron-builder `extraResources` 进 `resources/gateway/server`，**绕开 asar**（子进程按真实路径读文件）；**必须嵌套一层**：electron-builder 对复制源下相对路径恰好为 `node_modules` 的目录有硬编码排除（`app-builder-lib/util/filter.js`），`from: build/server` 会让依赖整目录静默丢失
   - `desktop/build/`、`9router/.next/`、`9router/node_modules/` 进 .gitignore

3. **数据目录：`app.getPath('userData')` → `DATA_DIR`**
   main 进程把平台标准目录（macOS `~/Library/Application Support/iRouter`）注入子进程环境变量。目录不可写时的回退行为由上游 dataDir.js 既有逻辑兜底，壳层不重复实现。

4. **端口自适应**
   启动前用 TCP **连接探测** 20128（不能用 `listen` 探测：macOS 的 SO_REUSEADDR 会在已有 `*:20129` 监听时误报空闲）；被占用则向上逐个顺延（最多 +50，再退回系统分配的临时端口）；以 `waitHttpReady`（轮询 `GET /login == 200`）确认就绪后再创建窗口——TCP 能连上不等于能服务 HTTP，实测会让紧接的探测全部落空；外层另有最多 3 次的换端口重试，兜住探测与绑定之间的竞态；实际端口注入窗口 URL 并显示在托盘 tooltip/菜单。绝不 kill 占用进程（与 CLI 的 `killProcessOnPort` 行为相反，是刻意偏离）。

5. **首次运行导入 ~/.9router**
   条件：数据目录中尚无网关数据（db/auth/jwt-secret/machine-id）且 `~/.9router` 存在。不能用“目录为空”判首次——Electron/Chromium 会把 profile 文件写进同一个 userData 目录，目录永不为空。`dialog.showMessageBoxSync` 三选（导入/跳过/取消）；导入复制除 `runtime/` 外的全部条目（auth、db、jwt-secret、machine-id、model-catalog*、headroom 等）；跳过写标记文件，之后不再询问。导入是**复制非移动**，失败可重来、`~/.9router` 永远保留。

6. **退出回收：杀进程组**
   实测 `custom-server.js` 退出后 Next 派生的 `next-server` 子进程会变成孤儿（ppid=1）并继续占用端口。因此子进程以 `detached: true` 启动独立进程组，退出时 POSIX 用 `process.kill(-pid)`、Windows 用 `taskkill /T /F`，超时后 SIGKILL 兼底。

7. **窗口、托盘、单实例、自启（Electron 原生 API）**
   - 单实例：`app.requestSingleInstanceLock()`，失败即退出；`second-instance` 事件聚焦窗口
   - 关窗：`close` 事件 `preventDefault()` + `hide()`；托盘"退出"才 `app.quit()`（退出前 await 子进程终止，超时强杀）
   - 托盘菜单：打开面板 / 开机自启（checkbox）/ 退出；图标复用应用图标
   - 自启：`app.setLoginItemSettings({ openAtLogin })`；自启启动（`app.getLoginItemSettings().wasOpenedAtLogin`）时不显示主窗口，驻留托盘
   - 外链与 OAuth：`setWindowOpenHandler` — 同源（127.0.0.1:实际端口）弹窗放行（callback/page.js 依赖 window.opener/BroadcastChannel/localStorage 三通道），异源 `shell.openExternal`

8. **打包（electron-builder）**
   appId `com.irouter.desktop`、productName `iRouter`、version `0.0.1`；mac target dmg + `identity: null`（跳过签名）；win nsis、linux AppImage 配置就位；icon 用 1024×1024 PNG（AI 生成，electron-builder 自动转 icns/ico）。

9. **验证策略（`--smoke` 模式）**
   main.js 支持 `--smoke`：启动 → 网关就绪 → 窗口 `did-finish-load` → HTTP 探测 `/login`、`/v1/models`、`/callback` → 断言关窗隐藏后网关仍响应 → 退出码 0/非 0。脚本：`desktop/scripts/smoke.mjs`（开发产物）、`smoke-packaged.mjs`（打包成品）、`test-import.mjs`（导入 4 场景）、`test-single-instance.mjs`（单实例）；dmg 产物再人工安装验证一次。

10. **版本策略**
   `0.0.1` 独立于上游；上游对应关系由 submodule 锁定 commit 记录（`git -C 9router describe`）。

## Risks / Trade-offs

- [next build 可复现性依赖上游依赖树] → 锁定 tag + 构建机固定 Node 版本；构建脚本幂等可重跑
- [sql.js 内存型存储，性能与并发低于 better-sqlite3] → 个人自用量级无感知；上游官方支持的回退路径，不引入额外依赖
- [未签名 dmg 首次打开被 Gatekeeper 拦截] → README 说明"右键 → 打开"；自用可接受，公开分发前再补签名
- [端口顺延后外部 CLI 工具的 endpoint 失效] → 窗口与托盘展示实际端口；README 说明
- [OAuth 弹窗被 setWindowOpenHandler 误拦] → 同源白名单放行；smoke 覆盖回调页可达性（HTTP 探测 /callback）
- [退出竞态导致网关进程残留] → 退出流程 await 子进程退出 + 超时强杀；smoke 检查无残留

## Migration Plan

- 全新产品，无既有部署；唯一迁移路径是 `~/.9router` → 平台数据目录的一次性导入（见 spec: 首次运行导入旧数据）
- 回滚/卸载：删除应用与数据目录即完全卸载；导入是复制，`~/.9router` 不受影响，随时可退回 CLI 形态

## Open Questions

无（设计树已通过 grilling 全部落定；Windows/Linux 实机验证属任务执行顺序，非设计未知项）。
