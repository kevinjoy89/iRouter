## Why

iRouter 桌面客户端此前没有内置的自动或手动更新检测机制，用户只能定期手动前往 GitHub Releases 页面检查与下载。对于一款作为本地 AI 基础设施底座的桌面客户端，割裂的升级体验增加了用户的运维负担。参照父项目 `cli-analyzer` 的最佳实践，我们需要建立一套完整的更新闭环机制：启动静默检查、新版本提醒、资产智能匹配、流式下载进度管理、SHA-256 完整性校验、系统原生安装引导，同时保持安全性与不打扰原则。

## What Changes

- 新增 `desktop/updater/` 纯逻辑模块套件：
  - `version.js`：SemVer 语义化版本解析与比对。
  - `asset.js`：按平台架构（macOS arm64/amd64、Windows installer/portable、Linux deb/tarball）自动匹配 GitHub Release 资产。
  - `checksum.js`：解析 release 附带的 `checksums.txt` 并流式比对本地产物 SHA-256。
  - `checker.js`：查询 GitHub Releases API，过滤 draft/prerelease，支持 4 小时静默限流缓存与版本忽略。
  - `download.js`：流式下载至 `~/Downloads`，`.part` 临时文件与取消/异常自动清理。
  - `installer.js`：以 detached 独立进程唤起系统原生安装器（macOS `open`、Windows `start`、Linux `xdg-open`），随后安全退出。
- 壳层设置扩展（`desktop/settings.js`）：
  - 增加 `checkUpdates`（自动检查开关）、`lastCheckAt`、`lastCheckResult`、`ignoredVersion` 配置项。
- 壳层进程与通道（`desktop/main.js` & `desktop/preload.js`）：
  - 注册 `shell:check-update`、`shell:download-update`、`shell:cancel-download`、`shell:install-update`、`shell:ignore-version` 等安全 IPC。
  - 应用原生菜单栏（macOS iRouter 菜单、全平台 Help 菜单）与系统托盘菜单增加「检查更新…」入口。
  - 启动后延时调度后台静默更新检测。
- 界面集成（`src/shared/components/ShellSettingsModal.js`）：
  - 桌面壳层设置面板内集成「软件更新」控制区，支持实时下载进度条、校验结果提示与安装引导。
  - 多语言全面入典（`public/i18n/literals/`），通过 `shell-settings-i18n.test.js` 守卫验证。
- 打包集成（`desktop/electron-builder.yml`）：
  - 在打包 `files` 中纳入 `updater/**/*` 模块。

## Capabilities

### New Capabilities
- `app-update`: 包含版本检测、Release 产物精准匹配、下载进度与取消、SHA-256 校验防护、安装引导与版本忽略。
