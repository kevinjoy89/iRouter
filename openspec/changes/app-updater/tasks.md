# Tasks

- [x] 深入调研父项目 `cli-analyzer` 更新机制的完整实现与设计决策 <!-- id: 0 -->
- [x] 创建纯逻辑模块 `desktop/updater/version.js`，实现语义化版本解析与比较 <!-- id: 1 -->
- [x] 创建纯逻辑模块 `desktop/updater/asset.js`，实现跨平台架构产物智能匹配 <!-- id: 2 -->
- [x] 创建纯逻辑模块 `desktop/updater/checksum.js`，实现 `checksums.txt` 解析与 SHA-256 校验 <!-- id: 3 -->
- [x] 创建纯逻辑模块 `desktop/updater/checker.js`，实现 GitHub Releases 查询、草稿预发布过滤与限流缓存 <!-- id: 4 -->
- [x] 创建模块 `desktop/updater/download.js` 与 `desktop/updater/installer.js`，实现流式下载、断点取消与系统原生安装器调起 <!-- id: 5 -->
- [x] 为 updater 编写单元测试（`updater-version.test.js`, `updater-asset.test.js`, `updater-checksum.test.js`, `updater-checker.test.js`）并全部通过 <!-- id: 6 -->
- [x] 扩展 `desktop/settings.js`，支持 `checkUpdates`、`lastCheckAt`、`lastCheckResult` 与 `ignoredVersion` <!-- id: 7 -->
- [x] 扩展 `desktop/preload.js`，暴露更新检测、下载、取消、安装、忽略与事件监听的完整安全 IPC 桥接 <!-- id: 8 -->
- [x] 扩展 `desktop/main.js`，注册更新 IPC 管道、集成应用菜单/帮助菜单/系统托盘「检查更新…」入口并调度启动静默检测 <!-- id: 9 -->
- [x] 更新 `src/shared/components/ShellSettingsModal.js`，集成软件更新界面、下载进度条与安装引导 <!-- id: 10 -->
- [x] 补齐 `zh-CN.json` 与 `zh-TW.json` 翻译词典，确保 `shell-settings-i18n.test.js` 守卫测试全部通过 <!-- id: 11 -->
- [x] 更新 `desktop/electron-builder.yml` 打包配置，纳入 `updater/**/*` 模块 <!-- id: 12 -->
- [x] 验证 `build-server.mjs` 编译与基线门禁 `verify-no-regression.mjs` 全部 100% 通过 <!-- id: 13 -->
- [x] 归档 OpenSpec 规范文档 `openspec/changes/app-updater/` <!-- id: 14 -->
