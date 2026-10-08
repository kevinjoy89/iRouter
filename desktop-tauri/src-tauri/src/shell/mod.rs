//! 壳功能：托盘、开机自启、单实例、应用菜单、右键菜单、窗口关闭行为、设置模态 IPC。
//!
//! **owner: shell 任务**。本文件与 `src/shell/**` 之外的任何文件都不要改——
//! `main.rs` / `gateway.rs` / `guard.rs` / `settings.rs` 归 Lead，
//! `tauri.conf.json` 与 `capabilities/**` 归 packaging。
//!
//! 模块划分：
//!   - `tray`     托盘图标 + 托盘菜单 + 点击/双击（`desktop/main.js:1483-1508`）
//!   - `menus`    应用菜单（macOS 含 Edit）+ 右键菜单 + 全局菜单事件（`main.js:1321-1425, 521-545`）
//!   - `commands` IPC：设置读写 + 右键菜单命令（`main.js:679-698, preload.js:10-25`）
//!   - `window`   显隐 / Dock / 退出（`main.js:413-430, 2148-2154`）
//!   - `i18n`     菜单文案（`main.js:900-1313`）
//!   - `shim.js`  注入面板的 `window.irouterShell` 桥 + 右键菜单触发脚本
//!
//! 三条已核实的硬事实（别按直觉写，出处见 `docs/plans/2026-10-07-tauri-shell-api-notes.md`）：
//!   1. **macOS 上 Cmd/Ctrl+C/V/A 需要 Edit 菜单项**才生效——正确做法是**加菜单**，
//!      不是重写 Electron 那 80 行 `before-input-event` shim（`main.js:512-560`）。
//!   2. **Tauri v2 没有 Electron 那样的 context-menu 事件**——右键菜单用
//!      `WebviewWindow::popup_menu_at`，触发靠壳注入的 init 脚本挂 DOM `contextmenu` 再 invoke 回来。
//!   3. **`TrayIconEvent` 的 `DoubleClick` 是 Windows only**（macOS/Linux 用两次 Click 判时差）。
//!
//! 关闭行为对齐 `desktop/main.js:600-614` 的三档 closeAction；Tauri **没有** Electron 的
//! `close` 事件 `preventDefault`，拦截靠 `RunEvent::WindowEvent { event: WindowEvent::CloseRequested { api, .. } }`
//! + `api.prevent_close()` + `window.hide()`。
//!
//! ## 为什么用"动态插件"承载 RunEvent/PageLoad，而不是改 main.rs
//!
//! `RunEvent` 的消费点在 `main.rs` 的 `.run(...)` 闭包里（归 Lead），本模块不能改它。
//! `AppHandle::plugin`（`tauri-2.12.1/src/app.rs:528`）允许在 setup 里动态注册插件，
//! 而 `Plugin::on_event`（`src/plugin.rs:105`）能收到**全部** `RunEvent`
//! （`src/manager/webview.rs` 的插件派发与本模块的 `on_run_event`）。
//! 命令不走插件（插件命令需要 `plugin:` 前缀 + 插件自己的 ACL 清单），走 `invoke_handler()`，
//! 由 main.rs 挂到 Builder 上。

// 命令模块**公开**：main.rs 要把 shell 与 updater 的命令合并进单一的
// `generate_handler!`（`Builder::invoke_handler` 是覆盖式，`tauri-2.12.1/src/app.rs:1727`），
// 而命令必须按**真实模块路径**引用——`#[tauri::command]` 的伴生宏 `__cmd__<name>!` 是
// `#[macro_export]`，`pub use` 转出后按路径找不到（实测：`cannot determine resolution for the import`）。
pub mod commands;
mod dialogs;
mod i18n;
mod menus;
mod selftest;
mod signals;
mod tray;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent, Wry};

// `open_settings` 是给自动化（smoke / Phase 6 端到端）用的公开入口，
// 当前 crate 内没有调用者，故允许 unused。
#[allow(unused_imports)]
pub use commands::open_settings;
pub use window::{opened_at_login, AUTOSTART_ARG};

/// 主窗口 label。托盘 id 也在这里定义，方便 `tray_by_id` 取回。
pub const MAIN_WINDOW: &str = "main";
pub const TRAY_ID: &str = "irouter-tray";

