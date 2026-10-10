## Why

Windows 与 Linux 上安装成功后首次打开应用，界面显示英文而非跟随系统中文。根因与平台无关：面板唯一的语言真值源是 cookie `locale`，全新安装没有 cookie 就落到 `DEFAULT_LOCALE = "en"`，而「跟随系统」只在用户主动点选时才触发。macOS 之所以「看起来正常」，只是升级安装保留了旧的 webview cookie store——**这是三平台共性问题，不是平台差异**。

同一批事实还暴露出三个相邻缺陷：

- 安装向导只有英文（`bundle.windows.nsis.languages` 缺省为 `["English"]`），中文 Windows 上装的是英文向导；
- 面板声明支持 34 种语言而实际只有 6 份字典，其余 28 种选中后 fetch 404 被吞掉、**静默回落全英文**；
- Windows/Linux 的「设置」入口只藏在托盘右键菜单里。面板内的 `HeaderMenu` 是重构遗留的孤儿组件（上游 `Header.js` 曾渲染它，本仓 `4c3a9c0` 的「顶栏精简」摘掉了渲染点），UI 上点不到。

## What Changes

- **定义「应用语言」并收敛成一条优先级链**：显式选择 > 系统语言 > 英文兜底。**壳层是唯一判定点**——它必须在面板存在之前就知道语言（要渲染原生菜单），判定结果经注入脚本写入面板 cookie，面板只消费不判定。
- **首启跟随系统**：壳层启动时按系统语言判定并注入，全新安装不再落到英文。
- **BREAKING（用户可见行为）**：面板支持语言从 34 种收窄到 3 种（`en` / `zh-CN` / `zh-TW`）。删除 `public/i18n/literals/{fa,id,nl,tl}.json`；**不支持的语言视为「未选择」**，回落系统语言，而不是静默显示英文。
- **显式选择的权威存储改为 `shell-settings.json` 的 `locale` 字段**（有壳层时）；cookie 降级为壳层注入的派生态，浏览器形态下 cookie 即本地权威。`localStorage["irouter_locale_preference"]` 与 `POST /api/locale` 退役（后者服务端只写不读）。
- **壳层菜单跟随显式选择**：用户在面板改语言后，原生菜单与托盘菜单文案同步更新。复用既有 `shell_set_settings` 与 `tray::refresh`，**不新增 IPC 命令、不新增权限**。
- **安装向导内置 `en` / `zh-CN` / `zh-TW`**，按系统语言自动匹配；**不**加语言选择对话框（`displayLanguageSelector` 保持默认 `false`）。
- **统一设置入口**：面板顶栏加齿轮（三平台一致，浏览器形态同样生效）；托盘入口保留并把「设置…」提到菜单第一项。Linux 托盘左键失效是 Tauri 上游限制（`TrayIconEvent` 在 Linux 不发射），接受并由面板齿轮兜住。
- **清理重构遗留的孤儿组件**：`HeaderMenu.js`、`ChangelogModal.js`、`Avatar`、`Footer`、`HeaderLanguage`、`LanguageSwitcher`（均零引用零测试）。
- **门禁**：断言 NSIS 语言列表（配置级 fail-fast + 产物级读生成的 `installer.nsi`）；断言面板 `LOCALES` 集合等于 `public/i18n/literals/` 字典集合——后者正是「34 种声明 vs 6 份字典」这个缺陷的编码化守卫。
- `<html lang>` 跟随应用语言（现为硬编码 `en`）。

## Capabilities

### New Capabilities

- `app-language`: 应用语言的判定与传播——优先级链、显式选择的权威存储、系统语言判定及各平台失败模式、注入面板、运行中变更语义、壳层菜单跟随
- `panel-i18n`: 面板界面语言的呈现——支持语言集合、字典与集合的一致性、cookie 消费、不支持语言的回落、`<html lang>`
- `installer-language`: 安装向导的语言——内置语言列表与系统语言匹配
- `settings-entry`: 设置入口——面板顶栏入口与托盘入口，及两者的三平台一致性

### Modified Capabilities

<!-- 无：openspec/specs/ 为空（尚未 sync 过任何能力），本变更引入的全部是新能力 -->

## Impact

- **壳层（`desktop-tauri/src-tauri/src/`）**：`shell/settings.rs` 增加 `locale` 字段（`normalize` 的白名单与单测同步）；`shell/mod.rs` 的应用语言缓存需支持写入并重建菜单；`shell/shim.js` 增加 locale 注入；`shell/tray.rs` 调整菜单项顺序。`Cargo.toml` / `build.rs` / `capabilities` **不变**（不新增 IPC 与权限）。
- **打包（`desktop-tauri/src-tauri/tauri.conf.json`）**：`bundle.windows.nsis.languages` 新增三语言。已有读取点全部是「取单键」（`version` / `productName` / `mainBinaryName` / `identifier`），无键集合全等断言，不会因此失败。
- **面板（`src/`）**：`src/i18n/config.js` 收窄 `LOCALES` 与 `normalizeLocale`；`src/i18n/runtime.js` 的 cookie 读取路径不变；`src/app/layout.js` 的 `lang` 改为动态；`src/shared/components/Header.js` 加齿轮；删除 `HeaderMenu.js` / `ChangelogModal.js` / `HeaderLanguage.js` / `LanguageSwitcher.js` / `Avatar.js` / `Footer.js` 及 `index.js` 对应导出。`src/app/api/locale/route.js` 与 `settings/GeneralSettings.js` / `AppearanceSettings.js` 的语言写入路径调整。
- **数据**：删除 `public/i18n/literals/{fa,id,nl,tl}.json`（`fa`/`id` 完整度较高，`nl`/`tl` 各仅约 205 条且大面积英文原样）。
- **文档**：`docs/release-notes/unreleased.zh-CN.md` 追加 Fixes 条目；四个语言术语并入仓库既有术语表 `CONTEXT.md`；新建 `docs/adr/0008-*.md`。
- **不受影响**：`src/app/api/**`（除 `locale`）、`src/lib/**`、`src/sse/**`、`open-sse/**` 一行不改——那是与上游 decolua/9router 的 merge 血缘。
- **已知限制（本变更不处理，需真机复核）**：Linux GUI 会话若 `LANG=C.UTF-8`，壳层、面板、服务端三层**同源**地都读不到中文（`sys_locale` 与 WebKitGTK 的 `navigator.language` 都来自 `LANGUAGE/LC_ALL/LANG`）。首启回落英文，用户显式选择一次后即固化。Windows 上 `sys_locale` 是否返回 `zh-Hans-CN` 仅有理论依据、无本机证据，实现后须看壳层启动日志确认。
- **首屏英文闪烁不在本次范围**：字典 145 KB，流程为 SSR 英文 → hydrate → fetch → 替换 DOM；修语言判定不会消除这一帧。
