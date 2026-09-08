# iRouter Context

iRouter 是 9Router（开源 AI 路由网关，decolua/9router）的跨平台独立安装版：装完是一个真正的桌面应用，窗口内直接显示 9Router 面板，无需打开系统浏览器。9Router 上游源码保持零改动，所有定制都在本仓库的壳层完成。

## Language

**iRouter**:
本产品的正式名称。9Router 的桌面独立安装版，MIT 许可下沿用上游功能与数据格式。
_Avoid_: 9Router Desktop、9Router 桌面版（容易和上游官方概念混淆）

**锁版上游（pinned upstream）**:
`9router/` 目录中固定在某个 tag 的 9Router 源码 checkout。任何情况下不改动其中的源码；升级 = 切到新 tag。
_Avoid_: fork、patch 版（都暗示源码被改过）

**壳层（shell layer）**:
本仓库内独立于 `9router/` 的定制代码（计划位于 `desktop/` 子目录），负责桌面化：窗口、托盘、单实例、自启、打包安装器。壳层通过进程边界与锁版上游交互。
_Avoid_: 封装、wrapper（与本仓库其他含义混淆）

**内嵌面板（embedded dashboard）**:
iRouter 应用窗口内直接渲染的 9Router Web 面板（Electron 窗口指向本机网关地址），不经系统浏览器。
_Avoid_: 浏览器访问（那是 CLI 形态的旧体验）

**网关服务（gateway）**:
9Router 提供的 OpenAI 兼容本地 API（iRouter 默认 `http://127.0.0.1:20128/v1`，仅绑定回环地址），供 Claude Code、Codex 等外部 CLI 工具调用。它和面板是同一个进程/端口。
_Avoid_: 服务端、后端（过于泛化）

**数据目录（data dir）**:
由 9Router 的 `DATA_DIR` 环境变量决定的位置，存放配置、数据库、密钥。iRouter 默认指向平台应用数据目录（macOS `~/Library/Application Support/iRouter` 等）；首次运行可一键导入旧 CLI 的 `~/.9router` 数据。
_Avoid_: 安装目录（与程序文件位置无关）
