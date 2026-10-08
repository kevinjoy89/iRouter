//! 系统托盘：图标 + 托盘菜单 + 点击事件。
//!
//! 对照 `desktop/main.js`：`createTray()` `:1502-1506`、`updateTrayMenu()` `:1483-1500`、
//! `trayIcon()` `:1452-1462`、`trayTooltip()` `:401-404`。
//!
//! 关键 API 事实（`docs/plans/2026-10-07-tauri-shell-api-notes.md` §2，均为已核实签名）：
//!   - `TrayIconBuilder::with_id/menu/icon/tooltip/icon_as_template/show_menu_on_left_click/
//!     on_tray_icon_event/build`（`tauri-2.12.1/src/tray/mod.rs:230-386`）；
//!   - `TrayIconEvent::DoubleClick` **文档明确标 Windows Only**（`tray/mod.rs:87`），
//!     所以 macOS/Linux 的双击要自己用两次 `Click` 的时间差判定。

use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use super::i18n;
use super::{window, ShellState, TRAY_ID};

/// 托盘菜单项 id（与 `menus.rs` 的应用菜单共用一套全局菜单事件处理器）。
pub const ID_ADDR: &str = "tray:gateway-addr";
pub const ID_OPEN: &str = "tray:open-dashboard";
pub const ID_CHECK_UPDATE: &str = "menu:check-update";
pub const ID_SETTINGS: &str = "menu:settings";
pub const ID_QUIT: &str = "tray:quit";

/// macOS/Linux 双击判定窗口。500 ms 是各平台双击阈值的常见取值（**属实现选择**，
/// 不是 API 事实——Electron 版靠 OS 原生双击事件，没有这个常量）。
const DOUBLE_CLICK_WINDOW: Duration = Duration::from_millis(500);

/// 建托盘。由 `shell::init` 调用（setup 阶段，主线程；菜单构造走
/// `run_main_thread!`，在主线程上是**内联执行**，不会死锁——见
/// `tauri-runtime-wry-2.12.1/src/lib.rs:263-280` 的 `send_user_message`）。
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(tooltip(app))
        // 左键「唤出窗口」、右键弹菜单。刻意不用默认的 `true`（左键=弹菜单）：
        // 若左键被菜单接管，macOS 上 `Click` 事件根本不会送到回调，
        // 任务要求的「两次 Click 判时差」就成了死代码。
        // 差异明细见交付说明（Electron 版 macOS 左键=菜单，右击=菜单）。
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| on_tray_icon_event(tray.app_handle(), event));

    // 图标：用配置里 bundle.icon 嵌进来的默认窗口图标（`AppHandle::default_window_icon`，
    // `tauri-2.12.1/src/app.rs:966`）。取不到就建一个无图标的托盘（Electron 版
    // 图标缺失时也是 `nativeImage.createEmpty()`，`main.js:1461`）。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
        // 模板图：macOS 只用 alpha 通道着色，自动适配深浅色菜单栏。
        // 文档原文 "Use the icon as a template. **macOS only**"（`tray/mod.rs:295`），
        // 其它平台是空操作，所以无条件调用不用 cfg。
        builder = builder.icon_as_template(true);
    } else {
        log::warn!("拿不到默认窗口图标，托盘将无图标");
    }

    builder.build(app)?;
    log::info!("托盘已创建（id={TRAY_ID}）");
    Ok(())
}

/// 重建托盘菜单（语言设置变化后刷新；对齐 `main.js:1446-1448, 692` 的 `updateTrayMenu()`）。
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        log::warn!("托盘不存在，刷新菜单跳过");
        return;
    };
    match build_menu(app) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log::warn!("设置托盘菜单失败：{e}");
            }
            let _ = tray.set_tooltip(Some(tooltip(app)));
        }
        Err(e) => log::warn!("构建托盘菜单失败：{e}"),
    }
}

