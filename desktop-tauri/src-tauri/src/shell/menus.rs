//! 应用菜单（macOS）与右键上下文菜单。
//!
//! ## 那 80 行 `before-input-event` shim 为什么不重写
//!
//! macOS 上 Cmd+C/V/X/A 这些「编辑」加速键**必须由对应菜单项承载**才生效
//! （Tauri 维护者口径 + `Menu::default` 里专门有一个 Edit 子菜单，见
//! `docs/plans/2026-10-07-tauri-shell-api-notes.md` §5.3）。Electron 版恰恰是
//! 「隐藏 Edit 菜单 + 手写 80 行 shim」（`desktop/main.js:512-560`）来兜的。
//! Tauri 没有 `before-input-event`，正确做法是**把 Edit 菜单加回来**（预定义项映射到
//! 原生 selector），而不是用注入脚本重写一套更脆的等价物。
//!
//! Win/Linux 是否原生可用 recon 标 **U**（无官方文档）：本实现**不在 Win/Linux 上装应用菜单**
//! （对齐 Electron 隐藏 File/Edit 的现状），Ctrl+C/V/A 依赖系统 webview 原生行为，
//! 可编辑控件另有右键菜单兜底。若 Phase 6 验收发现 Win/Linux 上 Ctrl+C 无效，
//! 补一个 Edit 子菜单即可（`edit_submenu` 已备好）。
//!
//! ## 右键菜单
//!
//! Tauri v2 **没有** Electron 那样的 `context-menu` 事件（API notes §5.2，A 级证据：
//! `tauri-2.12.1/src/` 全树 grep `contextmenu` 只命中 muda 内部调用）。所以触发路径是
//! 壳注入的 init 脚本挂 DOM `contextmenu` → invoke `shell_context_menu` → 这里按
//! `desktop/main.js:521-545` 的同款规则组装菜单 → `WebviewWindow::popup_menu_at`。

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, LogicalPosition, Manager, Wry};

use super::i18n;
use super::{tray, window, ShellState};

/// 应用菜单里需要自己处理的自定义项 id（另外几个与托盘共用，见 `tray`）。
pub const ID_RELOAD: &str = "menu:reload";
pub const ID_ZOOM_IN: &str = "menu:zoom-in";
pub const ID_ZOOM_OUT: &str = "menu:zoom-out";
pub const ID_ZOOM_RESET: &str = "menu:actual-size";

/// 缩放步进与上下限。Electron 的 `zoomIn` role 按 zoomLevel ±0.5（≈×1.095）走，
/// 这里取 1.1 的近似步进（**属实现选择**，不是 API 事实）。
const ZOOM_STEP: f64 = 1.1;
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 5.0;

/// 安装应用菜单。**只在 macOS 上装**（见文件头说明）。
pub fn install_app_menu(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let menu = build_app_menu(app)?;
        menu.set_as_app_menu()?;
        log::info!("macOS 应用菜单已安装（含 Edit：Cmd+C/V/X/A 依赖它）");
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        log::info!("非 macOS：不安装应用菜单（对齐 Electron 隐藏 File/Edit；Ctrl+C/V/A 走 webview 原生，U1）");
    }
    Ok(())
}

