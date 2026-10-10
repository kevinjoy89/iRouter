# Design

## Context

动机见 `proposal.md - Why`。以下只列影响做法的现状与约束。

**三处语言判定，彼此不知道对方存在**：

| 判定点 | 现状来源 | 语言集合 |
| :--- | :--- | :--- |
| NSIS 安装器 | `bundle.windows.nsis.languages` 未设 → Tauri 默认 `["English"]` | 1 种 |
| 壳层菜单（托盘 / 原生菜单） | `sys_locale::get_locale()`，启动时算一次并缓存在 `ShellState.locale` | 3 种，其余回退英文 |
| 面板 UI | cookie `locale` → `public/i18n/literals/{locale}.json`；无 cookie 则 `DEFAULT_LOCALE = "en"` | 声明 34 种 / 实有 6 份字典 |

**关键时序约束**：壳层必须在**面板存在之前**就知道语言——它要渲染原生菜单，而菜单在窗口创建时建立。面板没有任何独立的系统语言来源（cookie 首启为空；网关不读 `Accept-Language`，全仓零命中）。

**判定源的平台差异**（决定可行性）：

| 层 | macOS | Windows | Linux |
| :--- | :--- | :--- | :--- |
| 壳层 `sys_locale 0.3.2` | CoreFoundation 首选语言 ✅ | `GetUserPreferredUILanguages` ✅ | 仅 `LANGUAGE`/`LC_ALL`/`LC_MESSAGES`/`LANG` ⚠️ |
| 面板 `navigator.language` | 系统语言 ✅ | WebView2 显示语言 ⚠️ | WebKitGTK 的 `g_get_language_names()`，**与上行同源** ⚠️ |

即 Linux 上「壳层判定」与「面板判定」是同一个失败模式，换层消除不掉。

**注入时机**：`initialization_script` 的契约是「全局对象已创建、HTML 解析之前、页面自身脚本之前」，此时 `document` 已存在、`document.cookie` 可写，无需等 `DOMContentLoaded`。但它对**每次顶层导航**都生效——包括先加载的本地兜底页 `tauri://localhost`，因此必须 guard `window.location`。

**现有接缝（可直接复用）**：`shell_set_settings` 是既有 IPC 命令（已在 `build.rs` 声明、已在动态 capability 授权）；`tray::refresh` 与「`shell_set_settings` 后重建菜单」已存在；注入脚本已挂 `window.irouterShell`（既有 ABI，含 `platform` / `getSettings` / `setSetting` / `onOpenSettings`）。**本变更不需要新增 IPC 命令，因此不需要动 `build.rs` 与 capabilities。**

**面板改动边界**：`src/shared/components/**`（UI 层）可改；`src/app/api/**`、`src/lib/**`、`src/sse/**`、`open-sse/**`（引擎层）不动——那是与上游 decolua/9router 的 merge 血缘。`src/i18n/**` 虽是上游血缘，但历史上已多次作为 merge 冲突点本地处置（见 `openspec/changes/upstream-sync-*/tasks.md`），可改。

## Goals / Non-Goals

**Goals:**

- 让「应用语言」成为**一个**有明确定义、单一判定点、可被两个消费者共用的值
- 全新安装的界面（含安装向导）自动跟随系统语言
- 语言集合收敛到三处一致，并把「集合与字典不一致」这个已存在的缺陷编码成断言
- 三平台有统一且易达的设置入口

**Non-Goals:**

- **首屏英文闪烁**：字典 145 KB，流程为 SSR 英文 → hydrate → `useEffect` → fetch → 替换 DOM。修语言判定不消除这一帧；改它需要服务端读 cookie（把 `/dashboard` 从静态预渲染拉成动态渲染），且**首启那次仍读不到**（cookie 由 document-start 脚本写入，晚于 HTTP 响应）。不在本次范围。
- **Linux 系统语言兜底来源**：读 `/etc/default/locale`、`~/.config/plasma-localerc`、`gsettings` 是**猜测**，未实测，写了可能是死代码。记为待验证候选。
- **运行中改系统语言即时跟随**：桌面用户改系统语言后一般会重启；即时跟随要在两个进程各挂监听器，成本远大于收益。
- 补其它语言（集合收敛而非扩张）。
- `AppearanceSettings.js` 的处置：它是孤儿但被 2 条测试钉着，属「测试守着死代码」这个独立问题，需判断原断言是否仍成立后**单独一轮**处理。