/// 壳层运行时状态。
pub struct ShellState {
    /// 是否正在退出（对齐 `main.js:41` 的 `quitting`）：为真时关窗不再 prevent。
    quitting: AtomicBool,
    /// 托盘左键上次点击时刻（macOS/Linux 的双击判定用；Windows 走原生 DoubleClick）。
    pub last_tray_left_click: Mutex<Option<Instant>>,
    /// webview 缩放倍率（webview 没有 zoom getter，只能自己记账）。
    pub zoom: Mutex<f64>,
    /// 面板尚未加载完时暂存的 `shell:open-settings` 载荷（对齐 Electron 的
    /// `webContents.once("did-finish-load", …)`，`main.js:662-668`）。
    pub pending_open: Mutex<Option<Value>>,
    /// 菜单语言。启动时按系统 locale 判定，之后不再变（没有调用者给它改——面板侧
    /// 根本没有发射 `__IROUTER_LOCALE__` 的代码，见 `i18n` 模块头）。
    locale: Mutex<i18n::Locale>,
    /// 最近一次「菜单触发检查更新」的时刻。`Some` = 有一次结果在等 → 收到
    /// `shell:update-available` 时弹结果对话框（见 `dialogs` 模块头）。
    pub menu_check_at: Mutex<Option<Instant>>,
    /// `shell:update-available` 的 Rust 侧监听是否已注册（懒注册 + 幂等，见 `dialogs`）。
    pub result_listener_registered: AtomicBool,
}

impl ShellState {
    fn new() -> Self {
        Self {
            quitting: AtomicBool::new(false),
            last_tray_left_click: Mutex::new(None),
            zoom: Mutex::new(1.0),
            pending_open: Mutex::new(None),
            locale: Mutex::new(i18n::system_locale()),
            menu_check_at: Mutex::new(None),
            result_listener_registered: AtomicBool::new(false),
        }
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn set_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }
}

/// 关窗行为三档，取值来自 `crate::settings`（唯一实现，对齐 `desktop/settings.js:24-31`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseAction {
    Quit,
    Dock,
    Tray,
}

impl CloseAction {
    fn parse(raw: &str) -> Self {
        match raw {
            "quit" => Self::Quit,
            "tray" => Self::Tray,
            _ => Self::Dock, // 默认 dock（`settings.js:29` DEFAULT_CLOSE_ACTION）
        }
    }
}

/// 由 `main.rs` 在 setup 阶段调用。**不得阻塞启动**：这里只建托盘/菜单（内存操作，
/// 主线程内联执行，不走 `run_on_main_thread` 的异步往返）与注册事件钩子，没有任何网络/文件 I/O。
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    // 把检测到的语言打出来：菜单文案只在启动时定一次，出问题时这行是唯一线索。
    // （曾实测：只读 LANG 环境变量会在 macOS 上把 zh_CN 误判成英文，见 i18n.rs::system_locale）
    let detected = locale(app);
    log::info!("菜单语言检测：{:?}（系统 locale）", detected);
    app.manage(ShellState::new());

    // 1) 先注册插件：它承载 RunEvent（关窗拦截）与 page load（补发打开设置）钩子，
    //    越早挂上越不容易漏事件。
    app.plugin(shell_plugin())?;

    // 2) 全局菜单事件（应用菜单 + 托盘菜单都进这里）与托盘图标事件。
    app.on_menu_event(menus::on_menu_event);
    app.on_tray_icon_event(tray::on_tray_icon_event);

    // 2.5) 信号钩子：越早装越好——否则"启动到装钩子之间被 kill"仍会留孤儿。
    //      （对齐 `desktop/main.js:2156-2157` 的 `process.on("SIGINT"/"SIGTERM", quit)`）
    signals::install(app);

    // 3) 托盘与应用菜单。
    tray::create(app)?;
    menus::install_app_menu(app)?;

    // 4) 开机自启：复刻 Electron 的 openAsHidden（只进托盘、不显窗口）。
    //    判定与 show 的先后由 main.rs 的就绪线程负责（`main.rs:114` 调 `opened_at_login()`）。
    if opened_at_login() {
        log::info!("检测到 {AUTOSTART_ARG}：本次启动只驻留托盘，不显示窗口");
    }

    log::info!("shell 模块已装载（托盘/自启/单实例/菜单/关闭行为/设置 IPC）");
    Ok(())
}

