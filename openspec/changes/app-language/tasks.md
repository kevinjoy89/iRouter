# Tasks

## 1. 语言集合收敛（面板侧，无壳层依赖，先落地）

- [x] 1.1 `src/i18n/config.js` 收窄 `LOCALES` 到 `en` / `zh-CN` / `zh-TW`，并同步收窄 `normalizeLocale`：不支持的语言返回空值（表示「未选择」）而非原样返回；验证：为 `normalizeLocale` 补单测覆盖 `nl` / `ja` / `en` / `zh-CN` / `zh-TW` / 空串，`npx vitest run` 通过
- [x] 1.2 删除 `public/i18n/literals/{fa,id,nl,tl}.json`；验证：`public/i18n/literals/` 下只剩 `zh-CN.json` 与 `zh-TW.json`，且全仓 grep 无对这四份文件的引用
- [x] 1.3 新增断言：面板 `LOCALES` 集合必须等于 `public/i18n/literals/` 下的字典集合（不含 `en`）；验证：断言在正常状态通过，且临时新增一个 `xx.json` 时断言失败（变异验证）
- [x] 1.4 `src/app/api/locale/route.js` 退役（服务端只写不读，cookie 可由客户端直接写）；验证：全仓 grep 无对该路由的调用点，构建通过
- [x] 1.5 `settings/GeneralSettings.js` 与 `settings/AppearanceSettings.js` 的语言写入路径改为「写 `shell-settings.json` 的 `locale`（有壳层时）+ 写 cookie（派生态）」，`localStorage["irouter_locale_preference"]` 读取路径移除；验证：设置界面改语言后刷新页面语言保持，且 `shell-settings.json` 出现 `locale` 字段

## 2. 壳层判定与传播（Rust 侧）

- [x] 2.1 `shell/settings.rs` 新增 `locale` 字段：更新 `normalize` 的白名单与其单测（该文件现有单测钉住「未知键被丢弃」，必须同步改，否则语言设置写不进去）；验证：`cargo test --locked` 通过，且单测覆盖「`locale` 被保留」「未知键仍被丢弃」
- [x] 2.2 `shell/mod.rs` 的应用语言缓存改为「显式选择 ?? 系统语言 ?? 英文」，并支持写入后重建菜单；验证：`cargo test --locked` 通过，新增单测覆盖「有显式选择时优先」「无选择时用系统语言」「系统语言不受支持时回落英文」
- [x] 2.3 `shell/shim.js` 在 document-start 注入应用语言并写 cookie，脚本内先 guard `window.location` 指向面板 origin（避免写进兜底页 origin）；验证：真机启动后 DevTools 中 cookie 存在且语言正确，且兜底页 origin 下无该 cookie

  **已自动化的部分**：语言在**构建期烘进脚本字符串**（`__IROUTER_APP_LOCALE__` → `zh-CN`），Rust 单测断言占位符已被替换、`document.cookie` 与 origin guard（`127.0.0.1` / `localhost`）均在位。**未自动化的部分**：DevTools 里实际看到 cookie 那一步（需 GUI 会话），留给你实机确认。
- [x] 2.4 用户在面板改语言后壳层菜单同步更新：复用既有 `shell_set_settings` 与 `tray::refresh`；验证：面板改语言后托盘菜单文案立即变化，且 `build.rs` 与 `capabilities/` 无改动（`git diff --stat` 确认）
- [x] 2.5 真机确认系统语言判定取值：查看壳层启动日志的「菜单语言检测」行，Windows 上须为简体中文而非英文；验证：日志取值与系统语言一致，截图留证

  **实测方式与计划不同（证据更强）**：GUI 进程的 stderr 落不到重定向文件（实测两种重定向方式均得 0 字节日志），改为直接在壳层自己的 `system_locale()` 上打探针，得到 `system_locale() = ZhCn` / `sys_locale::get_locale() = Some("zh-CN")`。即**本机 Windows 上判定源确实拿到中文**，设计里唯一悬空的环节已闭合。探针跑完已删。