## Decisions

### 1. 判定点放壳层，不放面板

**决定**：应用语言由壳层在启动时判定一次并缓存，经注入脚本传给面板。

**理由**：只有壳层在「首启那一刻」存在判定源；且它与壳层菜单**共用同一次判定**，天然避免「菜单中文、面板英文」——那正是本问题的形态。

**被否**：

- *面板读 `navigator.language`*：首启无 cookie 时它确实是唯一来源，但 Linux 上与 `sys_locale` 同源，换层不解决根因却各带一份成本；且 Windows 上有一条 2022 年的矛盾实测报告（WebView2 是否尊重显示语言）。
- *服务端读 `Accept-Language`*：网关零读取（要新增能力），且 WebKitGTK 文档明说它由 `set_preferred_languages` 决定，与 `navigator.language` 同源。
- *服务端读 cookie*：首启 cookie 为空，仍需先写一次；只能消除「已选过语言后」的闪烁，且代价是把 `/dashboard` 拉成动态渲染。

### 2. 显式选择的权威存储是 `shell-settings.json`

**决定**：`shell-settings.json` 增加 `locale` 字段作为显式选择的权威（有壳层时）；cookie 降级为壳层每次启动注入的**派生态**。浏览器形态下 cookie 即本地权威。

**理由**：壳层**必须先于面板**知道语言（时序约束），所以它不能等面板的 cookie。只有一个权威才可能不漂移。

**被否**：*cookie 权威、`shell-settings.json` 只是镜像* → 用户清 cookie 后壳层会显示旧语言；*两个各自独立* → 接受漂移。

**连带**：`localStorage["irouter_locale_preference"]` 退役（cookie 是三者里唯一服务端也看得见的，将来做 SSR 只有它能撑）；`POST /api/locale` 退役（服务端只写不读，而 cookie 本就能由客户端直接写——留着就是第二个写入口）。

### 3. 优先级链只在壳层实现一次

**决定**：壳层注入的是**已解析的应用语言**，不是原始系统 locale。面板逻辑固定为「cookie > 浏览器语言 > en」，不重跑优先级链。

**理由**：优先级链是应用级规则，实现两次必然分叉。浏览器形态下没有壳层注入，面板自然落到下一级——两种形态行为一致，不需要额外分支。

**被否**：*壳层只注入原始系统 locale、面板自己跑完整链* → 同一规则两处实现；*面板上报语言给壳层* → 那是「面板决定语言」的另一种写法，而面板自身没有任何系统语言来源（首启 cookie 为空），等于把判定点放回一个取不到值的地方。

### 4. 注入用 `initialization_script` + `window.location` guard

**决定**：在既有 `shell::shim_script()` 之外，于 document-start 写入 cookie；脚本内先判断 `window.location` 是否指向面板 origin，避免把 cookie 写进兜底页 origin。

**理由**：这是唯一「面板脚本之前」可用的通道，且不需要新权限。

**风险与备选**：Rust 侧 `WebviewWindow::set_cookie` 可在 navigate 前写，但仓库的 API 事实核查里 U3 未验证（「写入的 cookie 是否会被随后首个文档导航带上」文档未承诺）。选 init script 是因为它的时机有明确文档契约。

### 5. `LOCALES` 收窄到 3 种，并同步收窄 `normalizeLocale`

**决定**：`LOCALES` 从 34 项收窄到 `en`/`zh-CN`/`zh-TW`；删除 `public/i18n/literals/{fa,id,nl,tl}.json`；`normalizeLocale` 同步收窄，**不支持的语言视为「未选择」**而非「显式选择英文」。

**理由**：现状是「声明 34 种、实有 6 份字典」，选其余 28 种会 fetch 404 被吞掉、**静默全英文**——这是缺陷不是特性。「视为未选择」给「显式选择」一个干净定义：只有受支持的语言才算选择；否则 `LOCALES` 与 `normalizeLocale` 会长期各说各话。对 `id`/`fa` 用户严格更好（系统是中文时得到中文而非英文）。