/// 对齐 `desktop/main.js:1483-1499` 的 5 项菜单（macOS 少一项"设置"，因为它在应用菜单里）。
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let t = i18n::of(super::locale(app));

    let addr = MenuItem::with_id(app, ID_ADDR, gateway_addr_line(app, t.gateway_addr), false, None::<&str>)?;
    let open = MenuItem::with_id(app, ID_OPEN, t.open_dashboard, true, None::<&str>)?;
    let check = MenuItem::with_id(app, ID_CHECK_UPDATE, t.check_for_updates, true, None::<&str>)?;
    // macOS 已把「设置…」放进 App 菜单（Cmd+,），托盘不再重复（`main.js:1492-1495`）。
    let settings: Option<MenuItem<Wry>> = if cfg!(target_os = "macos") {
        None
    } else {
        Some(MenuItem::with_id(app, ID_SETTINGS, t.settings, true, None::<&str>)?)
    };
    let quit = MenuItem::with_id(app, ID_QUIT, t.quit_app, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = vec![&addr, &sep1, &open, &check];
    if let Some(settings) = &settings {
        items.push(settings);
    }
    items.push(&sep2);
    items.push(&quit);
    Menu::with_items(app, &items)
}

/// 第一项（不可点）的文案：`网关地址：http://127.0.0.1:<port>/v1`（全角冒号，同 `main.js:1488`）。
///
/// 端口来自 `gateway::Gateway`（自适应端口，`gateway.rs`）。取不到 state 时（例如
/// 开发期 `IROUTER_PANEL_URL` 那条不拉 sidecar 的路径）只显示标签，不编造端口。
fn gateway_addr_line(app: &AppHandle, label: &str) -> String {
    match app.try_state::<crate::gateway::Gateway>() {
        Some(gw) => format!("{label}：http://127.0.0.1:{}/v1", gw.port),
        None => label.to_string(),
    }
}

/// 对齐 `desktop/main.js:401-404` 的 `trayTooltip()`：`iRouter 网关 :20128`。
fn tooltip(app: &AppHandle) -> String {
    let label = i18n::of(super::locale(app)).tray_tooltip;
    match app.try_state::<crate::gateway::Gateway>() {
        Some(gw) => format!("{label} :{}", gw.port),
        None => label.to_string(),
    }
}

/// 托盘点击事件。左键单击/双击都「唤出窗口」（Electron 版左键无处理器、双击唤出，
/// 我们额外让单击也唤出——这是与 Electron 的一处**有意差异**，见交付说明）。
pub fn on_tray_icon_event(app: &AppHandle, event: TrayIconEvent) {
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => {
            note_left_click_for_double_detect(app);
            window::show_window(app);
        }
        // **Windows only**（tray/mod.rs:87 文档原文）。其它平台的等价物是上面那条时间差判定。
        TrayIconEvent::DoubleClick { .. } => {
            log::info!("托盘双击（原生事件，Windows only）→ 唤出窗口");
            window::show_window(app);
        }
        _ => {}
    }
}

/// macOS/Linux：`DoubleClick` 不会来，用两次左键 `Click` 的时间差判定。
/// Windows 走原生 `DoubleClick`，这里就不重复判定（否则一次双击会被两个路径都记一次）。
#[cfg(target_os = "windows")]
fn note_left_click_for_double_detect(_app: &AppHandle) {}

#[cfg(not(target_os = "windows"))]
fn note_left_click_for_double_detect(app: &AppHandle) {
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let now = Instant::now();
    let is_double = {
        let mut last = state.last_tray_left_click.lock().expect("tray click lock poisoned");
        let is_double = last
            .map(|prev| now.duration_since(prev) < DOUBLE_CLICK_WINDOW)
            .unwrap_or(false);
        // 判到双击就清空，避免"三连击"被判成两次双击
        *last = if is_double { None } else { Some(now) };
        is_double
    };
    if is_double {
        log::info!("托盘双击（两次 Click 判时差 <{}ms）", DOUBLE_CLICK_WINDOW.as_millis());
    }
}
