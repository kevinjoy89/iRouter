# 用 Electron 壳层承载 9Router 网关

iRouter 用 Electron 做桌面壳：内嵌 Chromium 窗口渲染 9Router 面板，网关服务以 ELECTRON_RUN_AS_NODE 子进程运行 .next/standalone 产物。选 Electron 而非 Tauri，是因为 9Router 的 OAuth 连接流程依赖弹窗 + window.opener.postMessage / BroadcastChannel / localStorage 三通道回调（src/app/callback/page.js），Tauri 的系统 webview（WKWebView / WebKitGTK）跨窗口不支持这些语义，Electron 三平台统一 Chromium 零适配。代价是安装包约 90-130MB，Tauri+Bun sidecar 约 75-105MB，个人自用场景可接受。

Status: accepted

Considered Options:
- Tauri v2 + Bun 编译 sidecar（体积略小，但 OAuth 三通道失效，需壳层改造流程）
- Tauri v2 + Node 运行时 sidecar（同左，另加首次解压 Node 的不优雅体验）

Consequences:
- 包内不装 better-sqlite3（Electron 的 Node ABI 需重新编译原生模块）。实测网关优先使用 Electron 内建 Node 24 的 `node:sqlite`，`sql.js`（纯 WASM）作为更深层回退——两者都不需要按 ABI 重编译，原意达成