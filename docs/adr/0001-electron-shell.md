# 用 Electron 壳层承载 9Router 网关

iRouter 用 Electron 做桌面壳：内嵌 Chromium 窗口渲染 9Router 面板，网关服务以 ELECTRON_RUN_AS_NODE 子进程运行 .next/standalone 产物。选 Electron 而非 Tauri，是因为 9Router 的 OAuth 连接流程依赖弹窗 + window.opener.postMessage / BroadcastChannel / localStorage 三通道回调（src/app/callback/page.js），Tauri 的系统 webview（WKWebView / WebKitGTK）跨窗口不支持这些语义，Electron 三平台统一 Chromium 零适配。代价是安装包约 90-130MB，Tauri+Bun sidecar 约 75-105MB，个人自用场景可接受。

Status: superseded by ADR-0007

> **被取代的原因，以及一处事实更正。** 本决策的前提「安装包 90-130MB 个人自用可接受」在 2026-10 被推翻：验收线定为 dmg ≤ 70MB，而 Electron 的分发 zip 本身就有 124.3 MiB（macOS arm64），地板够不到。
>
> 更重要的是，本文的理由段与代码实际行为不符。文中称 OAuth「依赖弹窗 + `window.opener.postMessage` / BroadcastChannel / localStorage 三通道」且 Tauri 的系统 webview 不支持这些语义——但代码里：授权 URL 是跨域 https，壳层把它交给系统浏览器并 `deny` 弹窗（`desktop/main.js:616-622`），`window.open` 返回 null 后直接落到手粘（`OAuthModal.js:459-463`）；即便弹窗真的开出来，面板在 `127.0.0.1:20128` 而通用供应商的 redirect 落在 `localhost:20128/callback`，host 不同即不同 origin，三条通道全部命中不了。**三通道既不是 Chromium 特性，在桌面版里也从未生效过**——它服务的是浏览器形态（CLI 打开面板），不是 Electron 窗口。
>
> 结论：当时选 Electron 的那条核心理由不成立。详见 ADR-0007。

Considered Options:
- Tauri v2 + Bun 编译 sidecar（体积略小，但 OAuth 三通道失效，需壳层改造流程）
- Tauri v2 + Node 运行时 sidecar（同左，另加首次解压 Node 的不优雅体验）

Consequences:
- 包内不装 better-sqlite3（Electron 的 Node ABI 需重新编译原生模块）。实测网关优先使用 Electron 内建 Node 24 的 `node:sqlite`，`sql.js`（纯 WASM）作为更深层回退——两者都不需要按 ABI 重编译，原意达成