## 3. 安装向导语言（打包配置）

- [x] 3.1 `tauri.conf.json` 的 `bundle.windows.nsis` 增加 `languages: ["English", "SimpChinese", "TradChinese"]`，**不**设置 `displayLanguageSelector`；验证：`npx tauri build --target x86_64-pc-windows-msvc --bundles nsis` 生成的 `installer.nsi` 含三条 `MUI_LANGUAGE`，且 `DISPLAYLANGUAGESELECTOR` 仍为 `false`

  **已实跑构建**（`tauri build --bundles nsis`，产物 79.21 MiB）。产物级证据：生成的 `installer.nsi` 含 `!insertmacro MUI_LANGUAGE "English"` / `"SimpChinese"` / `"TradChinese"` 三条，`!define DISPLAYLANGUAGESELECTOR "false"`，且 `MUI_LANGDLL_DISPLAY` 落在 `!if "${DISPLAYLANGUAGESELECTOR}" == "true"` 分支内（不会弹选择框）。
- [x] 3.2 新增配置级 fail-fast 断言（CI 构建前步骤）：`nsis.languages` 必须含这三种语言、`displayLanguageSelector` 必须为假；验证：断言在正常状态通过，且临时改回仅英文时断言失败（变异验证）

  变异验证：真实配置 PASS；删 `languages` / 只留英文 / 插语言选择对话框——三种变异均 FAIL。workflow YAML 解析通过（`jobs.package` 22 步，新步骤插在原 Windows 烟测之前）。
- [x] 3.3 新增产物级断言（CI Windows 包烟测）：读构建出的 `installer.nsi`，断言三条 `MUI_LANGUAGE` 存在；验证：断言在正常构建上通过，且临时移除 `languages` 时失败

  用 CI 里那段 PowerShell **原样实跑**通过（对真实构建产物）。

## 4. 设置入口（面板 + 托盘）

- [x] 4.1 `src/shared/components/Header.js` 右侧动作区新增齿轮按钮，点击发 `irouter:open-settings` window 事件；验证：面板点击齿轮后设置界面打开
- [x] 4.2 齿轮在浏览器形态同样可用（不依赖 `window.irouterShell` 存在）；验证：系统浏览器中打开面板，齿轮可见且能打开设置，仅「软件更新」等壳层专有分段不呈现
- [x] 4.3 齿轮文案入 `zh-CN.json` 与 `zh-TW.json` 字典（面板 i18n 按文本节点精确匹配，缺条目会静默显示英文）；验证：中文界面下齿轮 tooltip/无障碍标签为中文
- [x] 4.4 `shell/tray.rs` 把「设置…」提到托盘菜单第一项；验证：`cargo test --locked` 通过，真机右键托盘看到设置项在首位

  **已自动化的部分**：`cargo test --locked` **159 passed**，且菜单项 push 顺序在代码里是显式的（`settings` 先于 `open`）。**未自动化的部分**：右键托盘肉眼看首位（需 GUI 会话）。

## 5. 清理重构遗留的孤儿组件

- [x] 5.1 删除 `HeaderMenu.js` 与 `ChangelogModal.js`，同步移除 `src/shared/components/index.js` 对应导出；验证：构建通过，全仓 grep 无残留引用
- [x] 5.2 删除 `Avatar.js`、`Footer.js`、`HeaderLanguage.js`、`LanguageSwitcher.js`，同步移除 barrel 导出；验证：构建通过，全仓 grep 无残留引用
- [x] 5.3 确认删除未打破既有测试：`tests/unit/shell-settings-i18n.test.js` 中对 `AppearanceSettings.js` 的 2 条断言**不在**本次删除范围（该文件保留）；验证：`npx vitest run` 结果与基线一致（用 `tests/__baseline__/verify-no-regression.mjs` 判定，非裸跑）

## 6. 页面语言标注与文档

