## Purpose

为 iRouter 桌面应用内置版本更新能力：自动静默检测新版本、提示下载、展示实时下载进度、校验 SHA-256 完整性，并在用户确认后唤起原生安装包完成升级。

## Requirements

### Requirement: 自动检查更新
系统 SHALL 在桌面壳层启动时后台静默检查是否有新版本，且 SHALL 允许用户在设置中开启或关闭该行为（默认开启）。检查 SHALL 不阻塞界面，网络失败时静默忽略。系统 SHALL 缓存检查结果，距上次成功检查不足 4 小时时复用缓存结果。

### Requirement: 版本比较与过滤
系统 SHALL 按语义化版本（major.minor.patch）比较当前版本与最新版本，且 SHALL 忽略 GitHub 上的草稿（draft）与预发布（prerelease）版本，仅针对正式版本发起提示。

### Requirement: 产物智能匹配
系统 SHALL 根据当前操作系统（macOS / Windows / Linux）、CPU 架构（arm64 / amd64）与安装形态，精准匹配 GitHub Release 中的二进制产物（如 `iRouter-<v>-macos-arm64.dmg`）。

### Requirement: 流式下载与取消
系统 SHALL 流式下载对应产物到用户下载目录，写入 `.part` 临时文件并实时上报下载进度；用户点击取消或网络异常时，系统 SHALL 立即终止请求并清理临时文件。

### Requirement: 完整性校验与安全防线
系统 SHALL 在下载完成后拉取 `checksums.txt` 计算比对 SHA-256 哈希值。校验缺失或失败时，系统 SHALL NOT 提供安装入口，并引导用户至 Release 发布页。

### Requirement: 原生安装引导与退出
系统 SHALL 在用户确认安装后，以独立子进程唤起系统默认打开方式（macOS 打开 dmg、Windows 打开安装程序、Linux 打开 deb），并在短暂延时后安全退出主应用。
