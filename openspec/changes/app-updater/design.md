## Context

iRouter 作为跨平台桌面客户端，基于 Electron 架构打包分发。网关源码基于上游 v0.5.91 定制，产品自身版本在 `desktop/package.json`（当前为 `0.3.2`）。GitHub Actions 自动化流水线在打 Tag 发布时会自动为 macOS / Windows / Linux 生成 6 个不同架构与格式的安装包，并附带生成唯一的 `checksums.txt`。

## Goals / Non-Goals

**Goals:**
- 确定性匹配：按操作系统、CPU 架构与安装形态精准匹配 release assets。
- 安全优先原则：严格校验 SHA-256 哈希值，校验和缺失或不匹配绝不提供安装入口。
- 不打扰原则：静默检查失败不弹窗，4 小时未认证 API 限流缓存，支持关闭自动检测与忽略特定版本。
- 纯逻辑可测：将 updater 的解析、匹配、校验与检测逻辑解耦为纯 JS 模块，全部配备独立的单元测试。
- 体验对齐桌面规范：系统菜单栏、托盘与设置面板全链路打通。

**Non-Goals:**
- 不做热更新/内存中动态替换二进制（避免操作系统文件锁与代码签名破坏，安装交由原生系统安装器完成）。
- 不接第三方三方镜像源（保持官方 GitHub Releases 单一可信源）。

## Decisions

### D1. 纯逻辑模块化解耦与可测性
`desktop/updater/` 目录下的核心功能（`version.js`, `asset.js`, `checksum.js`, `checker.js`, `download.js`, `installer.js`）不直接依赖 Electron 主进程 API，网络请求函数（`fetchFn`）支持依赖注入，确保所有逻辑均可在 Node.js/Vitest 环境中隔离 Mock 测试。

### D2. 限流缓存与忽略版本
针对 GitHub 未认证接口的 60 次/小时 IP 限流限制，在 `shell-settings.json` 中持久化 `lastCheckAt` 与 `lastCheckResult`，4 小时内自动检查直接复用缓存。手动点击“检查更新”或菜单入口强制请求远端。用户忽略某版本后，在出现更新的版本前不再主动提示。

### D3. 临时文件与完整性校验
下载统一流式写入用户 `~/Downloads` 目录下的 `.part` 临时文件，用户主动取消或发生网络异常时立即清理。下载完成后，自动下载同 Release 的 `checksums.txt` 并流式计算本地文件的 SHA-256 比对。比对失败提示错误并提供 Release 页面链接，不提供安装入口。

### D4. 独立子进程唤起与安全退出
校验通过后，用户点击“安装并重启”，主进程通过 detached 独立子进程执行对应平台的系统打开命令：
- macOS: `open <dmg>`
- Windows: `cmd.exe /c start "" "<exe>"`
- Linux: `xdg-open <deb>`
延时 500ms 退出主进程，避免子进程随主应用销毁而被意外终止。
