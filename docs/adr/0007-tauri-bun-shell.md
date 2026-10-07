# 用 Tauri v2 壳 + Bun 网关运行时替换 Electron

iRouter 的桌面壳层从 Electron 换成 Tauri v2（Rust），网关进程的宿主运行时从「Electron 二进制以 `ELECTRON_RUN_AS_NODE` 兼任」换成随包分发的 Bun 官方二进制。**网关源码不重写**——它仍是那棵 Next.js standalone 树，只是换了宿主。

## 为什么必须换（这是门槛问题，不是偏好问题）

v0.3.3 实测：dmg 139.3 MiB、解压 .app 324 MiB，其中 Electron 运行时 244 MiB（`Electron Framework` 二进制一个就有 192 MiB）。**Electron 自己的分发 zip 在写第一行应用代码之前就是 124.3 MiB（macOS arm64）/ 150.9 MiB（Windows x64）**，所以无论怎么裁，dmg 地板都在 ~118–125 MiB。验收线是 dmg ≤ 70MB——Electron 在物理上够不到。

裁剪类手段已经用尽，没有剩余空间可挖：`electronLanguages` 已把 275 个语言目录（49.9 MiB）裁到 14 个（4.7 MiB），`asar` 开启、`files` 是 4 项白名单、产物里 0 个 source map、`app.asar` 只有 104 KiB。剩下的可裁项（SwiftShader 15.8 MiB、`chrome_*_percent.pak` 1.9 MiB）也只够把 dmg 压到 ~120 MiB。

顺带回收的稳态内存：实测 5 个进程合计 **668 MB**（GPU 277 / 渲染 203 / 网关 105 / 主 72 / 网络 11，见 `docs/packaged-runtime-footprint.zh-CN.md`）。其中约 563 MB 是 Chromium 的多进程开销，随壳一起消失；系统 webview 仍有代价，但量级估算落在 200–300 MB（**未实测，属估算**）。

## 为什么是 Tauri，不是别的壳

2026-10-07 的实时状态：**Wails v3 仍是 beta**（`v3.0.0-beta.28`，macOS GA 就绪修复 PR 仍开着），2026 年不能作为迁移目标；**CEF minimal 构建 126.1 MiB**（macOS arm64），与 Electron 同级且集成成本更高；**Sciter / Ultralight 不是 Chromium**（CSS/JS 引擎语义不同，面板保真度要重写，另有商业授权）；**Servo 活着但可嵌入的应用壳 Verso 仓库已归档**。系统 webview 三平台各有实现（WKWebView / WebView2 / WebKit2GTK），Tauri v2 把它们统一在同一套 API 之下。

## 为什么网关继续用 JS，不重写

网关是 963 个文件 / 150,388 行（`src/` 91,722 + `open-sse/` 58,666），含 133 个 provider registry、31 个 executor、48 个 translator、172 个 API route。重写成编译型语言省下的只有运行时那 ~20 MiB（dmg 54 → 30 左右），代价是永久放弃与上游 decolua/9router 的 merge 血缘、363 个测试文件（~3270 用例）作废、以及把整个面板（26 页 + 151 个 client 组件，138 个文件 import `next/server`）一并改掉——因为**只要还剩任何一块 JS，运行时就得留着，体积收益归零**。

## 为什么运行时是 Bun 而不是 Node

门槛算术决定的：Tauri 壳 ~10 + 运行时 + 网关压缩 ~17-20，要靠 Node 就得用 48.8 MiB 的 `node-*-darwin-arm64.tar.gz`（压缩），总账约 **79 MB，越过 70 MB 线**；Bun 的 `bun-darwin-aarch64.zip` 是 **24.2 MiB**，总账约 51–54 MB。仓库里 Bun 还已经是第一等路径：`package.json` 的 `start:bun` 就是 `bun ./.next/standalone/custom-server.js`（正是 sidecar 要做的事），`src/lib/db/driver.js` 有 `bun:sqlite` 分支。（Windows 上 Node 的 34.7 MiB 反而略小于 Bun 的 38.0 MiB，所以 Bun 的必要性主要由 macOS 决定。）

## 前提：Bun 必须先验证再开工

**没有找到 CI 覆盖 Bun 生产运行的证据**——只有 npm 脚本、driver 分支和一条 CHANGELOG 记录。因此迁移的第一道门禁是 spike：用 Bun 在三平台跑通完整网关（面板 200、`/v1/models` 200、SSE 流式转发、SQLite 读写、`custom-server.js` 的客户端 IP 推导），复用 `desktop/scripts/smoke.mjs` 的断言。**spike 不通过则整个决策重开**（届时 Node SEA 会顶破 macOS 的 70MB 线，Rust 重写才第一次变得值得讨论）。

## OAuth 三通道必须替换（并且这本身是修缺陷）