/// 重建应用菜单（应用语言变化后刷新文案）。macOS 之外是空操作——那些平台不装应用菜单。
///
/// 为何需要它：菜单文案在**构建时**从 `i18n::of(locale)` 取，所以改语言必须重建菜单。
/// 托盘侧对应 `tray::refresh`（那份靠 `set_menu` 换菜单）。
pub fn refresh_app_menu(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        match build_app_menu(app) {
            Ok(menu) => {
                // 返回值是“被替换掉的旧菜单”（`Option<Menu<R>>`），不用管。
                if let Err(e) = menu.set_as_app_menu() {
                    log::warn!("刷新应用菜单失败：{e}");
                }
            }
            Err(e) => log::warn!("构建应用菜单失败：{e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// 构建 macOS 应用菜单。模板对齐 `desktop/main.js:1321-1425`：
/// `iRouter / Edit / View / Window / Help` 五项；**Edit 可见**（`main.js:1357` 是
/// `visible: false`；这里必须可见，否则加速键失效——这正是本项交付的核心）。
///
/// 注：`MenuItem::with_id` 对无法解析的加速键字符串是**静默丢弃**
/// （`tauri-2.12.1/src/menu/normal.rs:65`：`accelerator.and_then(|s| s.as_ref().parse().ok())`），
/// 因此这里用的都是 muda 解析器明确支持的名字（`,` `=` `-`，见
/// `muda-0.20.0/src/accelerator/mod.rs:286,297,327`）。
#[cfg(target_os = "macos")]
fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let t = i18n::of(super::locale(app));

    // ---- iRouter（App 菜单）----
    // 预定义项不带文案时用系统语言标签，等价于 Electron 里只有 role 没有 label 的写法
    // （`main.js:1342-1348`）。
    let about = PredefinedMenuItem::about(app, Some(t.about), None)?;
    let check_updates =
        MenuItem::with_id(app, tray::ID_CHECK_UPDATE, t.check_for_updates, true, None::<&str>)?;
    let app_sep1 = PredefinedMenuItem::separator(app)?;
    let settings =
        MenuItem::with_id(app, tray::ID_SETTINGS, t.settings, true, Some("CmdOrCtrl+,"))?;
    let app_sep2 = PredefinedMenuItem::separator(app)?;
    let services = PredefinedMenuItem::services(app, Some(t.services))?;
    let app_sep3 = PredefinedMenuItem::separator(app)?;
    let hide = PredefinedMenuItem::hide(app, Some(t.hide))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some(t.hide_others))?;
    let unhide = PredefinedMenuItem::show_all(app, Some(t.unhide))?;
    let app_sep4 = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some(t.quit))?;
    let app_menu = Submenu::with_items(
        app,
        "iRouter",
        true,
        &[
            &about,
            &check_updates,
            &app_sep1,
            &settings,
            &app_sep2,
            &services,
            &app_sep3,
            &hide,
            &hide_others,
            &unhide,
            &app_sep4,
            &quit,
        ],
    )?;

    // ---- Edit（关键：Cmd+C/V/X/A 的载体）----
    let edit = edit_submenu(app)?;

    // ---- View ----
    // Electron 的 View 还有 Force Reload 与 Toggle Developer Tools：前者要绕缓存、
    // 后者要 cargo feature `devtools`，在"远端 webview 面板"这个形态下都没有等价 API，
    // 故不提供（见交付说明的"未实现"清单）。
    let reload = MenuItem::with_id(app, ID_RELOAD, t.reload, true, Some("CmdOrCtrl+R"))?;
    let reset_zoom =
        MenuItem::with_id(app, ID_ZOOM_RESET, t.actual_size, true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(app, ID_ZOOM_IN, t.zoom_in, true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, ID_ZOOM_OUT, t.zoom_out, true, Some("CmdOrCtrl+-"))?;
    let view_sep1 = PredefinedMenuItem::separator(app)?;
    let view_sep2 = PredefinedMenuItem::separator(app)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, Some(t.toggle_full_screen))?;
    let view = Submenu::with_items(
        app,
        t.view,
        true,
        &[&reload, &view_sep1, &reset_zoom, &zoom_in, &zoom_out, &view_sep2, &fullscreen],
    )?;

    // ---- Window ----
    let minimize = PredefinedMenuItem::minimize(app, Some(t.minimize))?;
    let maximize = PredefinedMenuItem::maximize(app, Some(t.zoom))?;
    let win_sep1 = PredefinedMenuItem::separator(app)?;
    let front = PredefinedMenuItem::bring_all_to_front(app, Some(t.front))?;
    let win_sep2 = PredefinedMenuItem::separator(app)?;
    let close = PredefinedMenuItem::close_window(app, Some(t.close))?;
    let window_menu = Submenu::with_items(
        app,
        t.window,
        true,
        &[&minimize, &maximize, &win_sep1, &front, &win_sep2, &close],
    )?;

    // ---- Help ----
    let help_check =
        MenuItem::with_id(app, tray::ID_CHECK_UPDATE, t.check_for_updates, true, None::<&str>)?;
    let help_sep = PredefinedMenuItem::separator(app)?;
    let help_about = PredefinedMenuItem::about(app, Some(t.about), None)?;
    let help = Submenu::with_items(app, t.help, true, &[&help_check, &help_sep, &help_about])?;

    Menu::with_items(app, &[&app_menu, &edit, &view, &window_menu, &help])
}

/// Edit 子菜单：`undo, redo, separator, cut, copy, paste, select_all`。
/// 与 `Menu::default` 的 Edit 子菜单同款（`tauri-2.12.1/src/menu/menu.rs:203-216`）。
///
/// 非 macOS 构建下它没有被调用（Win/Linux 不装应用菜单），但刻意保留：
/// 若 U1 被证伪，接上它即可，不必重写。
#[allow(dead_code)]
fn edit_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    Submenu::with_items(app, "Edit", true, &[&undo, &redo, &sep1, &cut, &copy, &paste, &select_all])
}

/// 全局菜单事件（应用菜单 + 托盘菜单都从这里进来——
/// `TrayIcon::on_menu_event` 的文档原文："whether it is coming from this window,
/// another window or from the tray icon menu"，`tauri-2.12.1/src/tray/mod.rs:467`）。
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        tray::ID_OPEN => window::show_window(app),
        tray::ID_SETTINGS => super::commands::open_settings(app, None),
        tray::ID_CHECK_UPDATE => super::commands::request_update_check(app),
        tray::ID_QUIT => window::quit(app),
        ID_RELOAD => reload(app),
        ID_ZOOM_IN => zoom(app, true),
        ID_ZOOM_OUT => zoom(app, false),
        ID_ZOOM_RESET => set_zoom(app, 1.0),
        other => log::debug!("未处理的菜单项：{other}"),
    }
}

