//! 壳层 IPC：设置读写 + 右键菜单。
//!
//! ## 与 `desktop/preload.js` 的对应
//!
//! Electron 版的面板桥是 `preload.js:10-25` 的 `window.irouterShell`；Tauri 版用一份
//! 注入脚本（`shell/shim.js`，由 main.rs 挂到建窗处）复刻同一组方法名。命令名刻意
//! 对齐 Electron 的 IPC 通道名（`shell:get-settings` → `shell_get_settings`）：
//!   - `shell_get_settings`  ↔ `preload.js:12` / `main.js:679-684`
//!   - `shell_set_settings`  ↔ `preload.js:14-15` / `main.js:686-698`
//!   - `shell_context_menu`  ↔ `main.js:521-545`（Tauri 没有 context-menu 事件，见 `menus.rs`）
//!
//! ⚠️ **远端 origin 的命令必须进 capability**：面板是 `http://127.0.0.1:<port>`（远端 origin），
//! 而 `tauri-2.12.1/src/webview/mod.rs:2066-2073` 的注释原文写明：远端 origin 的 IPC
//! **一律走 ACL 检查**，且 `allow-$command` 只有在 `build.rs` 的 `AppManifest::commands()`
//! 里声明过才会生成。两个命令已在 build.rs；`shell_context_menu` **待 Lead 补声明**。

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use tauri_plugin_autostart::ManagerExt;

use super::{window, ShellState};

/// 设置读取：`{...shell-settings.json, launchAtLogin, appVersion}`
/// （对齐 `main.js:679-684`；开机自启的真相源是系统登录项，不存文件）。
#[tauri::command]
pub async fn shell_get_settings(app: AppHandle) -> Result<Value, String> {
    settings_payload(&app)
}

/// 设置写入：`launchAtLogin` 写系统登录项，其余键写 `<dataDir>/shell-settings.json`，
/// 返回写入后的完整设置（对齐 `main.js:686-698`）。
#[tauri::command]
pub async fn shell_set_settings(
    app: AppHandle,
    key: String,
    value: Value,
) -> Result<Value, String> {
    if key == "launchAtLogin" {
        set_autostart(&app, value.as_bool() == Some(true))?;
    } else {
        let data_dir = crate::gateway::resolve_data_dir(&app)?;
        let mut patch = Map::new();
        patch.insert(key, value);
        // 唯一实现对：`crate::settings`（Lead 持有，行为逐条对齐 desktop/settings.js）。
        crate::settings::write(&data_dir, Value::Object(patch));
    }
    // 对齐 main.js:692 的 `updateTrayMenu()`：设置变化后刷新托盘（幂等、便宜）。
    super::tray::refresh(&app);
    settings_payload(&app)
}

/// 右键菜单：由注入脚本的 DOM `contextmenu` 监听 invoke 回来，参数是
/// `{ x, y, editable, selection, url }`。
///
/// **必须是 `async fn`**：`popup_menu_at` 会阻塞到菜单关闭（见 `menus.rs::popup`），
/// 同步命令跑在主线程上会把事件循环一起卡住。
#[tauri::command]
pub async fn shell_context_menu(
    window: WebviewWindow,
    x: f64,
    y: f64,
    editable: bool,
    selection: bool,
    url: String,
) -> Result<(), String> {
    super::menus::popup_context_menu(&window, x, y, editable, selection, &url)
        .map_err(|e| format!("弹出右键菜单失败：{e}"))
}

// 命令处理器**不在这里**：`Builder::invoke_handler` 是覆盖式（`tauri-2.12.1/src/app.rs:1727`
// 的 `self.invoke_handler = Box::new(..)`），所以 shell 与 updater 的命令在 `main.rs` 里合并成
// **单一** `generate_handler!`。注意那里必须写**命令定义所在模块的真实路径**
// （`shell::commands::shell_get_settings`）：`generate_handler!` 会把路径最后一段换成伴生宏
// `__cmd__<name>`（`tauri-macros-2.7.1/src/command/handler.rs:163-171`），而伴生宏定义在本模块，
// 用 `pub use` 转出后按路径引用会报 E0433——实测过。

/// 设置载荷：文件里的 5 个已知键 + 系统登录项状态 + 应用版本。
pub fn settings_payload(app: &AppHandle) -> Result<Value, String> {
    let data_dir = crate::gateway::resolve_data_dir(app)?;
    let settings = crate::settings::read(&data_dir);
    let mut value =
        serde_json::to_value(&settings).map_err(|e| format!("序列化壳层设置失败：{e}"))?;
    let Some(map) = value.as_object_mut() else {
        return Err("壳层设置序列化结果不是对象".into());
    };
    map.insert("launchAtLogin".into(), Value::Bool(autostart_enabled(app)));
    map.insert(
        "appVersion".into(),
        Value::String(app.package_info().version.to_string()),
    );
    Ok(value)
}

/// 对齐 `main.js:1464-1470` 的 `autostartEnabled()`（读失败一律 false）。
pub fn autostart_enabled(app: &AppHandle) -> bool {
    match app.autolaunch().is_enabled() {
        Ok(enabled) => enabled,
        Err(e) => {
            log::warn!("读取开机自启状态失败：{e}");
            false
        }
    }
}