ADR 0001 把「OAuth 依赖弹窗 + `window.opener.postMessage` / BroadcastChannel / localStorage」当成选 Electron 的核心理由，**但代码的实际行为不是这样**：授权 URL 是跨域的（`open-sse/providers/registry/claude.js:72` → `https://claude.ai/oauth/authorize`），壳层把跨域链接交给系统浏览器并 `deny`（`desktop/main.js:616-622`），于是 `window.open` 返回 null、`OAuthModal.js:459-463` 直接落到手粘；即便弹窗真的开出来，面板在 `127.0.0.1:20128` 而通用供应商的 redirect 是 `http://localhost:20128/callback`，**host 不同即不同 origin，三条通道全部命中不了**。所以：三通道既不是 Chromium 特性，在桌面版里也从没生效过。桌面版通用供应商的 OAuth 实际体验是「系统浏览器授权 → 复制 URL → 粘回面板」，而 12 个 device-code 类与 6 个服务端代理类供应商能一键完成——这个不平等是缺陷。

改成「回环 redirect → 网关自己的 route handler 收取并换取 → 复用既有 poll 原语」是 2–4 个文件的改动，且与壳选型解耦：**先做它，桌面版 OAuth 才真正一键化，同时换壳的 OAuth 迁移成本从账上消失**（也顺带绕开 Tauri v2 当前所有弹窗类 open bug，我们不需要应用内弹窗）。

## 安全边界的变化（必须在实现时一并处理）

Tauri 的 `remote` capability 会把壳命令**授予面板所在的 origin**，于是 `custom-server.js:23-41`（应用处 `:161`）那条面板守卫（认 `Electron/` UA 或固定头 `x-irouter-client: irouter-app`）从「防误开」升级成真正的安全边界——固定值写在开源仓库里，任何本地进程都能伪造。因此：**IPC 面压到最小**（设置读写、更新三动作、打开设置模态），**守卫改为每次启动随机 token**，由壳生成并注入子进程环境与窗口 UA，让「能加载该 origin」重新等于「就是我们的窗口」。

Status: accepted

Considered Options:

- **Tauri v2 + Bun sidecar（选定）** / Tauri + Node SEA / Tauri + Go 或 Rust 重写网关 / 继续裁剪 Electron / Wails v3 / CEF / 退回 CLI + 浏览器
- 退回 CLI + 浏览器被否，不是因为它不够轻（它最轻），而是因为它放弃 CONTEXT.md 里「内嵌面板」的产品定义——面板从「应用窗口内的 Web 面板」退化成「系统浏览器里的一个标签页」，同时失去托盘、自启、单实例与内嵌更新的全部意义
- 裁剪 Electron 被否：地板 118–125 MiB，够不到 70 MB 线，做了也只是把 139 变成 120
- Rust/Go 重写网关被否：省 ~20 MiB，代价是 15 万行重写 + 上游 merge 血缘降级为手工 port + 测试基线归零
- 更新通道**不采用** `tauri-plugin-updater`：它要求签名密钥对且无法关闭，私钥丢失即已安装用户永久断更。现有自研流程（检查 → 下载 → 校验 → 调起系统安装器，`desktop/updater/installer.js:33-68`）只有 ~70 行等价的纯逻辑，移植即可

Consequences:

- `desktop/` 的 3264 行壳层代码基本重写：`main.js` 2157 行（托盘 / 自启 / 单实例 / 应用菜单 / 右键菜单 / 快捷键 shim / 网关子进程生命周期含孤儿回收 / 就绪探测 / 设置 IPC / 更新集成）、`updater/` 774 行（其中 checker / checksum / version / asset 共 446 行是可复用的纯逻辑，download / installer 328 行依赖 Electron）、`preload.js` 62、`settings.js` 101、图标脚本 170。**全功能点保留**，包括应用内更新
- 孤儿进程回收依赖 Tauri ≥ 2.12.1 的 sidecar 注册表 + `cleanup_before_exit`（该能力 2026-09-18 才修好）——必须锁版本，不能放宽
- **Linux 首次出现系统依赖**：deb / tar.gz 声明 `Depends: libwebkit2gtk-4.1-0`。这是「首次启动不需要额外下载任何运行时」这条硬线的**唯一显式例外**，理由是它与静默失败不同——缺依赖在安装期就可见、可自行解决。AppImage 仍依赖宿主 webkit，不自带
- 网关负载仍需顺手裁剪，否则预算被吃掉：`@img/sharp-libvips-darwin-arm64` 18 MiB 是死重（`next.config.mjs:31` 设了 `images: { unoptimized: true }`，且 `src/` 与 `open-sse/` 中 sharp 零引用），排除后 76.6 → 59 MiB。它同时是个缺陷：负载只在本机（arm64）构建一次，`dist:mac` 却带 `--x64`，x64 包里装的是 arm64 的 libvips
- 上游同步保持不变（网关源码一行未动），这是选 Bun sidecar 而非重写的主要理由
- ADR 0001 被本 ADR 取代，且不只是「被更好的方案取代」：**它的理由段与代码实际行为不符**（见上「OAuth 三通道」一节）