/// 注入面板的初始化脚本（`window.irouterShell` 桥 + 右键菜单触发 + 打开设置事件订阅）。
///
/// 由 `main.rs` 在建窗处挂：`.initialization_script(shell::shim_script())`。
/// **必须与 updater 的注入脚本合并**（同一个 `window.irouterShell` 对象，见 Lead 的接口约定）：
/// 本脚本只对已有对象做 `Object.assign`，且仅在桥不存在时才挂上合并结果，绝不整体覆盖。
pub fn shim_script() -> String {
    include_str!("shim.js").replace("__IROUTER_PLATFORM__", std::env::consts::OS)
}

/// 单实例插件回调：第二次启动时聚焦已有窗口。
///
/// 现 Electron 版只看 `second-instance` 不看 argv（`desktop/main.js:2140-2142`）；
/// Tauri 的 `init(|app, args: Vec<String>, cwd: String|)` **直接给 argv**，比现状更强。
/// 本实现把 argv 记进日志并把它当作将来「深链 / CLI 开关」的落点（现在只做聚焦）。
pub fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    log::info!("二次启动：args={args:?} cwd={cwd}");
    // 落点说明：`args` 里将来可出现 `irouter://…` 深链或 `--smoke` 之类的开关；
    // 现在保持与 Electron 现状一致的行为——唤出并聚焦已有窗口。
    window::show_window(app);
}

/// 当前菜单语言（启动时定，见 `ShellState::locale`）。
pub fn locale(app: &AppHandle) -> i18n::Locale {
    app.try_state::<ShellState>()
        .and_then(|state| state.locale.lock().ok().map(|l| *l))
        .unwrap_or_else(i18n::system_locale)
}

/// 动态插件：RunEvent + page load。命令不在这里（见 `invoke_handler`）。
fn shell_plugin() -> TauriPlugin<Wry> {
    PluginBuilder::new("irouter-shell")
        .on_event(|app, event| on_run_event(app, event))
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                commands::flush_pending_open_settings(webview.app_handle(), webview.label());
                // 自动化自检接缝：网关就绪（面板页加载完成）后触发场景。
                // release 构建下这是空函数（模块整体被 `#[cfg(debug_assertions)]` 门控）。
                selftest::on_panel_ready(webview.app_handle(), webview.label());
            }
        })
        .build()
}

/// RunEvent 总入口。
fn on_run_event(app: &AppHandle, event: &RunEvent) {
    match event {
        // 关窗拦截。Tauri 没有 Electron 的 `close` 事件 preventDefault（API notes §6.3 路径 2）。
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if label == MAIN_WINDOW {
                on_close_requested(app, api);
            }
        }
        // 用户主动退出（Cmd+Q / 系统终止）：对齐 Electron `before-quit`（`main.js:2148-2154`）——
        // 先置 quitting 让后续关窗不再拦，再回收 sidecar。
        // **不 prevent_exit**：Electron 的 Cmd+Q 也是真退出。
        RunEvent::ExitRequested { code: None, .. } => {
            log::info!("收到退出请求（code=None），执行收尾");
            if let Some(state) = app.try_state::<ShellState>() {
                state.set_quitting();
            }
            if let Some(gw) = app.try_state::<crate::gateway::Gateway>() {
                gw.kill();
            }
        }
        // Electron `app.on("activate", showWindow)`（`main.js:2137`）的 macOS 等价物。
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            log::info!("macOS Reopen → 唤出窗口");
            window::show_window(app);
        }
        _ => {}
    }
}