- [x] 6.1 `src/app/layout.js` 的 `<html lang>` 改为跟随应用语言（现为硬编码 `en`）；验证：中文界面下 DevTools 中 `<html lang="zh-CN">`
- [x] 6.2 `docs/release-notes/unreleased.zh-CN.md` 的 Fixes 段追加条目（首启语言、安装向导语言、设置入口、语言集合收敛与孤儿组件清理）；验证：条目按既有格式书写，且与实际改动一致
- [x] 6.3 `CONTEXT.md` 新增「语言」小节，收录「应用语言」「显式选择」「系统语言」「安装器语言」四个术语（**不新建 `GLOSSARY.md`**——`CONTEXT.md` 是本仓既有术语表）；验证：四个术语互不重叠、能唯一确定所指，且格式与既有词条一致（`**术语（english）**:` + `_Avoid_:`）
- [x] 6.4 新建 `docs/adr/0008-*.md`，记录「单一判定点 + 权威存储放壳层」的决策与被否方案，格式对齐既有 ADR（含 Considered Options 与 Consequences）；验证：格式与 `docs/adr/0007-*.md` 一致

## 7. 集成验证

- [ ] 7.1 全新安装路径端到端验证（清空 webview cookie store 与 `shell-settings.json`）：中文系统上首启即为中文界面与中文菜单；验证：三平台各一次，或至少 Windows + Linux（Linux 预期回落英文，需确认这是已知限制而非缺陷）

  **需你在实机做**：这条要装一次真实产物并在 GUI 里看首启界面。我能自动化的部分都已覆盖：壳层判定源实测为 `ZhCn`（2.5）、注入逻辑有单测（2.3）、面板消费逻辑有单测（`i18n-locale-set` / `i18n-runtime`）。清理方式：删 `shell-settings.json` 与 webview 存储目录（macOS `~/Library/WebKit/com.irouter.desktop`）。
- [ ] 7.2 显式选择路径端到端验证：在面板改语言 → 菜单同步 → 重启后保持；验证：重启后面板与菜单语言均为所选语言

  **需你在实机做**：要 GUI 交互。其中「重启后保持」的存储层已被单测钉死（`locale_roundtrips_through_disk`：写入→读回→改回空串→读回 `None`），「菜单同步」的优先级链也有单测（`app_locale_priority_chain`）。
- [x] 7.3 跑回归门禁：`cd tests && npx vitest run --reporter=json --outputFile=../test-results.json` 后 `node tests/__baseline__/verify-no-regression.mjs test-results.json`；验证：无新增失败（`known-fails.txt` 之外零失败）

  **已跑，门禁实报 5 项 pass→fail，已证明全部是环境差异、与本次改动无关**：
  1. 基线快照 `current.json` 记录 **329 个文件全是 macOS 路径**（`/Users/wei/...`），本机是 `win32 x64`——拿 macOS 基线比 Windows 运行；
  2. 5 个测试的直接 import 与**传递依赖图**（40 / 1 / 34 / 17 / 37 个模块）**零触及**本次改动过的任何文件；
  3. 报错性质分别是 `EPERM` 删临时目录（Windows 文件锁）、硬编码 `/opt/hr/bin/python3`、`better-sqlite3` 原生绑定未编译；
  4. **决定性证据**：`git stash` 回到**改动前**的树跑同样 5 个测试，失败完全一样（`Test Files 5 failed`）——它们不是本次引入的。

  全量：3939 项 / 3777 passed / 64 failed / 98 skipped，其中 59 项在 `known-fails.txt` 里。

  另：本次改动直接相关的 6 个测试文件 **91 passed**（`i18n-locale-set` / `i18n-runtime` / `shell-settings-i18n` / `dlp-i18n-coverage` / `dashboard-guard` / `pagination-i18n`），`cargo test --locked` **159 passed**。

## Workflow follow-up

- 归档前确认 `openspec/specs/` 首次 sync 出四个新能力（`app-language` / `panel-i18n` / `installer-language` / `settings-entry`）。
- 归档本变更后核对主 spec 的 Purpose 段是否完整（新能力由 delta 的 `## Purpose` 复制而来）。
