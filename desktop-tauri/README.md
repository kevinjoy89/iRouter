# iRouter Tauri 壳层（desktop-tauri/）

替代 `desktop/` 的 Electron 实现。决策依据 **ADR-0007**，实施计划 `docs/plans/2026-10-07-tauri-bun-migration.md`。

## 进程拓扑

```
iRouter（Rust / Tauri 主进程）
├── 窗口 → 系统 webview 加载 http://127.0.0.1:<port>
├── 托盘 / 菜单 / 自启 / 单实例 / 更新      ← src/shell/、src/updater/
└── sidecar：Bun 可执行文件
        └── 跑 <resource>/gateway/server/custom-server.js
                └── 面板 + /v1 网关（Next standalone）
```

与 Electron 版的关键差异：**Chromium 换成系统 webview**（macOS WKWebView / Windows WebView2 / Linux WebKit2GTK），**网关宿主 Node 换成随包分发的 Bun**。

## 模块边界（wave 2 并行实施的接口契约）

`src/` 只允许以下归属，**每个文件只有一个 owner**：

| 路径 | Owner | 内容 |
| :--- | :--- | :--- |
| `src/main.rs` | Lead | 入口：建窗口、拉起 sidecar、注册 shell/updater 的 init |
| `src/gateway.rs` | Lead | sidecar 生命周期：定位可执行文件、spawn（`--port` / `DATA_DIR` / `HOSTNAME` / `IR_PANEL_GUARD`）、就绪探测、**孤儿回收**、退出清理 |
| `src/guard.rs` | Lead | 面板守卫令牌：每次启动随机生成，注入子进程环境 + webview UA/头 |
| `src/shell/**` | shell owner | 托盘、自启、单实例、应用菜单、右键菜单、快捷键、设置模态 IPC |
| `src/updater/**` | updater owner | 检查/下载/校验/调起安装器，事件名与 payload 必须与面板既有契约一致 |
| `tauri.conf.json` / `capabilities/**` / `icons/**` | packaging owner | 打包配置、capability、产物命名、CI 接线 |

### 必须由 `main.rs` 调用的两个入口（wave 2 的实现方只许改自己那份）

```rust
// src/shell/mod.rs
pub fn init(app: &tauri::AppHandle) -> tauri::Result<()>;

// src/updater/mod.rs
pub fn init(app: &tauri::AppHandle) -> tauri::Result<()>;
```

两者都**不得**在 `init` 里阻塞启动；需要 I/O 的工作自己起任务。任何新依赖要在 `Cargo.toml` 里加，但**加依赖前先看 `docs/plans/2026-10-07-tauri-shell-api-notes.md`**（task-1 的事实核查结果），那里有确切的 crate 名与版本。

## 硬约束

1. **面板守卫令牌必须随机**（每次启动生成）。固定值写在开源仓库里，任何本地进程都能伪造——Electron 版用的是固定头，那是当时的妥协，不继承。
2. **孤儿回收必须实测三条死亡路径**：正常退出、窗口关闭后托盘常驻、安装器强杀（Windows `TerminateProcess` 那一类）。Tauri ≥ 2.12.1 才有 `register_sidecar` / `cleanup_before_exit`，**版本不许放宽**。
3. **更新器事件名与 payload 不许改**（`shell:update-progress` 等），否则面板要跟着改。
4. **IPC 面最小化**：只暴露设置读写、更新三动作、打开设置模态。逐条对照 `desktop/preload.js:11-62` 的 12 个方法，写明保留或删除的理由。
5. 资源目录里放 **59 MiB 网关负载**（`desktop/build/gateway/server`，纯 JS + 静态资源、无原生二进制）与 **Bun 可执行文件**（哈希锁在 `desktop/scripts/bun-pin.json`）。**禁止**回退到系统 PATH 的 bun 或 `latest`。
6. 磁盘：本机余量只有 ~15 GiB，而 Tauri 首次构建要编译近千个 crate。`Cargo.toml` 的 profile 必须关掉 debug 符号（`debug = 0` / `strip = true`），`target/` 纳入清理。
7. 网关源码（`src/`、`open-sse/`）**一行不改**——那是与上游 decolua/9router 的 merge 血缘。

## 与既有资产的关系

- **Bun 版本与哈希**：`desktop/scripts/bun-pin.json` + `desktop/scripts/verify-bun-pin.mjs`（构建期校验，失败即中止）
- **网关负载**：由 `desktop/scripts/build-server.mjs` 产出（复用，不改）
- **更新器行为**：`desktop/updater/*.js` 是待移植的**参照实现**，行为等价表见 task-3 的交付
- **The evidence trail**：Phase 0 门禁（`desktop/scripts/bun-gateway-spike.mjs`）、Phase 1 端到端（`desktop/scripts/oauth-loopback-e2e.mjs`）