/// 关窗行为：对齐 `desktop/main.js:600-614`。
///
/// | Electron（`main.js`） | Tauri（本函数） |
/// | :-- | :-- |
/// | `win.on("close", e => …)` | `RunEvent::WindowEvent::CloseRequested` |
/// | `if (quitting) return;` | `if state.is_quitting() { return; }`（不 prevent，窗口真关） |
/// | `e.preventDefault()` | `api.prevent_close()` |
/// | `action === "quit"` → `quit()` | `CloseAction::Quit` → `window::quit()` |
/// | `win.hide()` | `window::hide_main_window()` |
/// | `action === "tray"` → `hideDock()` | `CloseAction::Tray` → `hide_dock()` |
/// | `SMOKE` 恒走隐藏档（`:603-606`） | 同样保留 `--smoke` 接缝（`smoke_mode()`） |
fn on_close_requested(app: &AppHandle, api: &tauri::CloseRequestApi) {
    let quitting = app
        .try_state::<ShellState>()
        .map(|s| s.is_quitting())
        .unwrap_or(false);
    if quitting {
        // 对齐 `main.js:601`：退出流程中的关窗不再阻拦（否则 Cmd+Q 会被自己挡住）。
        return;
    }

    api.prevent_close();

    // 冒烟测试恒走隐藏路径：否则 closeAction=quit 会让 smoke 提前退出、断言拿不到结果
    // （`main.js:603-606`，同一处接缝）。
    let action = if smoke_mode() {
        log::info!("--smoke：关窗恒走隐藏路径");
        CloseAction::Dock
    } else {
        current_close_action(app)
    };

    match action {
        CloseAction::Quit => {
            log::info!("closeAction=quit：关窗即退出");
            window::quit(app);
        }
        CloseAction::Dock => {
            log::info!("closeAction=dock：隐藏到托盘（保留 Dock 图块）");
            window::hide_main_window(app);
        }
        CloseAction::Tray => {
            log::info!("closeAction=tray：隐藏到托盘并隐藏 Dock 图块");
            window::hide_main_window(app);
            window::hide_dock(app);
        }
    }
}

/// 读当前 closeAction。文件缺失/损坏一律回落默认 `dock`（`crate::settings::read` 已保证）。
fn current_close_action(app: &AppHandle) -> CloseAction {
    match crate::gateway::resolve_data_dir(app) {
        Ok(data_dir) => CloseAction::parse(&crate::settings::read(&data_dir).close_action),
        Err(e) => {
            log::warn!("拿不到数据目录，closeAction 回落默认 dock：{e}");
            CloseAction::Dock
        }
    }
}

/// Electron 的 `--smoke` 自动化接缝（`main.js:28`）：Phase 4 出口条件要求"自动化接缝可用"。
pub fn smoke_mode() -> bool {
    std::env::args().any(|a| a == "--smoke")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_action_parsing_matches_settings_js() {
        assert_eq!(CloseAction::parse("quit"), CloseAction::Quit);
        assert_eq!(CloseAction::parse("tray"), CloseAction::Tray);
        assert_eq!(CloseAction::parse("dock"), CloseAction::Dock);
        // 非法值一律回落默认 dock（settings.js:48-50 的 normalize）
        assert_eq!(CloseAction::parse("nonsense"), CloseAction::Dock);
        assert_eq!(CloseAction::parse(""), CloseAction::Dock);
    }

    #[test]
    fn shim_script_is_self_contained_and_merges() {
        let js = shim_script();
        // 绝不整体覆盖 window.irouterShell（Lead 的接口约定：与 updater 脚本合并）：
        // 不允许用对象字面量替换，只允许在"此前不存在"时挂上合并后的对象。
        assert!(
            !js.contains("window.irouterShell = {"),
            "shim 不得用对象字面量整体覆盖 irouterShell"
        );
        assert!(js.contains("Object.assign(existing"), "必须先合并已有对象");
        assert!(js.contains("if (!window.irouterShell)"), "只应在桥不存在时才挂");
        assert!(js.contains("shell_get_settings"));
        assert!(js.contains("shell_set_settings"));
        assert!(js.contains("shell_context_menu"));
        assert!(!js.contains("__IROUTER_PLATFORM__"), "平台占位符必须已被替换");
    }

    #[test]
    fn autostart_flag_is_the_one_registered_in_main_rs() {
        // main.rs 注册 autostart 插件时用的就是这个字面量，改一处必须改两处
        assert_eq!(AUTOSTART_ARG, "--from-autostart");
    }
}