fn reload(app: &AppHandle) {
    if let Some(w) = window::main_window(app) {
        // 远端面板没有 `WebviewWindow::reload` 这类 API，用 eval 触发导航级重载。
        if let Err(e) = w.eval("window.location.reload()") {
            log::warn!("重新加载失败：{e}");
        }
    }
}

/// 缩放。当前倍率存在 `ShellState` 里（webview 没有 zoom getter，只能自己记账）。
fn zoom(app: &AppHandle, dir_in: bool) {
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let next = {
        let mut z = state.zoom.lock().expect("zoom lock poisoned");
        *z = if dir_in {
            (*z * ZOOM_STEP).min(ZOOM_MAX)
        } else {
            (*z / ZOOM_STEP).max(ZOOM_MIN)
        };
        *z
    };
    set_zoom(app, next);
}

fn set_zoom(app: &AppHandle, scale: f64) {
    if let Some(state) = app.try_state::<ShellState>() {
        *state.zoom.lock().expect("zoom lock poisoned") = scale;
    }
    if let Some(w) = window::main_window(app) {
        // `WebviewWindow::set_zoom`（`tauri-2.12.1/src/webview/webview_window.rs:2688`）
        if let Err(e) = w.set_zoom(scale) {
            log::warn!("设置缩放失败：{e}");
        }
    }
}

/// 组装并弹出右键菜单，规则照抄 `desktop/main.js:521-545`：
///   - 仅「日志页」或「可编辑控件」弹菜单，其余页面不弹；
///   - 日志页（不可编辑）：只给「复制」，且仅在**有选区**时可用；
///   - 可编辑：复制 / 剪切 / 粘贴 / 分隔线 / 全选。
///
/// 一处**能力差异**：`PredefinedMenuItem` 没有 `set_enabled`（`src/menu/predefined.rs`
/// 只有 id/text/set_text/app_handle），所以"禁用态"的复制项用普通
/// `MenuItem(enabled=false)` 顶替——外观与 Electron 的灰色项一致，它本来也不需要动作。
pub fn popup_context_menu(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    editable: bool,
    has_selection: bool,
    page_url: &str,
) -> tauri::Result<()> {
    let app = window.app_handle();
    let t = i18n::of(super::locale(app));
    let is_log_page = page_url.contains("/dashboard/console-log");

    // 可观测性：这条链路以前是黑盒——出问题时无法区分「面板没上报」与「Rust 侧抑制了」。
    // 每个分支都留痕，右键不弹时看日志就能定位是哪一侧、哪条规则。
    log::info!(
        "右键菜单请求：x={x:.0} y={y:.0} editable={editable} selection={has_selection} logPage={is_log_page} url={page_url}"
    );

    if !is_log_page && !editable {
        // 其余页面禁止任何右键菜单（文字选择在 globals.css 里已默认禁用）
        log::info!("右键菜单：非日志页且不可编辑 → 按规则不弹（与 main.js:521-545 一致）");
        return Ok(());
    }

    if is_log_page && !editable {
        if has_selection {
            let copy = PredefinedMenuItem::copy(app, Some(t.copy))?;
            let menu = Menu::with_items(app, &[&copy])?;
            log::info!("右键菜单：日志页 + 有选区 → 仅「复制」");
            return popup(window, &menu, x, y);
        }
        let copy = MenuItem::with_id(app, "ctx:copy-disabled", t.copy, false, None::<&str>)?;
        let menu = Menu::with_items(app, &[&copy])?;
        log::info!("右键菜单：日志页 + 无选区 → 仅禁用的「复制」");
        return popup(window, &menu, x, y);
    }

    let copy = PredefinedMenuItem::copy(app, Some(t.copy))?;
    let cut = PredefinedMenuItem::cut(app, Some(t.cut))?;
    let paste = PredefinedMenuItem::paste(app, Some(t.paste))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let select_all = PredefinedMenuItem::select_all(app, Some(t.select_all))?;
    let menu = Menu::with_items(app, &[&copy, &cut, &paste, &sep, &select_all])?;
    log::info!("右键菜单：可编辑区域 → 复制/剪切/粘贴/全选");
    popup(window, &menu, x, y)
}

/// 位置：DOM `clientX/clientY` 是 CSS 像素（相对 webview 视口）→ 传 `LogicalPosition`。
/// muda 自己按屏幕 backing scale factor 换算
/// （`muda-0.20.0/src/platform_impl/macos/mod.rs:1140` 的 `p.to_logical(scale_factor)`）。
///
/// `popup_menu_at` 内部经 `run_main_thread!` 在主线程执行菜单跟踪循环并**阻塞到菜单关闭**
/// ——所以调用它的命令写成 `async fn`（跑在 tokio 线程上），不要用同步命令占住主线程。
fn popup(window: &tauri::WebviewWindow, menu: &Menu<Wry>, x: f64, y: f64) -> tauri::Result<()> {
    // `WebviewWindow::popup_menu_at`（`tauri-2.12.1/src/webview/webview_window.rs:1807`，无平台门控）
    window.popup_menu_at(menu, LogicalPosition::new(x, y))
}