/// 对齐 `main.js:1472-1478` 的 `setAutostart()`。
///
/// `openAsHidden` 的等价物在**注册侧**：`main.rs` 注册 autostart 插件时带了
/// `--from-autostart` 参数（插件没有"隐藏启动"开关，官方示例就是标记参数法，
/// 见 API notes §3）；启动侧由 `window::opened_at_login()` 判断。
fn set_autostart(app: &AppHandle, on: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if on { manager.enable() } else { manager.disable() };
    result.map_err(|e| format!("设置开机自启失败：{e}"))
}

/// 打开设置模态框（`shell:open-settings`）。
///
/// Electron 版的 4 个 `webContents.send("shell:open-settings", …)` 落点
/// （`main.js:666, 671, 1726, 1804`）在 Rust 侧收敛成这一个函数：
///   - `:671`（窗口已存在、直接发）    → 本函数的面板已加载分支；
///   - `:666`（窗口刚建，等 did-finish-load 再发）→ `pending_open` + `on_page_load` 补发；
///   - `:1726/:1804`（smoke 测的两处直接发）→ 本函数就是那个可被自动化调用的入口
///     （`pub`，不依赖菜单点击）。
///
/// payload 与 Electron 一致：有分段时 `{"section": …}`，否则 `{}`
/// （`ShellSettingsHost.js:29` 读 `event.section`）。
pub fn open_settings(app: &AppHandle, section: Option<&str>) {
    window::show_window(app);
    let payload = match section {
        Some(section) => json!({ "section": section }),
        None => json!({}),
    };
    if panel_ready(app) {
        // 这条日志是**可观测性 + 自动化断言**共用的：verify-shell.mjs 的场景
        // `open-settings:updates` 就断言它（否则这条链路在日志里完全不可见）。
        log::info!("打开设置面板：section={section:?}（面板已就绪，直接投递）");
        emit_open_settings(app, &payload);
    } else {
        // 窗口还停在兜底页（网关未就绪）或面板尚未加载完：此时发了也无人监听。
        // 记 pending，`on_page_load` 收到 Finished 时补发（等价 Electron 的
        // `webContents.once("did-finish-load", …)`）。
        log::info!("面板尚未加载完成，shell:open-settings 暂存待补发");
        if let Some(state) = app.try_state::<ShellState>() {
            *state.pending_open.lock().expect("pending lock poisoned") = Some(payload);
        }
    }
}

/// page load Finished 时补发暂存的打开设置请求（由 `mod.rs` 的插件钩子调用）。
pub fn flush_pending_open_settings(app: &AppHandle, webview_label: &str) {
    if webview_label != window::MAIN_WINDOW || !panel_ready(app) {
        return;
    }
    let pending = app
        .try_state::<ShellState>()
        .and_then(|state| state.pending_open.lock().expect("pending lock poisoned").take());
    if let Some(payload) = pending {
        log::info!("面板加载完成，补发 shell:open-settings");
        emit_open_settings(app, &payload);
    }
}

fn emit_open_settings(app: &AppHandle, payload: &Value) {
    // 只发给主窗口（Electron 版也是 `mainWindow.webContents.send`）。
    if let Err(e) = app.emit_to(
        tauri::EventTarget::webview_window(window::MAIN_WINDOW),
        "shell:open-settings",
        payload.clone(),
    ) {
        log::warn!("发送 shell:open-settings 失败：{e}");
    }
}

/// 面板是否已经加载完成：用 URL 的 host 判定（兜底页走 `tauri://localhost` /
/// `http://tauri.localhost`，只有面板才是 `127.0.0.1`）。
pub(super) fn panel_ready(app: &AppHandle) -> bool {
    window::main_window(app)
        .and_then(|w| w.url().ok())
        .and_then(|url| url.host_str().map(|h| h == "127.0.0.1" || h == "localhost"))
        .unwrap_or(false)
}

/// 菜单/托盘的「检查更新…」（对齐 `main.js:1491, 1333, 1405` → `triggerUpdateCheck(true)`，
/// 其 `source` 默认值就是 `"menu"`，见 `main.js:814`）。
///
/// 三步，顺序不能反：
///   1. `dialogs::ensure_result_listener` —— 懒注册结果监听（`init` 时窗口还不存在，见 `dialogs` 头注）；
///   2. `dialogs::mark_menu_check_pending` —— 打上"这次的结果要弹窗"的标记；
///   3. 发 `shell:check-update-requested`（**应用内部事件**，`EventTarget::app()`，
///      只发给 Rust 侧 listener）→ updater 的 `listen_for_check_requests` 接住并跑检查。
///
/// **刻意不在这里 `open_settings("updates")`**：Electron 只在用户点了对话框里的
/// 「去设置」时才打开（`main.js:864-866`）。原先没有对话框时这里临时开了面板，
/// 现在改由 `dialogs::show` 的按钮回调负责。
pub fn request_update_check(app: &AppHandle) {
    super::dialogs::ensure_result_listener(app);
    super::dialogs::mark_menu_check_pending(app);
    if let Err(e) = app.emit_to(
        tauri::EventTarget::app(),
        "shell:check-update-requested",
        json!({ "force": true }),
    ) {
        log::warn!("发送 shell:check-update-requested 失败：{e}");
    }
}
