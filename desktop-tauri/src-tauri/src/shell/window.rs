//! 主窗口显隐、macOS Dock 图块、退出路径。
//!
//! 对照 `desktop/main.js`：
//!   - `showWindow()`      `:421-430`
//!   - `showDock()`        `:413-415`
//!   - `hideDock()`        `:417-419`
//!   - `quit()`（退出）    见 `main.js` 的 quit 定义与 `:2148-2154` 的 before-quit

use tauri::{AppHandle, Manager};

use super::ShellState;

/// 主窗口 label（`main.rs` 建窗时用的就是 "main"）。
pub const MAIN_WINDOW: &str = "main";

pub fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// 对齐 `desktop/main.js:421-430` 的 `showWindow()`：
/// 先恢复 Dock（`showDock()`），再 `restore → show → focus`。
pub fn show_window(app: &AppHandle) {
    show_dock(app);
    let Some(window) = main_window(app) else {
        // 窗口还没建出来（setup 阶段被托盘/菜单事件提前调用）或已被销毁。
        // Electron 版这里是 createWindow()；Tauri 版建窗归 main.rs，壳层只记一条日志。
        log::warn!("show_window：主窗口不存在，跳过（建窗归 main.rs）");
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 关窗行为里的"隐藏到托盘"：只隐藏窗口，不销毁（网关继续跑）。
pub fn hide_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        if let Err(e) = window.hide() {
            log::error!("隐藏主窗口失败：{e}");
        }
    }
}

/// 对齐 `desktop/main.js:413-415` 的 `showDock()`。
///
/// Electron 的 `app.dock.show()` 在 Tauri 里的对应物是 **激活策略**（非同名 API，别找 `dock()`）：
/// `ActivationPolicy::Regular`（常规应用，有 Dock 图块）↔ `Accessory`（无 Dock 图块、
/// 不进 Cmd+Tab）。见 `docs/plans/2026-10-07-tauri-shell-api-notes.md` §8 末段，
/// 签名 `AppHandle::set_activation_policy`（`tauri-2.12.1/src/app.rs:658`）。
#[cfg(target_os = "macos")]
pub fn show_dock(app: &AppHandle) {
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        log::warn!("恢复 Dock 图块失败：{e}");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn show_dock(_app: &AppHandle) {
    // 非 macOS 平台 `app.dock` 不存在；Electron 版这两个函数也是空操作（`main.js:414,418`）。
}

/// 对齐 `desktop/main.js:417-419` 的 `hideDock()`（closeAction == "tray" 那一档）。
#[cfg(target_os = "macos")]
pub fn hide_dock(app: &AppHandle) {
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
        log::warn!("隐藏 Dock 图块失败：{e}");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn hide_dock(_app: &AppHandle) {}

/// 退出应用：对齐 `main.js` 的 `quit()` 与 `before-quit`（`:2148-2154`）的合成语义——
/// 先置 `quitting` 标志（让关窗拦截不再 prevent）、回收 sidecar，再走 `AppHandle::exit`。
///
/// **必须用 `AppHandle::exit` 而不是 `std::process::exit`**：后者不跑任何钩子
/// （`single_instance::destroy` 与 main.rs 的 `RunEvent::Exit` 回收都会被跳过，
/// 见 `docs/plans/2026-10-07-tauri-shell-api-notes.md` §6.3 路径 3）。
pub fn quit(app: &AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        state.set_quitting();
    }
    if let Some(gw) = app.try_state::<crate::gateway::Gateway>() {
        gw.kill();
    }
    log::info!("退出应用（closeAction=quit 或菜单/托盘「退出」）");
    app.exit(0);
}

/// `--from-autostart`：复刻 Electron `openAsHidden` 的标记参数法
/// （`desktop/main.js:2120-2125` 的 `wasOpenedAtLogin` 分支；API notes §3）。
pub const AUTOSTART_ARG: &str = "--from-autostart";

/// 本次启动是否来自登录项（应只驻留托盘、不显窗口）。
///
/// 调用点：`main.rs:114` 的就绪线程在 `window.show()` 之前问这一句
/// （Lead 已按本模块的请求接上；原先这里有一段 20s 轮询兜底，钩子接上后**已删除**，
/// 因为轮询只会在用户主动从托盘唤出窗口时把它again 隐藏掉）。
pub fn opened_at_login() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}
