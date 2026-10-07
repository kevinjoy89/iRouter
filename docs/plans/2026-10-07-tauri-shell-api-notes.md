# Tauri v2.12 壳层 API 事实核查（Phase 3/4 前置）

> **用途**：让 `docs/plans/2026-10-07-tauri-bun-migration.md` 的 Phase 3/4 Rust 实现**不需要靠猜**。
> **核查日期**：2026-10-07。**核查人**：tauri-api-recon（task-1）。
> **写域**：本文件是本次核查唯一的产出；核查过程只读仓库，未触碰 `desktop-tauri/`、`desktop/`、`src/`、`.github/`。

## 0. 核查方法与证据等级

网络在本环境可用（`curl` 可直连 crates.io / docs.rs / raw.githubusercontent.com），因此**没有一条结论来自记忆**。证据分四级，正文中逐条标注：

| 级别 | 含义 | 为什么可信 |
| :-- | :-- | :-- |
| **A** | **已发布 crate 的源码**（下载 `.crate` 解包后直接读） | 下载的 `tauri-2.12.1.crate` 的 sha256 = `ed99ee9694a2deb776d91cae48ac7411ddfc89ecae2f9b5041111d8c88f2ace9`，与 crates.io sparse index 记录的 `cksum` **逐字节一致**。这是"真正会被 cargo 拉下来的那份源码"。 |
| **B** | **docs.rs 渲染页 / 源码页** | docs.rs 从同一份已发布 crate 构建；适合作为"点开就能验证"的公开链接。 |
| **C** | **官方文档站 v2.tauri.app** | 官方权威叙述，但可能与已发布 crate 有版本差（下文逐处标注）。 |
| **D** | **上游 GitHub 源码 / PR** | 用于看 `dev` 分支（未发布）的内容，**不能当成已发布行为**。 |
| **U** | **unverified** | 查不到官方出处，明确标出，**不作为结论使用**。 |

**版本矩阵（全部实测于 2026-10-07）**

| crate | 本文件所用版本 | 发布时间（crates.io） | 备注 |
| :-- | :-- | :-- | :-- |
| `tauri` | **2.12.1** | 2026-09-30T20:47:44Z | 2.x 最新稳定版；依赖 `tauri-macros ~2.7.1`、`tauri-utils ~2.10.1`、`tauri-runtime ~2.12.1`、`muda ^0.20`、`tray-icon ^0.25` |
| `tauri` | 2.12.0 | 2026-09-26 | |
| `tauri` | 3.0.0-alpha.4 | 2026-10-01 | 对照用（见 §1） |
| `tauri-plugin-shell` | **2.4.0** | — | `[dependencies.tauri] version = "2.12"` |
| `tauri-plugin-single-instance` | **2.5.2** | — | 同上 |
| `tauri-plugin-autostart` | **2.7.0** | — | 同上，底层 `auto-launch 0.6` |
| `tauri-plugin-opener` | 2.5.5 | — | `open` 系调用（更新器要用） |
| `tauri-macros` / `tauri-utils` | 2.7.1 / 2.10.1 | — | 2.12.1 实际依赖的版本 |

> 注意：本机 `~/.cargo/registry` 里已有 `tauri-2.11.5/2.11.6` 等（Lead 脚手架时拉的）。**2.11.x 不满足下面 §1 的结论也不满足 ADR 的锁版本意图**，锁版本时以 `Cargo.lock` 为准。

---

## 1. 先看这条：迁移计划里"Tauri ≥ 2.12.1 提供 sidecar 注册表"的说法**与事实不符**

`docs/adr/0007-tauri-bun-shell.md:52` 与迁移计划 `Global Constraints` 都写着：

> 孤儿回收依赖 Tauri ≥ 2.12.1 的 sidecar 注册表 + `cleanup_before_exit`（该能力 2026-09-18 才修好）——必须锁版本。

**逐条核对结果（全部为 A 级证据）：**

1. **2.12.1 里不存在 `register_sidecar` / `unregister_sidecar` / `kill_process_tree`。**
   对解包后的 `tauri-2.12.1/src/` 全树 grep `register_sidecar|unregister_sidecar|kill_process_tree` → **0 命中**；对已下载的 `tauri-plugin-shell 2.4.0`、`single-instance 2.5.2`、`autostart 2.7.0`、`opener 2.5.5`、`positioner 2.3.4` 同样 **0 命中**。
