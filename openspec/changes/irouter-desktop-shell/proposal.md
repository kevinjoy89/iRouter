## Why

9Router 目前只能通过 npm CLI 启动后在浏览器里访问（`localhost:20128` 面板 + `/v1` 网关）。用户需要一个跨平台的独立安装版本：双击安装、打开即用，目标机器不需要预装 Node/npm。上游 `9router/`（decolua/9router，MIT）已锁版为 submodule v0.5.69，本变更的全部定制必须放在独立壳层，不改动上游一行源码。

## What Changes

- 新增 `desktop/` 壳层（Electron）：内嵌 Chromium 窗口直接渲染 9Router 面板，不经系统浏览器；系统托盘常驻；关闭窗口最小化到托盘，托盘"退出"才停止网关
- 打包管线：对锁版上游执行 `next build` 产出 `.next/standalone` 自包含产物，随应用一起分发；网关服务以 `ELECTRON_RUN_AS_NODE` 子进程运行，不依赖目标机器 Node
- 数据目录：通过 `DATA_DIR` 环境变量指向平台标准目录（macOS `~/Library/Application Support/iRouter`、Windows `%APPDATA%\iRouter`、Linux `~/.config/iRouter`）；首次运行检测到旧 CLI 数据 `~/.9router` 时提供一键导入
- 端口策略：默认 20128（与上游 CLI 一致），被占用时自动顺延到下一个空闲端口，绝不杀掉占用进程；面板窗口指向实际端口
- 存储：包内不携带 `better-sqlite3`（原生模块在 Electron ABI 下需重编译），使用 9Router 官方支持的 `sql.js` 纯 WASM 回退
- 品牌：应用名 iRouter，应用 ID `com.irouter.desktop`，版本 `0.0.1`；面板内容保持上游原样（iRouter 品牌只体现在壳层：图标、窗口标题、安装器）
- 安装包：短期只出 macOS `.dmg`（不签名、不公证、不自动更新，自用分发）；Windows NSIS 与 Linux AppImage 的构建配置保留，后续在对应系统构建或接入 CI
- 仓库结构：`iRouter/` 初始化为 git 仓库，`9router/` 以 submodule 锁 v0.5.69

## Capabilities

### New Capabilities

- `app-shell`: Electron 壳应用行为——内嵌窗口、系统托盘、单实例、关窗最小化、开机自启开关、品牌与安装包元数据
- `embedded-gateway`: 内嵌网关的构建与运行——standalone 产物打包、子进程启动、端口选择、数据目录注入、sql.js 存储回退、首次运行数据导入

### Modified Capabilities

<!-- 无：openspec/specs/ 目前为空，本变更只引入新能力，不改动既有 spec -->

## Impact

- 新增目录：`desktop/`（壳层全部代码与构建脚本）
- 上游 `9router/`：零改动；构建产物（`.next/`、`node_modules/`）仅作为本地构建副产物，不提交
- 依赖：Electron、electron-builder；构建机需 Node 22+ 与 npm
- 数据：兼容导入现有 `~/.9router`（auth、db、jwt-secret、machine-id、model-catalog 等，不含 runtime/）
- 风险：macOS 未签名 dmg 需右键"打开"首次运行；换端口后外部 CLI 工具的 endpoint 需同步