**被否**：*保留 34 种* → 固定了「面板支持而菜单不支持」这第二种不一致；*扩到 6 种* → 壳层字典是编译期类型化的（`Strings` 结构体三实例，缺键编译失败），扩集合就是给 39 个键补 3 份人工翻译，而 `nl`/`tl` 各仅约 205 条且大面积英文原样（值==键），留着唯一作用是误导。

**安全性**：没有任何测试 import `@/i18n/config`；那个 34 宫格选择器（`LanguageSwitcher`）是死代码（只被零引用的 `HeaderLanguage` 引用）；设置面板的可见选项是**硬编码**的 4 项，与 `LOCALES` 脱钩。cookie 由客户端直接写、不经过白名单，存量 `nl` cookie 不会被 400 拒绝。

### 6. 壳层菜单跟随显式选择

**决定**：用户在面板改语言后，壳层原生菜单与托盘菜单文案同步更新。壳层设置读写与菜单重建都复用既有通道。

**理由**：优先级链是应用级规则，不该因「谁在显示」而分叉——否则用户选了中文、托盘还是英文，割裂感正是本问题的形态。接缝已现成，**零新增 IPC、零新增权限**。

### 7. Linux 的失败模式：接受，靠显式选择兜底

**决定**：Linux GUI 会话若 `LANG=C.UTF-8`，首启回落英文；用户显式选择一次后由决策 2 固化。

**理由**：三层同源（都落到 `LANGUAGE/LC_ALL/LANG`），换层无效。真正可靠的来源要引入桌面环境相关依赖或读发行版特定文件，风险与收益不成比例。**决策 6 才是这条限制的实际出路**。

### 8. 设置入口：面板顶栏齿轮 + 托盘保留

**决定**：面板顶栏右侧加齿轮，发既有 `irouter:open-settings` window 事件（照 `HeaderMenu` 里那个已成孤儿的写法）；托盘保留设置项并提到第一项。

**理由**：面板内入口是三平台唯一真正一致的方案（webview 内容与平台无关），且浏览器形态同样可用——用现成的 `Boolean(window.irouterShell)` 判定即可，无需新增机制。

**被否**：*给 Windows/Linux 加原生窗口菜单栏* → 会占掉一条窗口高度，且与面板自己的顶栏在视觉上重复（「一个 webview 应用套了层壳」与「原生窗口应用」是两种形态）；*换 tray 实现让 Linux 也支持左键事件* → 要重做三平台托盘，而该模块有「托盘白板」的前科，风险不成比例。

**Linux 托盘限制（事实）**：Tauri 文档明确 `TrayIconEvent` **在 Linux 不发射**、`show_menu_on_left_click` **在 Linux 不支持**。代码里那个左键唤窗分支在 Linux 上根本不会被触发——它是已实现但无效的。

### 9. 门禁：两条断言

**决定**：

- NSIS 语言：配置级 fail-fast + 产物级读生成的 `installer.nsi` 断言三条 `MUI_LANGUAGE`；
- 面板 `LOCALES` 集合 == `public/i18n/literals/` 字典集合。

**理由**：本仓有一条既有惯例——**用户可见的字符串一律按字面量钉死**（`.desktop` 的 Name/Comment/Categories、macOS 的 `LSMinimumSystemVersion`、deb 内的路径、release 二进制里的自测接缝），且注释里写明「只断言存在性抓不住文案回归」。NSIS 向导语言属同一类，目前**没有任何断言守着**（`.github/` 里 `nsis`/`installerIcon` 零命中）。第二条直接编码了「声明 34 种 vs 实有 6 份」这个已存在缺陷。

**被否**：*再加一条「设置项集合 == 壳层 i18n 集合」* → 要跨壳层/面板两个进程对账，需要新测试基建。

### 10. 删除重构遗留的孤儿组件

**决定**：删 `HeaderMenu.js`、`ChangelogModal.js`、`Avatar`、`Footer`、`HeaderLanguage`、`LanguageSwitcher`。

**理由**：`HeaderMenu` 是**曾经接入后被移除**（上游 `Header.js` 至今渲染它，本仓 `4c3a9c0` 的「顶栏精简，移除捐赠按钮、主题切换、语言切换及四宫格菜单」摘掉渲染点），此后 `05e14c5` 还给它的 Settings 项补了事件——**改的是一个当时已经没有渲染点的死组件**。其余几项零引用零测试。删 `LanguageSwitcher` 后，`LOCALES` 只剩 `isSupportedLocale` 一处消费点，语义更干净。