2. **2.12.1 里也不存在 `Plugin::cleanup_before_exit` / `Builder::on_cleanup_before_exit`。**
   - 2.12.1 的 `src/plugin.rs` 只有 `name / initialize / initialization_script / on_event / on_drop / extend_api / on_window_ready / on_webview_ready`，无该 hook。
   - 公开可点验证：[docs.rs/tauri/2.12.1/tauri/plugin/trait.Plugin.html](https://docs.rs/tauri/2.12.1/tauri/plugin/trait.Plugin.html) → 页面里 **`cleanup_before_exit` 不存在**；[docs.rs/tauri/3.0.0-alpha.4/…trait.Plugin.html](https://docs.rs/tauri/3.0.0-alpha.4/tauri/plugin/trait.Plugin.html) → 页面里 **存在**（"Provided Methods: cleanup_before_exit initialization_script …"）。两者我都用 curl 取回页面并 grep 验证。
3. **PR #14443 的实际合并内容 ≠ PR 描述。**
   PR 描述（<https://github.com/tauri-apps/tauri/pull/14443>，merged 2026-09-18T17:02:26Z，merge commit `f6634b2f`）声称引入 `tauri::process::kill_process_tree(pid)`、`AppHandle::register_sidecar/unregister_sidecar`。但 [PR 的 changed files API](https://api.github.com/repos/tauri-apps/tauri/pulls/14443/files) 只有 5 个文件，且 `crates/tauri/src/app.rs` 仅 **+9 行**、`crates/tauri/src/plugin.rs` **+89 行**、`crates/tauri-cli/.../desktop.rs` +36 行。**没有任何 `process.rs` / `mod.rs` 改动，没有 PID 注册表，没有 kill 助手。**
   合并进来的只有三样东西：
   - `Plugin::cleanup_before_exit(&mut self, app: &AppHandle<R>)`（默认空实现）
   - `plugin::Builder::on_cleanup_before_exit<F: FnMut(&AppHandle<R>) + Send + 'static>(mut self, f: F) -> Self`
   - `App::cleanup_before_exit()` 现在会先跑一遍全部插件的该 hook；以及 `tauri dev` 重启时杀 dev 子进程树。
4. **它进的是下一个 minor，不是 2.12.x。**
   同一 commit 里的 changeset（[`.changes/plugin-cleanup-before-exit.md`](https://raw.githubusercontent.com/tauri-apps/tauri/f6634b2f823488c4ba3352c30e3b44f95aa9fb92/.changes/plugin-cleanup-before-exit.md)）头部是 `"tauri": minor:feat` —— 语义化版本下这是 **minor**，不会进 patch 版。
   `crates/tauri/CHANGELOG.md`（dev 分支）里 `## [2.12.1]` 段只有一条无关 bugfix（`macos-private-api` 不再必需）；全文件 grep `cleanup_before_exit` 只命中 1.x 时代的 `App::cleanup_before_exit` 引入记录，**没有本次 hook 的发布记录**。
   实证：`3.0.0-alpha.2`（2026-09-21 发布）之后的 3.0.0-alpha.x **已包含**该 hook（我在 `tauri-3.0.0-alpha.4` 源码里 grep 到 `on_cleanup_before_exit`）。
5. **hook 自己声明的适用边界**（这段文档注释就在 `plugin.rs` 里，A 级）：
   > Unlike `RunEvent::Exit`, this hook also runs on exit paths that bypass the event loop, e.g. `AppHandle::restart` when called on the main thread. … It **does not run when the process is killed** (e.g. by `tauri dev` on rebuild) **or when `std::process::exit` is called directly.**

**对 Phase 3/4 的含义（这是本次核查最重要的一条）：**

- **锁 `tauri = 2.12.1` 拿不到你想要的孤儿回收能力**；想要"官方 hook"必须上 **`3.0.0-alpha.x`**（预发布，不能在验收线要求"三平台稳定"的迁移里当基线）。
- 计划里点名的三条 API 不存在 → Phase 3 Step 3 的写法必须是**自研 PID 文件 + 退出钩子 + 启动回收**（照抄 `desktop/main.js:197,226-285` 的语义），而不是调 `register_sidecar`。
- 好消息：三条死亡路径的**真实现状**（见 §6.3）恰好说明"自研 PID 回收"是唯一能覆盖全部路径的做法，所以这不是退而求其次，而是**唯一正确解**。

---

## 2. 托盘（Tray）

crate：`tauri 2.12.1`，模块 `tauri::tray`。**必须显式打开 feature `tray-icon`**（它不在 default 里：default = `wry, compression, common-controls-v6, dynamic-acl, x11, dbus`）；`TrayIconBuilder::icon(Image)` 传 PNG 字节还需要 `image-png`/`image-ico` feature（`Image::from_bytes` 被 `#[cfg(any(feature = "image-ico", feature = "image-png"))]` 门控）。

**确切签名**（A 级，`tauri-2.12.1/src/tray/mod.rs`；B 级链接 [struct.TrayIconBuilder](https://docs.rs/tauri/2.12.1/tauri/tray/struct.TrayIconBuilder.html)）：

```rust
TrayIconBuilder::new() -> Self                                   // :216
    .with_id<I: Into<TrayIconId>>(id: I) -> Self                  // :230
    .menu<M: ContextMenu>(menu: &M) -> Self                        // :241
    .icon(icon: Image<'_>) -> Self                                 // :252
    .tooltip<S: AsRef<str>>(s: S) -> Self                          // :265
    .title<S: AsRef<str>>(title: S) -> Self                        // :280  (Windows 不支持)
    .icon_as_template(is_template: bool) -> Self                   // :295  (macOS only)
    .show_menu_on_left_click(enable: bool) -> Self                 // :319  (默认 true；Linux 不支持)
    .on_menu_event<F: Fn(&AppHandle<R>, MenuEvent) + Sync + Send + 'static>(f: F) -> Self  // :328
    .on_tray_icon_event<F: Fn(&TrayIcon<R>, TrayIconEvent) + Sync + Send + 'static>(f: F) -> Self  // :337
    .build<M: Manager<R>>(&self, manager: &M) -> crate::Result<TrayIcon<R>>   // :386

TrayIcon::set_menu<M: ContextMenu + 'static>(&self, menu: Option<M>) -> crate::Result<()>  // :512
TrayIcon::set_tooltip<S: AsRef<str>>(&self, tooltip: Option<S>) -> crate::Result<()>       // :523
TrayIcon::set_icon(&self, icon: Option<Image<'_>>) -> crate::Result<()>                    // :499
```

来源：[docs.rs 源码页 src/tauri/tray/mod.rs.html](https://docs.rs/tauri/2.12.1/src/tauri/tray/mod.rs.html)、[v2.tauri.app/learn/system-tray](https://v2.tauri.app/learn/system-tray/)（C 级）。

**事件与左/右键/双击**

```rust
pub enum TrayIconEvent {
  Click { id, position: PhysicalPosition<f64>, rect: Rect,
          button: MouseButton, button_state: MouseButtonState },   // :74
  DoubleClick { id, position, rect, button },                      // :87 —— 文档明确标 **Windows Only**
  Enter/Move/Leave { id, position, rect },                         // :98/:107/:116
}
```

- 左键默认行为是**弹菜单**（`show_menu_on_left_click` 默认 `true`）。要让左键点图标"唤出窗口"、右键弹菜单，就 `show_menu_on_left_click(false)`，然后在 `Click` 事件里按 `button == MouseButton::Left && button_state == MouseButtonState::Up` 自己分发。
- **双击不跨平台**：Electron 版 `desktop/main.js:1505` 的 `tray.on("double-click", showWindow)` 在 Tauri 下只有 Windows 有原生 `DoubleClick`；macOS/Linux 需要自己用两个 `Click` 时间差判定（**属实现选择，不是 API 事实**）。
- macOS 模板图：`icon_as_template(true)` 一行搞定（文档原文 "Use the icon as a template. **macOS only**"）。要求仍是**只提供黑色+alpha 的 PNG**（模板图只用 alpha 通道着色）——这是 Apple 的模板图语义，见 [NSImage.isTemplate](https://developer.apple.com/documentation/appkit/nsimage/1520017-template)。Electron 版 `trayIcon()`（`desktop/main.js:1452-1462`）的 18×18 resize 在 Tauri 下**不需要**：`Image` 是位图，macOS 菜单栏缩放由系统做；但**图标资产仍应准备 @1x/@2x 或至少 36px 源图**以免模糊（**属经验判断，非本文核查结论**）。
- 托盘菜单的动态文案（多语言切换）：照 §5.1 建 `Menu`，再 `TrayIcon::set_menu(Some(menu))`（`&TrayIcon` 可从 `app.tray_by_id(&id)` 拿，见 [Manager::tray_by_id](https://docs.rs/tauri/2.12.1/tauri/trait.Manager.html)）。

> **对 `desktop/main.js:1483-1506` 的等价性**：`updateTrayMenu()` 的 5 项菜单、`setToolTip`、左键/双击唤出，以上 API 全部可 1:1 表达。

---

## 3. 开机自启（Autostart）

crate：**`tauri-plugin-autostart 2.7.0`**（官方 plugin，不是"手写 LaunchAgent"）。`[dependencies.tauri] version = "2.12"`，与 2.12.1 兼容。

**确切签名**（A 级，`tauri-plugin-autostart-2.7.0/src/lib.rs`）：

```rust
pub enum MacosLauncher { LaunchAgent,  // #[default]
                         AppleScript }                     // :28-39

pub struct Builder { .. }
impl Builder {
  pub fn new() -> Self;                                        // :158
  pub fn arg<S: Into<String>>(self, arg: S) -> Self;           // :171
  pub fn args<I, S: Into<String>>(self, args: I) -> Self;      // :183
  pub fn app_name<S: Into<String>>(self, app_name: S) -> Self; // :209
  pub fn macos_launcher(self, m: MacosLauncher) -> Self;       // :197 (macOS only)
  pub fn build<R: Runtime>(self) -> TauriPlugin<R>;            // :219
}
pub fn init<R: Runtime>(macos_launcher: MacosLauncher,
                        args: Option<Vec<&'static str>>) -> TauriPlugin<R>;  // :281 (旧入口，仍在)

pub trait ManagerExt<R: Runtime>: Manager<R> {
  fn autolaunch(&self) -> State<'_, AutoLaunchManager>;         // :119-128
}
impl AutoLaunchManager {
  pub fn enable(&self) -> Result<()>;                           // :82
  pub fn disable(&self) -> Result<()>;                          // :94
  pub fn is_enabled(&self) -> Result<bool>;                     // :109
}
```

平台落点（A 级：`Builder::build` 的实现，`src/lib.rs:219-282`）：macOS 走 `auto-launch 0.6` 的 `MacOSLaunchMode::LaunchAgent`（默认，写 `~/Library/LaunchAgents/*.plist`）或 AppleScript；Windows 用当前 exe 路径；Linux 优先用 `APPIMAGE` 环境变量，否则当前 exe。**`MacosLauncher::LaunchAgent` 是默认值**，与 ADR/计划的意图一致。

**`openAsHidden` 语义怎么等价实现**：**官方插件不提供"隐藏启动"开关**（已核对：`Builder` 只有 `arg/args/app_name/macos_launcher/build`）。等价做法是官方文档自己示范的方式——**带一个标记参数启动，自己判断**：

```rust
// 注册（desktop only）
app.handle().plugin(
  tauri_plugin_autostart::Builder::new()
    .arg("--from-autostart")          // ← 官方示例就是 .arg("--from-autostart")
    .build()
)?;
// 启动时
let opened_at_login = std::env::args().any(|a| a == "--from-autostart");
if !opened_at_login { show_main_window(); }   // 否则只驻留托盘
```

来源（C 级）：[v2.tauri.app/plugin/autostart](https://v2.tauri.app/plugin/autostart/)（页面里的 Rust 示例即 `init(MacosLauncher::LaunchAgent, Some(vec!["--flag1","--flag2"]))`；`ManagerExt::autolaunch()` 的用法也在此）。B 级：[struct.Builder](https://docs.rs/tauri-plugin-autostart/2.7.0/tauri_plugin_autostart/struct.Builder.html)。

> 与 `desktop/main.js:1464-1478, 2110-2116` 的对照：`app.getLoginItemSettings().openAtLogin` ↔ `autolaunch().is_enabled()`；`setLoginItemSettings({openAtLogin, openAsHidden:true})` ↔ `autolaunch().enable()` + `.arg("--from-autostart")`；`app.getLoginItemSettings().wasOpenedAtLogin` ↔ **自己解析 argv**。
> ⚠️ **`wasOpenedAtLogin` 没有等价物**：Tauri 不能告诉你"这次是登录项拉起的"。标记参数法在"用户手动带 `--from-autostart` 启动"时会误判为隐藏启动，属可接受误判；若不可接受，用"LaunchAgent 的 argv 里带标记 + 单实例"组合即可（**属设计建议，非 API 事实**）。
> ⚠️ 权限：JS 侧调用需要 `autostart:allow-enable|disable|is-enabled`（C 级，同上文档页）。Rust 侧调用 `ManagerExt::autolaunch()` **不需要** capability（capability 只管 webview→IPC）。

---

## 4. 单实例（Single Instance）

crate：**`tauri-plugin-single-instance 2.5.2`**。

**确切签名**（A 级，`tauri-plugin-single-instance-2.5.2/src/lib.rs`）：

```rust
pub fn init<R: Runtime,
            F: FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static>
           (f: F) -> TauriPlugin<R>;                            // :49
// 回调三参：app, argv(第二次启动的完整 argv), cwd

pub struct Builder<R: Runtime> { .. }
impl<R: Runtime> Builder<R> {
  pub fn new() -> Self;                                          // :93
  pub fn callback<F: FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static>(self, f: F) -> Self;  // :99
  pub fn dbus_id(self, dbus_id: impl Into<String>) -> Self;      // :118
  pub fn build(self) -> TauriPlugin<R>;                          // :127
}

/// 释放"另一个实例"检测资源（Windows named mutex / Linux D-Bus name / macOS Unix socket）。
/// 插件自己在 RunEvent::Exit 里调；绕过该事件终止进程时（例如直接 std::process::exit）必须手动调。
pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M);          // :62
```

**第二次启动的 argv：有，直接进回调第二参。** 现 Electron 实现只看 `second-instance` 不看 argv（`desktop/main.js:2140-2142`），Tauri 版**顺手就能拿到 `args: Vec<String>` 与 `cwd: String`**——如果将来要支持 `irouter://` 之类的深链或 CLI 参数，这里就是入口。

**二次唤起时聚焦已有窗口**：回调里自己做，`AppHandle` → `get_webview_window("main")` → `show()/unminimize()/set_focus()`（签名见 §8）。macOS 还有一个 Electron `app.on("activate")` 的等价物：`RunEvent::Reopen { has_visible_windows }`（A 级，`src/app.rs:279`，`#[cfg(target_os = "macos")]`）。

> **必须配对的一步**：若你的更新器/退出路径用 `std::process::exit()`，**必须**先 `tauri_plugin_single_instance::destroy(&app)`——这是插件文档在 `fn destroy` 上明写的（否则下次启动会被误判为"已有实例在跑"）。受限的死亡路径见 §6.3。
> B 级链接：[fn.init](https://docs.rs/tauri-plugin-single-instance/2.5.2/tauri_plugin_single_instance/fn.init.html)、[fn.destroy](https://docs.rs/tauri-plugin-single-instance/2.5.2/tauri_plugin_single_instance/fn.destroy.html)。A 级源码页：[lib.rs.html](https://docs.rs/tauri-plugin-single-instance/2.5.2/src/tauri_plugin_single_instance/lib.rs.html)。

---

## 5. 应用菜单、右键菜单、以及 Cmd/Ctrl+C/V/A 那 80 行能不能删

crate：`tauri 2.12.1`，模块 `tauri::menu`。**菜单不需要 capability**（capability 只管 webview→IPC；`Menu`/`TrayIcon` 是 Rust 侧 API）。

### 5.1 确切构造签名（A 级，`src/menu/*.rs`）

```rust
// Menu
Menu::with_items<M: Manager<R>>(manager: &M, items: &[&dyn IsMenuItem<R>]) -> crate::Result<Self>  // menu.rs:120
Menu::new<M: Manager<R>>(manager: &M) -> crate::Result<Self>                                        // menu.rs:93
Menu::set_as_app_menu(&self) -> crate::Result<Option<Menu<R>>>                                       // menu.rs:390
Menu::set_as_window_menu(&self, window: &Window<R>) -> crate::Result<Option<Menu<R>>>                // menu.rs:397
Menu::append_items(&self, items: &[&dyn IsMenuItem<R>]) -> crate::Result<()>                         // menu.rs:279

// 普通项 / 子菜单
MenuItem::with_id<M, I: Into<MenuId>, T: AsRef<str>, A: AsRef<str>>(
    manager: &M, id: I, text: T, enabled: bool, accelerator: Option<A>) -> crate::Result<Self>       // normal.rs:48
Submenu::with_items<M: Manager<R>, S: AsRef<str>>(
    manager: &M, text: S, enabled: bool, items: &[&dyn IsMenuItem<R>]) -> crate::Result<Self>         // submenu.rs:219

// 预定义项（macOS 会映射到原生 selector）
PredefinedMenuItem::copy<M: Manager<R>>(manager: &M, text: Option<&str>) -> crate::Result<Self>       // predefined.rs:28
PredefinedMenuItem::cut / paste / select_all / undo / redo / separator / quit / close_window / minimize … // predefined.rs:15..324
// 全部都是 (manager, text: Option<&str>)；about 多一个 AboutMetadata 参数（:277）

// 右键（上下文）菜单
Menu::popup<R: Runtime>(&self, window: crate::Window<R>) -> crate::Result<()>                         // menu/mod.rs:735
Menu::popup_at<R, P: Into<Position>>(&self, window: Window<R>, position: P) -> crate::Result<()>      // menu/mod.rs:740
WebviewWindow::popup_menu<M: ContextMenu>(&self, menu: &M) -> crate::Result<()>                       // webview_window.rs:1800（无平台门控）
WebviewWindow::popup_menu_at<M: ContextMenu, P: Into<Position>>(&self, menu: &M, position: P)          // webview_window.rs:1807
```

[MenuBuilder](https://docs.rs/tauri/2.12.1/tauri/menu/struct.MenuBuilder.html) 有链式糖（`.copy().paste().separator()…`），官方文档页示范过（C 级：[Window Menu](https://v2.tauri.app/learn/window-menu/)）。

### 5.2 右键菜单：**没有 Electron 那样的 `context-menu` 事件**

Electron 版靠 `win.webContents.on("context-menu", params => …)`（`desktop/main.js:521-545`）按「是否可编辑 / 是否日志页 / 有无选区」决定菜单项。**Tauri v2 core 没有对应事件**（A 级：`tauri-2.12.1/src/` 全树 grep `contextmenu` 只命中 muda 的 `show_context_menu_for_*` 内部调用；`RunEvent`/`WebviewEvent` 里没有 context-menu 变体）。

可落地的等价路径是：`initialization_script`（见 §7.3，**远端 URL 也会执行**）里挂 DOM `contextmenu` 监听 → `invoke("<你的命令>", { x, y, editable, selection, url })` → Rust 侧按 Electron 同款规则组装菜单 → `WebviewWindow::popup_menu_at(&menu, PhysicalPosition::new(x, y))`。
⚠️ 面板源码不能改（Global Constraints），所以这个监听必须在**壳注入的初始化脚本**里（而不是面板 JS 里）。**这条是"能落地"的推断，不是已核实的既有 API 组合**——建议 Phase 4 第一件事就是拿一个空壳验证 `popup_menu_at` 在 macOS/Windows/Linux 三个 webview 上的实际落点与关闭行为（标 **U**，见 §9-U5）。

### 5.3 Cmd/Ctrl+C/V/A：**那 80 行能不能不写？——分平台**

**macOS：不能无条件删，除非保留 Edit 菜单。** 这是有官方出处的：
- Tauri 维护者 FabianLars 在 [tauri#7428 "[bug] Custom window menu disables default shortcuts"](https://github.com/tauri-apps/tauri/issues/7428)（2023-07-16）里的原话：
  > "Basically on macOS these shortcuts like these **require the respective menu items** which is why tauri adds a default one on macOS."
- 同源 issue [#2397](https://github.com/tauri-apps/tauri/issues/2397)："Keyboard shortcuts on MacOS such as `cmd/a`, `cmd/c`, `cmd/v`, `cmd/x`, `cmd/z` … do not work in the Tauri window … You can fix this by adding a menu"。
- 佐证（A 级）：`Menu::default(app_handle)` 的实现里**专门有一个 Edit 子菜单**，内容是 `undo, redo, separator, cut, copy, paste, select_all`（`src/menu/menu.rs:203-216`）。即 Tauri 在 macOS 上**默认就给**这 7 项，删掉菜单就等于删掉快捷键。
- iRouter 现状恰恰是"删掉菜单"：`desktop/main.js:518-545` 的注释写明「面板 Edit 顶栏菜单被隐藏后 macOS 的选区复制无键等效可用」，smoke 断言（`main.js:1675-1694`）还专门检查 File/Edit **不可见**。

**Windows / Linux：Ctrl+C/V/A 是 webview 原生行为**，不需要应用菜单（WebView2 的浏览器加速键、WebKitGTK 的编辑快捷键默认生效）。**但我在本次核查中没找到官方文档明写这一点** → 标 **U**，建议 Phase 4 用一次手工点击验证（三平台各 30 秒）。

**结论（直接回答"这 80 行能否不写"）：**

| 方案 | macOS | Windows/Linux | 结论 |
| :-- | :-- | :-- | :-- |
| A. 保留可见的 Edit 子菜单（预定义项） | ✅ 原生可用 | ✅ 原生可用 | **可以不写这 80 行**，代价是 macOS 菜单栏多一个 Edit（违背现有"隐藏 File/Edit"的美术决定） |
| B. 完全不保留 Edit 菜单 | ❌ 失效 | ⚠️ 大概率仍可用（U） | **必须重写等价物**：Rust 侧没有 `before-input-event`，只能注入初始化脚本挂 `keydown` 并 `invoke` 回来执行编辑动作；而 **Tauri v2 没有 `webContents.copy()/paste()` 这类 API**（A 级：webview 模块无此方法），只能走 `document.execCommand` 或 `navigator.clipboard`，等于把 80 行变成更多行且更脆 |
| C. 隐藏但在菜单里保留这些项 | ? | ✅ | **U**：macOS 的 `NSMenuItem` 被隐藏后是否仍参与 key equivalent 匹配我没找到官方依据（muda 有 `set_visible` 类接口，但 `tauri::menu` 门面是否暴露、行为如何未核实） |

> **推荐给 Phase 4 的写法**：macOS 保留 Edit 子菜单但把它放在 App 菜单之后（菜单栏仍是 `iRouter / Edit / Window` 三项，与今天"只隐藏 File"接近），Windows/Linux 用 `Menu::default` 的等价裁剪版；**这 80 行 shim 在方案 A/C 下都不需要**。方案 B 不建议。
> 依据级别：macOS 的"需要菜单项"是 D 级维护者口径（issue 已 closed，标题即结论）+ A 级源码佐证（`Menu::default` 的 Edit 子菜单存在性）；其余为 U。

---

## 6. sidecar 与孤儿回收（最关键）

### 6.1 `bundle.externalBin` 命名规则（A 级）

`tauri-utils-2.10.1/src/config.rs:1683-1696`，`BundleConfig::external_bin` 的文档原文：

> A list of—either absolute or relative—paths to binaries to embed with your application.
> Note that Tauri will look for system-specific binaries following the pattern **"binary-name{-target-triple}{.system-extension}"**.
> E.g. for the external binary "my-binary", Tauri looks for:
> - `my-binary-x86_64-pc-windows-msvc.exe` for Windows
> - `my-binary-x86_64-apple-darwin` for macOS
> - `my-binary-x86_64-unknown-linux-gnu` for Linux

配置写 `"bundle": { "externalBin": ["binaries/bun"] }`（相对路径相对 `tauri.conf.json`，即 `src-tauri/binaries/`），磁盘上必须存在 `src-tauri/binaries/bun-aarch64-apple-darwin`、`bun-x86_64-pc-windows-msvc.exe`、`bun-x86_64-unknown-linux-gnu`。取本机三元组用 `rustc --print host-tuple`（Rust ≥1.84）。
C 级：[Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)、[Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)。
**打包期会把三元组后缀去掉**（上游 CHANGELOG 1.x 时代即有的行为：「The sidecar's target triple suffix is now removed at build time」）——所以运行时文件名就是 `bun`（Windows `bun.exe`）。

### 6.2 `Command::sidecar` 与子进程 API（A 级，`tauri-plugin-shell 2.4.0`）

```rust
// 入口（src/lib.rs:71）
pub trait ShellExt<R: Runtime>: Manager<R> { fn shell(&self) -> &Shell<R>; }  // 由 use tauri_plugin_shell::ShellExt 引入
impl Shell<R> {
  pub fn sidecar(&self, program: impl AsRef<Path>) -> Result<Command>;   // src/lib.rs:71 → Command::new_sidecar
}

// Command（src/process/mod.rs）
fn new_sidecar<S: AsRef<Path>>(program: S) -> crate::Result<Self>        // :165（私有，内部用 relative_command_path）
pub fn arg<S: AsRef<OsStr>>(self, arg: S) -> Self                        // :187
pub fn args<I, S: AsRef<OsStr>>(self, args: I) -> Self                   // :194
pub fn env_clear(self) -> Self                                           // :205
pub fn env<K, V>(self, k: K, v: V) -> Self                               // :212
pub fn envs<I, K, V>(self, envs: I) -> Self                              // :223
pub fn current_dir<P: AsRef<Path>>(self, dir: P) -> Self                  // :235
pub fn set_raw_out(self, raw_out: bool) -> Self                           // :241
pub fn spawn(self) -> crate::Result<(Receiver<CommandEvent>, CommandChild)>  // :305

pub struct CommandChild { .. }
pub fn write(&mut self, buf: &[u8]) -> crate::Result<()>                  // :72
pub fn kill(self) -> crate::Result<()>                                    // :78
pub fn pid(&self) -> u32                                                  // :84

pub enum CommandEvent { Stderr(Vec<u8>), Stdout(Vec<u8>), Error(String), Terminated(TerminatedPayload) }  // :43-54
pub struct TerminatedPayload { code: Option<i32>, signal: Option<i32> }   // Windows 上 signal 恒 None
```

路径解析（A 级 `relative_command_path`，`:120-153`）：`current_exe() 所在目录 / <program>`，Windows 自动补 `.exe`，非 Windows 自动去 `.exe`；**不做** PATH 查找、**不做** `externalBin` 前缀解析。
C 级关键句（[Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)，原文）：
> The `sidecar()` function expects **just the filename, NOT the whole path** configured in the `externalBin` array. … `externalBin: ["binaries/app", "my-sidecar", "../scripts/sidecar"]` → call `app.shell().sidecar("app")` / `"my-sidecar"` / `"sidecar"`.

> **对 Bun sidecar 的直接写法**：`externalBin: ["binaries/bun"]` + `app.shell().sidecar("bun")?.args(["./.next/standalone/custom-server.js","--port", &port]).current_dir(dir).env("DATA_DIR", …).env("HOSTNAME","127.0.0.1").spawn()`。

**❗ 三个必须知道的限制（都是 A 级源码事实，直接影响验收线）：**

1. **`plugin-shell` 不支持给子进程建独立进程组 / detached**。全树 grep `process_group|setsid|pre_exec|detach` → 只有 `creation_flags(CREATE_NO_WINDOW)`（Windows）。`spawn()` 走 `shared_child::SharedChild::spawn(&mut command)`，**直接子进程被杀 ≠ 孙进程被杀**。
2. **`CommandChild::kill()` 只杀直接子进程**（`shared_child` 的 `kill`），就是 SIGKILL/`TerminateProcess` 一个 pid，**不是进程树**。而 Bun 跑 Next standalone 会派生下一层（Electron 版注释明写：「Next 会派生 next-server 子进程」，`desktop/main.js:283`）。
3. **`plugin-shell` 没有退出钩子**。`tauri-plugin-shell 2.4.0` 源码里 grep 不到任何 `RunEvent::Exit` 处理器（v1 的 shell 才「Kill sidecar processes on app exit」，v2 的 plugin 没有）。**所以"应用退出时自动清理 sidecar"这件事在 Tauri v2 里不存在，必须自己写。**

### 6.3 三条死亡路径的真实覆盖情况（回答计划里点名要确认的两条）

**前提**：2.12.1 里能用的钩子只有 `RunEvent::Exit`（`app.run(|handle, event| …)` 回调，或 `Plugin::on_event`）与 `App::cleanup_before_exit()`（公开方法，A 级签名：`pub fn cleanup_before_exit(&self)`，`src/app.rs:1128`）。

| # | 死亡路径 | 会走 `RunEvent::Exit` / `cleanup_before_exit` 吗 | 证据 |
| :-- | :-- | :-- | :-- |
| 1 | 正常退出：`AppHandle::exit(code)` / 托盘"退出" | **会**。文档注释原文："Exits the app by triggering `RunEvent::ExitRequested` and `RunEvent::Exit`."；`request_exit` 失败时它自己兜底 `self.cleanup_before_exit(); std::process::exit(exit_code);` | A：`src/app.rs:578-590`；事件回路在 `RuntimeRunEvent::Exit` 分支调 `self.cleanup_before_exit()`（`src/app.rs:1452`） |
| 2 | 窗口关闭后托盘常驻 | 取决于你怎么实现 close 拦截：Tauri **没有** Electron 的 `close` 事件 `preventDefault`；窗口关闭即销毁，`RunEvent::ExitRequested` 只在最后一个窗口关闭时触发（除非你 `api.prevent_exit()`）。关窗→隐藏的做法是拦截 `RunEvent::WindowEvent{event: WindowEvent::CloseRequested{api,..}}` 并 `api.prevent_close()` + `window.hide()` | A：`WindowEvent`/`CloseRequested` 带 `ExitRequestApi`；`App::run` 回调签名 `FnMut(&AppHandle<R>, RunEvent)` |
| 3 | 更新器 / 安装器强杀 | **不会**（见下） | — |

**路径 3 的真相（两条计划里点名的路径都实测过）：**

- **`std::process::exit(0)`：不会跑任何钩子。** 这是 PR #14443 自己写在 `Plugin::cleanup_before_exit` 文档注释里的（A 级）："It **does not run** … when `std::process::exit` is called directly."
  对比：`AppHandle::exit(0)` **会**走事件回路 → `Exit` → cleanup。**所以更新器移植里"退出前调 `AppHandle::exit` 而不是 `std::process::exit`"是一条硬约束**（顺带也需要它来 `single_instance::destroy`）。
- **NSIS 安装器：不是 `TerminateProcess`，是 Windows Restart Manager 的强关。**
  上游 `crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh:24-49` 的 `CheckIfAppIsRunning` 宏：`RestartManager_StartSession` → `RmRegisterResources` → `RmGetList` → 若发现运行中，则（静默/被动模式下不询问）直接
  `System::Call 'RSTRTMGR::RmShutdown(p R0, i ${RmForceShutdown}, p 0) i .r0'`。
  `RmForceShutdown` 语义是"先请应用关闭，超时不配合就强杀"。**Tauri 的 Rust 侧清理钩子在这条路径上不可依赖**（进程可能被直接终止，且此时 `RmShutdown` 是另一个进程发起的）。
  来源：[utils.nsh](https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh)（D 级，dev 分支；2.12.1 时代的实现我按当前 dev 核对，**未按 tag 逐字节核对** → 该细节标 U，见 §9-U6）。
  ⚠️ 这条与迁移计划里"NSIS 安装器用 `TerminateProcess`"的表述**不一致**：实际是 Restart Manager 强关。结论（钩子不可依赖）相同，但 Phase 3 Step 3 的测试要怎么造这条路径，取决于 Restart Manager 行为，别照抄"TerminateProcess"去设计用例。

**结论（Phase 3 Step 3 的正确写法）：**

1. 不要找 `register_sidecar`——它不存在。**自己在壳里维护 PID**：spawn 后立刻把 `child.pid()` 写入 `<DATA_DIR>/.gateway.pid`（Electron 版同名文件，`desktop/main.js:197`），并单独记一份到 `userData`（Electron 版两个目录都写，`main.js:1590`）。
2. **三条退出路径各挂一次 kill**：`RunEvent::Exit`（覆盖 1）、托盘"退出"（同 1）；`RunEvent::WindowEvent::CloseRequested` 的 `prevent_close` 分支里**不 kill**（只是隐藏，网关要继续跑）。
3. **启动时回收**（覆盖 3，也是唯一覆盖强杀路径的办法）：拿到单实例锁之后、拉起网关之前，读 PID 文件 → 若进程存活 → `SIGTERM`（Unix，优先杀进程组 `kill(-pid)`；Windows 用 `taskkill /PID <pid> /T`）→ 等 1.5s → 仍存活则 `SIGKILL`/`taskkill /F /T` → 删 PID 文件。语义照抄 `desktop/main.js:226-285`。
4. **想让"进程树"一次杀干净**：`plugin-shell` 做不到（§6.2 限制 1/2），两条路——(a) 不用 `plugin-shell`，用 `std::process::Command` 自己 spawn，Unix 上 `CommandExt::process_group(0)` 建进程组、退出时 `kill(-pid, SIGTERM)`，Windows 上 `CREATE_NEW_PROCESS_GROUP` + `taskkill /T`；(b) 用 `plugin-shell` 但自己按 PID 递归枚举子进程（macOS `pgrep -P`、Linux `/proc/<pid>/task/*/children`、Windows `taskkill /T`）。**计划里的"升级 Tauri 版本"这条回退（风险表第 3 行）在 2.x 上无效，只能自研**（§1）。

---

## 7. 远程源 capability 与"给 webview 请求注入自定义 UA/头"

### 7.1 capability 里 `remote.urls` 的确切写法（A 级）

```rust
// tauri-utils 2.10.1/src/acl/capability.rs
pub struct Capability {
  pub identifier: String,                    // :110
  pub description: String,                   // :122
  pub remote: Option<CapabilityRemote>,      // :146
  pub local: bool,                           // 默认 true（:230 的 default_capability_local）
  pub windows: Vec<String>,                  // glob，:155
  pub webviews: Vec<String>,                 // glob，:166
  pub permissions: Vec<String>,
  pub platforms: Option<Vec<Target>>,
}
pub struct CapabilityRemote { pub urls: Vec<String> }   // :241-250，URLPattern 语法
```

配置形状（C 级 [Capabilities](https://v2.tauri.app/security/capabilities/) 的 "Remote API Access" 一节）：

```json
{
  "identifier": "remote-panel",
  "windows": ["main"],
  "remote": { "urls": ["http://127.0.0.1:20128"] },
  "permissions": ["core:event:allow-listen", "core:event:allow-unlisten", "<your-command>"]
}
```

匹配规则（A 级）：
- `RemoteUrlPattern::from_str`（`tauri-utils-2.10.1/src/acl/mod.rs:282-305`）用 [URLPattern](https://urlpattern.spec.whatwg.org/)，并且**把空的 search/hash 补成 `*`，把空或 `/` 的 pathname 补成 `*`**。所以 `"http://127.0.0.1:20128"` 本身就能匹配该 origin 的任意路径。
- 运行时判定用的**不是页面 URL 而是 IPC 请求的 `Origin` 头**：`src/ipc/protocol.rs:486-494` 取 `Origin` 头解析成 `Url`，`authority.rs:60-62` 做 `(Local, Local) | (Remote{url}, Remote{url_pattern: test})` 匹配。
- 远端必须显式给 `permissions`；`core:event:allow-listen` 这类 event 命令**走同一条 ACL**（event 命令是 `plugin:event|listen` 形式的 IPC 命令），所以只要在 remote capability 里列上就能用。核心权限标识实测存在：`core:event:allow-listen` / `core:event:allow-unlisten` / `core:event:allow-emit` / `core:event:allow-emit-to`（A 级：`tauri-2.12.1/permissions/event/autogenerated/reference.md`）。
- 支持**运行时追加 capability**：`Manager::add_capability(impl RuntimeCapability)`（`src/lib.rs:841`，feature **`dynamic-acl`**，**在 default features 里**）；构造器 `CapabilityBuilder::new(id).remote(url).window(label).permission(p)`（`src/ipc/capability_builder.rs:27-156`）。**这条对 iRouter 很关键**：网关端口是自适应的（`desktop/main.js:146-165`，20128 被占就顺延到 20129…），静态 JSON 写死端口会漏；用 `add_capability` 按实际端口在 setup 里动态加，或把 URLPattern 的 port 写成通配。
- 安全提示（C 级原文）："On Linux and Android, Tauri is unable to distinguish between requests from an embedded `<iframe>` and the window itself." —— 面板若可能被 iframe 嵌入，remote capability 的边界要更保守。

### 7.2 注入自定义 UA / 请求头：**UA 可以，任意请求头不行**

**能用的：**

```rust
// A 级：src/webview/webview_window.rs:1062（WebviewBuilder 同名 :1015）
pub fn user_agent(mut self, user_agent: &str) -> Self      // "Set the user agent for the webview"
```
UA 对整个 webview 生效（文档措辞是 "for the webview"，不是 per-request）。**这正是 ADR-0007 里"面板守卫改为每次启动随机 token，由壳生成并注入子进程环境与窗口 UA"的落地 API。** `custom-server.js:23-41` 的守卫从"认 `Electron/` 前缀"改成"认随机 token 的 UA 片段"即可，Electron 版固定头 `x-irouter-client: irouter-app` 可以退休。

**另一条可选的"带外通道"：cookie。**

```rust
// A 级：src/webview/mod.rs:2456 / 2465 / 2447 / 2418；WebviewWindow 同名转发
pub fn set_cookie(&self, cookie: Cookie<'_>) -> crate::Result<()>
pub fn delete_cookie(&self, cookie: Cookie<'_>) -> crate::Result<()>
pub fn cookies(&self) -> crate::Result<Vec<Cookie<'static>>>
pub fn cookies_for_url(&self, url: Url) -> crate::Result<Vec<Cookie<'static>>>
```
`Cookie` 由 `tauri::webview::cookie`（`cookie` crate 的 re-export）构造。文档标注 Stability 风险（"This dependency might receive updates in minor Tauri releases"），Windows 上**读** cookie 会在同步命令/事件处理器里死锁（wry#583，需 async 命令或另起线程）。**写 cookie 不做平台例外声明**，但"写入的 cookie 是否会被随后发起的首个文档导航带上"我没找到官方说明 → **U**（§9-U3）。

**不能用的（重要，避免实现期白试）：**

| 看起来可行 | 为什么不行（A 级） |
| :-- | :-- |
| `WebviewWindowBuilder::on_web_resource_request` | 文档原文："Defines a closure to be executed when the webview makes an HTTP request for a web resource, **allowing you to modify the response**. Currently **only implemented for the `tauri` URI protocol**. NOTE: Currently this is **not** executed when using external URLs such as a development server." → 我们加载的是 `http://127.0.0.1:20128`，**收不到**，而且还只能改响应不能改请求。 |
| `additional_browser_args("--user-agent=…")` | Windows only（"**macOS / Linux / Android / iOS: Unsupported**"），且必须同时换 `data_directory`；只能改 Chromium 启动参数，不能加任意请求头。 |
| 找 `WebviewBuilder::header(...)` 之类 | **不存在**。全树只有 IPC 的 `InvokeRequest.headers`（`src/webview/mod.rs:147`）与 `on_web_resource_request` 的响应头，没有"给 webview 出站请求加头"的 API。 |
| 初始化脚本 patch `fetch`/`XMLHttpRequest`/`EventSource` | **可行但不推荐**：只覆盖 JS 发起的请求，覆盖不到文档导航与 `<img>/<script>` 等子资源；且面板是别人的代码，patch 顺序脆弱。 |

**给 Phase 3 Step 4 的建议（按可靠性排序）**：① 窗口 UA（官方 API、跨平台、覆盖所有请求）→ ② 子进程环境变量（网关自己校验，不经 webview）→ ③ cookie（**U**，需实测）→ ④ init 脚本 patch（最后手段）。

### 7.3 remote URL 下 IPC 是否可用（事件桥的共用事实）

- **`window.__TAURI_INTERNALS__` 会注入到远端页面。** A 级：`prepare_pending_webview`（`src/manager/webview.rs:120-210`）**无条件**给每个 webview 推一组初始化脚本，第一个就是 `Object.defineProperty(window,'isTauri',{value:true})` + 兜底 `__TAURI_INTERNALS__`，与 URL 是本地还是远端无关。
- **能不能真的 invoke，取决于 ACL**：远端 origin 不在任何 `remote.urls` 里 → 运行时被 `authority` 拒（`resolve_access`），错误信息里会打印 `URL: <pattern>`。所以在 remote capability 里**逐条列出**需要的权限（`core:event:allow-listen`、你自己的命令）是必须动作。
- **事件名合法字符集**（A 级，`src/event/event_name.rs:8-13`）：`is_alphanumeric() || '-' || '/' || ':' || '_'`。→ `shell:update-progress`、`irouter:open-settings` 都合法；含空格/`.`/`+` 会返回 `Error::IllegalEventName`。
- **`Emitter` trait**（A 级，`src/lib.rs:961-1017`；B 级 [trait.Emitter](https://docs.rs/tauri/2.12.1/tauri/trait.Emitter.html)）：

```rust
use tauri::Emitter;
fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<()>
fn emit_str(&self, event: &str, payload: String) -> Result<()>
fn emit_to<I: Into<EventTarget>, S: Serialize + Clone>(&self, target: I, event: &str, payload: S) -> Result<()>
```
  `AppHandle` / `Window` / `Webview` / `WebviewWindow` **都实现了 `Emitter`**（`impl … Emitter<R> for WebviewWindow<R> {}`，见 `src/webview/webview_window.rs:2836`、`src/window/mod.rs:2550`、`src/webview/mod.rs:2565`）。只发给某一个窗口用 `emit_to(EventTarget::webview_window("main"), …)` 或 `window.emit(…)`；`AppHandle::emit` 是广播给所有 webview。
- **命令名规则**（A 级，`tauri-macros 2.7.1/src/command/wrapper.rs:288-296, 495-515`）：默认 `RenamePolicy::Keep` → 命令名 = **Rust 函数名原样**（`shell_check_update` 就是 `shell_check_update`，**不是** camelCase）；想改只能 `#[tauri::command(rename = "…")]`。参数名默认 `ArgumentCase::Camel`（`key.to_lower_camel_case()`），即 `invoke("x", { force })` 对应 `fn x(force: bool)`；要 snake_case 得写 `#[tauri::command(rename_all = "snake_case")]`（只接受这两个值，见 `:62-77`）。自定义命令**默认对所有窗口开放**，要用 `tauri_build::AppManifest::commands(&[…])` 收紧（C 级：[Capabilities](https://v2.tauri.app/security/capabilities/) 明文）。
- `Option<String>` / `Vec<u8>` 作为 payload 都满足 `Serialize + Clone`；但 `Vec<u8>` 在 JSON 里是**数字数组**（不是 base64），大二进制别走事件，用 `tauri::ipc::Channel`。
- **初始化脚本执行时机**（A 级文档原文，`src/webview/webview_window.rs:966-990`）："Adds the provided JavaScript to a list of scripts that should be run **after the global object has been created, but before the HTML document has been parsed and before any other script included by the HTML document is run**."；平台差异只有 **Android** 一条（远端 URL 退化为 `onPageStarted`，不保证早于其他脚本）。**macOS/Windows/Linux 没有此类降级说明**；但"init 脚本 vs `__TAURI_INTERNALS__` 注入"的先后顺序**没有文档承诺** → **U**（§9-U10）。稳妥写法：脚本里不要顶层调 `listen()`，而是 `window.addEventListener('DOMContentLoaded', …)` / 轮询 `window.__TAURI_INTERNALS__` 就绪后再 `invoke`。

---

## 8. 窗口就绪后再 show（复刻 `main.js:1602-1620` 的语义）

Tauri v2 **没有** Electron 的 `ready-to-show` 事件。组合拳如下（全部 A 级）：

```rust
WebviewWindowBuilder::new(app, "main", WebviewUrl::External("http://127.0.0.1:20128".parse()?))
    .visible(false)                       // webview_window.rs:934
    .title("")                            // :908（Electron 版把标题固定为空，:591-594）
    .user_agent(&ua_with_token)           // :1062
    .on_page_load(|window, payload| {     // :421
        match payload.event() { PageLoadEvent::Started => …, PageLoadEvent::Finished => … }
        // payload.url() -> &Url，payload.event() -> PageLoadEvent（webview/mod.rs:111-126）
    })
    .build()?;

// 两个可用的 show 时机（二选一或都用）：
// (a) 网关 HTTP 就绪后：自己在 setup 里轮询 GET http://127.0.0.1:<port>/login 期望 200
//     （照抄 waitHttpReady，main.js:167-186，含"TCP 通≠HTTP 通"的注释），成功后再 window.show()
// (b) 页面加载完成：on_page_load 收到 PageLoadEvent::Finished 后 window.show()
window.show()?;      // webview_window.rs:2334
window.set_focus()?; // :2387
window.unminimize()?;// :2103
window.is_visible()?;// :1919
```

要点：
- **先建隐藏窗口再显示**是唯一稳妥的顺序：`visible(false)` 建窗 → 探测 → `show()`。窗口在探测期间不存在白屏。
- **`WebviewUrl::External(Url)` 只接受 http/https**（A 级：`tauri-utils-2.10.1/src/config.rs:77-79` "An external URL. Must use either the `http` or `https` schemes."）。
- 网关启动失败的兜底页（Electron 版 `showGatewayError`，`main.js:880-898` 用 `loadURL(data:text/html,…)`）：Tauri 下用 `WebviewWindow::navigate(url)` 或自建 `tauri://` 协议页；`data:` URL 能否经 `WebviewUrl::External` 建窗**未验证** → 细节 U。
- macOS 上还有一个"App 级显示"的开关，Electron 版 `showDock()/hideDock()`（`main.js:414-422`，服务于 `closeAction: tray` 一档）在 Tauri 的对应物是：
  `App::set_activation_policy(ActivationPolicy::Regular | Accessory)`（`src/app.rs:658`）+ macOS-only 的 `App::show()/hide()`（`src/app.rs:1106/1117`）。**语义等价、API 名不同**，别去找 `dock.show()`。

---

## 9. unverified 清单（照抄前必须先验证）

| # | 条目 | 为什么标 U | 建议的验证方式 |
| :-- | :-- | :-- | :-- |
| U1 | Windows/Linux 上 Ctrl+C/V/X/A 在系统 webview 里**无需菜单**即原生可用 | 只有 macOS 有官方口径（issue #7428/#2397）；Windows/Linux 没找到官方声明 | Phase 4 各平台手工：输入框里按一遍 4 个组合键 |
| U2 | macOS 上**隐藏**（而非移除）Edit 菜单项后，key equivalent 是否仍生效 | 未找到 muda/tauri 文档依据 | 若采用"方案 C"必须先跑一次 30 秒试 |
| U3 | `set_cookie` 写入的 cookie 是否会被**随后首个文档导航**带上 | 文档只说 "Set a cookie for the webview"，未承诺导航时序 | 建窗→set_cookie→show，抓网关 access log 看 Cookie 头 |
| U4 | `WebviewWindowBuilder::user_agent` 在 macOS/WKWebView 上是否覆盖 **fetch/XHR/SSE 子资源请求**（不只是文档导航） | 文档只写 "for the webview" | 网关打一条日志，看面板轮询请求的 UA 是否带 token |
| U5 | Tauri v2 无 context-menu 事件这一点已核（A）；但用 init 脚本 + `popup_menu_at` 复刻"仅可编辑/日志页弹菜单"的**实际落点/关闭行为**未实测 | 组合行为未实测 | 空壳跑三平台，观察菜单位置与消失时机 |
| U6 | NSIS 安装路径的 RestartManager 行为按 **dev 分支**核对，未按 `tauri-v2.12.1` tag 逐字节比对 | 该文件与版本相关，且我只取了 dev 分支 | `curl https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh` 再比一次 |
| U7 | "Bun 跑 Next standalone 会派生孙进程"（决定要不要杀进程组） | 迁移计划 Phase 0 的"Z1 SIGTERM 后端口释放无残留"暗示没有，但那是**正常**退出；强杀路径未验证 | Phase 3 Step 3 的"更新安装器强杀"用例里 `ps` 数一次进程树 |
| U8 | 2.12.1 之后是否**已发布**含该 hook 的 2.x（例如 2.13.0） | crates.io 索引此刻最新稳定版是 2.12.1；未来可能变 | 动手时再查一次 `https://index.crates.io/ta/ur/tauri` |
| U9 | 托盘图标是否需要为 macOS 另备 @2x 位图才不糊 | 无官方文档表述 | 目视 |
| U10 | `initialization_script` 与 `__TAURI_INTERNALS__` 注入的**先后顺序**（远端 URL 下能否在脚本顶层安全 `invoke`） | 文档只承诺"晚于 global object 创建、早于文档解析"，没说与 internals 的次序 | 空壳里在脚本顶层 `console.log(typeof window.__TAURI_INTERNALS__)` 看一眼 |

---

## 10. 最可能让实现翻车的点（按风险排序）

1. **"2.12.1 有 sidecar 注册表"是错的，而且它把 Phase 3 的核心工作从"调 API"变成"自研"**（§1）。如果按计划书写代码，会卡在"找不到 `register_sidecar`"；如果换成 3.0.0-alpha，则命中"三平台稳定"的验收线风险。**正确动作：接受自研 PID 回收，把 ADR/计划里那句关于 2.12.1 的描述改掉。**
2. **`plugin-shell` 的 sidecar 既没有进程组也不杀进程树**（§6.2），而 `CommandChild::kill()` 只杀一层。Bun→Next 的下一层是真实存在的（Electron 版为此专门 `detached: true` 走进程组）。**若 Phase 3 照抄 `plugin-shell` + `child.kill()`，验收时"杀进程不留孤儿"会以偶发形式挂掉**（端口被占、数据目录被锁）。
3. **强杀路径只有"启动时回收"能覆盖**（§6.3）：NSIS 走 Restart Manager 强关、`std::process::exit` 明确不跑钩子。所以 PID 文件 + 启动回收是**必做项**，不是可选加固。
4. **macOS 的 Cmd+C/V/A 与"隐藏 Edit 菜单"不可兼得**（§5.3）：那 80 行不能简单删掉，是一个需要产品决策的取舍点（菜单栏多一个 Edit vs. 重写一套更脆的注入实现）。

---

## 附录 A：本次核查的机器可复核线索

- 证据来自本机 `/tmp/tcrates/` 下的 crate 解包（`tauri-2.12.1`、`tauri-3.0.0-alpha.4`、`tauri-utils-2.10.1`、`tauri-macros-2.7.1`、`tauri-plugin-shell-2.4.0`、`tauri-plugin-single-instance-2.5.2`、`tauri-plugin-autostart-2.7.0`）。
- crates.io sparse index 快照：`https://index.crates.io/ta/ur/tauri`（2.12.1 的 `cksum` 与下载文件 sha256 一致：`ed99ee96…f2ace9`）。
- 所有引用的 docs.rs 链接在 2026-10-07 均返回 HTTP 200；其中 `Plugin` trait 页 2.12.1 **无** `cleanup_before_exit`、3.0.0-alpha.4 **有**，两页均为实测 grep 结果。