**注意**：删 `HeaderMenu` 会让 `ChangelogModal` 变成彻底无引用。Change Log / Shutdown / Logout 三个功能会从「不可达」变成「不存在」——它们的入口需求是独立的一件事，不在本变更范围（面板当前也确实没有登出入口）。

### 11. 文档形态

**决定**：`unreleased.zh-CN.md` 追加 Fixes 条目；四个术语（应用语言 / 显式选择 / 系统语言 / 安装器语言）并入 `CONTEXT.md`；写一条 ADR。

**理由**：术语已被 resolve，按惯例就该落盘，而「安装器语言 ≠ 应用语言」正是下一个人会搞混的地方。ADR 的三条判据（难以反转 / 无上下文会困惑 / 真实权衡）本次**全部成立**——因为它记录的是「为什么只有一个判定点、为什么权威存储放壳层」，而这两条都会被将来的维护者重新质疑。

**术语落在 `CONTEXT.md` 而非新建 `GLOSSARY.md`**：`CONTEXT.md` 就是本仓的术语表（同一种格式：`**术语（english）**:` + `_Avoid_:`），被 README / CONTRIBUTING / ADR 0004-0007 / `gateway.rs` / `dlp.test.js` 等 **29 处**引用，且既有惯例正是往它加词条（`request-redaction` 与 `effort-cap-degrade` 两次变更都是如此）。另起一个 `GLOSSARY.md` 会造出第二份术语表。**这是仓库惯例优先于工具默认假设的一个例子**：术语表技能的默认动作是「无 `GLOSSARY.md` 则新建」，但它只认这一个文件名，不认仓库用别的名字。

## Risks / Trade-offs

- **[Windows 上 `sys_locale` 是否返回 `zh-Hans-CN` 无本机证据]** → 仅有理论依据（`GetUserPreferredUILanguages`）与 Tauri 社区一条 2022 年的矛盾报告。缓解：实现后**真机看壳层启动日志**（`shell/mod.rs` 打的「菜单语言检测」行）确认取值；若为英文，判定点结论需重新审。这是本设计唯一未被证据钉死的环节。
- **[注入脚本在每次顶层导航都跑，可能把 cookie 写进兜底页 origin]** → guard `window.location`。
- **[壳层与面板两条 i18n 链路彻底独立，cookie 是唯一交接面]** → 用户清 cookie 会退回系统语言（合理行为，非损失）；但「显式选择」的持久化在 `shell-settings.json`，清 cookie 不影响它。
- **[收窄语言集合对存量 `nl`/`tl`/`fa`/`id` 用户是可见变化]** → 按决策 5 回落系统语言而非英文；`nl`/`tl` 字典本就大面积英文原样，实际感知差异很小。
- **[托盘「设置…」提前到第一项改变了 macOS 之外用户的肌肉记忆]** → 一次性小成本，换取入口更易达。
- **[删孤儿组件时若漏改 barrel 导出会导致构建失败]** → 删除与 `index.js` 导出调整在同一任务内完成，并跑构建验证。
- **[`shell-settings.json` 的 `normalize` 是白名单]** → 新增 `locale` 字段必须同步更新白名单与其单测（该文件现有单测明确钉住「未知键被丢弃」），漏改会导致语言设置写不进去。

## Migration Plan

无数据迁移。存量 `locale` cookie 中若为已废弃语言，按决策 5 视为未选择并回落系统语言——不需要迁移脚本，也不需要清 cookie。存量 `shell-settings.json` 没有 `locale` 字段即「未选择」，按优先级链回落，行为正确。

回滚：本变更不含不可逆的数据结构改动（`shell-settings.json` 新增字段对旧版本是未知键，旧版本的 `normalize` 会丢弃它，因此降级安全）。

## Open Questions

- Linux 上是否有**可靠的**系统语言来源（发行版/桌面环境特定文件或 API）。可安全推迟：不影响 spec、方案与任务拆分，且已有「显式选择」这条出路。
- `AppearanceSettings.js` 与其 2 条测试如何处置（改指 `GeneralSettings` 还是保留）。可安全推迟：它是孤儿，删除与否不影响本变更的 spec 行为。
