//! 菜单「检查更新…」的原生结果对话框（对照 `desktop/main.js:839-875`）。
//!
//! ## 为什么归 shell
//!
//! 文案要走 shell 的 i18n（updater 硬编码中英双语 = 再造一份文案层，必然分叉），
//! 「去设置」按钮要调 shell 的 `open_settings(Some("updates"))`。**updater 保持无 UI**。
//!
//! ## 触发链（接口不变）
//!
//! ```text
//! 托盘/应用菜单「检查更新…」
//!   → commands::request_update_check   （置"等结果"标记 + 发 shell:check-update-requested）
//!   → updater::commands::listen_for_check_requests → trigger_update_check(force, Menu)
//!   → 发 shell:update-available（载荷 = CheckResult 的 JSON）
//!   → 本模块的 listener 看到标记 → 弹对话框 →「去设置」→ open_settings(Some("updates"))
//! ```
//!
//! ⚠️ **监听必须挂在 WebviewWindow 上，不能挂 `AppHandle`**：updater 的 `emit_json` 用
//! `emit_to(EventTarget::webview_window("main"), …)`（`src/updater/events.rs:46-60`），而
//! `emit_to` 的目标过滤是**相等匹配**（`tauri-2.12.1/src/manager/mod.rs:588+`：
//! `match_any_or_filter` 只在对方是 `EventTarget::Any` 时放行）。`AppHandle::listen` 注册的是
//! `EventTarget::App`（`src/app.rs:1203-1213`）→ **永远收不到**，而且是静默收不到。
//! `WebviewWindow::listen` 注册的才是 `EventTarget::WebviewWindow{label}`
//! （`src/webview/webview_window.rs:2776-2788`），与发送端一致。
//!
//! ## 为什么 listener 是懒注册
//!
//! `shell::init` 跑在 setup 里，**主窗口还没建出来**（`main.rs` 在 `shell::init` 之后才 build 窗口）。
//! 而菜单项只有等窗口存在后才可能被点击，所以第一次点「检查更新…」时注册即可（幂等）。

use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Listener, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::i18n::{self, Locale};

/// 与 `src/updater/events.rs:19` 的 `EV_AVAILABLE` **同名同义**（契约，改要两边一起改）。
pub const EV_UPDATE_AVAILABLE: &str = "shell:update-available";

/// 等结果的时限：超时后不再为一次迟到的检查弹框，避免"点一次、几分钟后突然弹窗"。
const AWAIT_TIMEOUT: Duration = Duration::from_secs(120);

/// 对话框的三段分支之一编译成的**纯数据**（便于单测；真正弹窗要 GUI）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogPlan {
    pub kind: MessageDialogKind,
    pub title: String,
    pub message: String,
    pub detail: String,
    /// 只有"可更新"分支有两个按钮 `(去设置, 稍后)`；其余分支只有 OK。
    pub buttons: Option<(String, String)>,
}

/// 把一次检查结果编译成对话框内容。对照 `main.js:847-874` 的三段分支。
///
/// 与 Electron 的唯一输入差异：Electron 读 `app.getVersion()`，这里由调用方传入
/// `app.package_info().version`（同一个值，`main.js:818` 也是用它去查的）。
pub fn plan(locale: Locale, current_version: &str, result: &Value) -> DialogPlan {
    let t = i18n::of(locale);
    // Electron: `t.checkForUpdates.replace("…", "")`（`main.js:850,857,870`）
    let title = t.check_for_updates.replace('…', "").trim().to_string();

    if let Some(error) = result
        .get("error")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return DialogPlan {
            kind: MessageDialogKind::Warning,
            title,
            message: t.update_check_failed.to_string(),
            detail: error.to_string(),
            buttons: None,
        };
    }

    if result
        .get("updateAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        // Electron 直接用 `result.latest` 拼字符串；取不到时这里回落 "?"（Electron 会显示
        // 字面量 "undefined"——不照抄这个明显缺陷，已在交付说明里标注）。
        let latest = result
            .get("latest")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("?");
        return DialogPlan {
            kind: MessageDialogKind::Info,
            title,
            message: format!("{} (v{latest})", t.update_available),
            // `main.js:859` 的换行与**全角冒号**逐字照抄（两种语言都一样）。
            detail: format!(
                "{}\n\n{}：v{}\n{}：v{}",
                t.update_available_detail, t.current_version, current_version, t.latest_version, latest
            ),
            buttons: Some((
                t.open_update_settings.to_string(),
                t.later.to_string(),
            )),
        };
    }

    DialogPlan {
        kind: MessageDialogKind::Info,
        title,
        message: t.up_to_date.to_string(),
        // `main.js:872`：`${t.upToDateDetail} (v${app.getVersion()})`
        detail: format!("{} (v{})", t.up_to_date_detail, current_version),
        buttons: None,
    }
}

/// 弹一次结果对话框。**非阻塞**：`tauri-plugin-dialog` 的 `show()` 内部
/// `run_on_main_thread` 派发（`tauri-plugin-dialog-2.8.1/src/desktop.rs:215-226`），
/// 回调在用户点按钮后才执行；`blocking_show*` 明确标注不能在主线程用，故一律不用。
pub fn show(app: &AppHandle, result: &Value) {
    let locale = super::locale(app);
    let current = app.package_info().version.to_string();
    let plan = plan(locale, &current, result);

    let mut builder = app
        .dialog()
        .message(plan.message)
        .title(plan.title)
        .kind(plan.kind);

    // 父窗口：对齐 `main.js:841-845`——主窗口**可见**时挂在它上面（macOS 上表现为 sheet），
    // 隐藏/不存在时作为独立弹窗，避免被隐藏的父窗口一起藏掉。
    if let Some(window) = super::window::main_window(app) {
        if window.is_visible().unwrap_or(false) {
            builder = builder.parent(&window);
        }
    }

    match plan.buttons {
        Some((open_label, later_label)) => {
            let handle = app.clone();
            builder
                .buttons(MessageDialogButtons::OkCancelCustom(open_label, later_label))
                .show(move |open_settings_clicked| {
                    if open_settings_clicked {
                        // 对齐 `main.js:864-866`：只有点了「去设置」才打开设置面板的更新分段。
                        log::info!("用户选择「打开更新面板」→ shell:open-settings(section=updates)");
                        super::commands::open_settings(&handle, Some("updates"));
                    } else {
                        log::info!("用户选择「稍后」");
                    }
                });
        }
        None => {
            builder.show(|_| {});
        }
    }
}

/// 懒注册「检查结果」监听（幂等）。见文件头"为什么 listener 是懒注册"。
pub fn ensure_result_listener(app: &AppHandle) {
    let Some(state) = app.try_state::<super::ShellState>() else {
        log::warn!("ShellState 未就绪，跳过更新结果监听注册");
        return;
    };
    if state.result_listener_registered.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return; // 已经注册过
    }

    let Some(window) = super::window::main_window(app) else {
        // 窗口还没建出来（理论上菜单点不到，防御性回落）
        log::warn!("主窗口尚不存在，更新结果监听注册推迟到下次触发");
        state
            .result_listener_registered
            .store(false, std::sync::atomic::Ordering::SeqCst);
        return;
    };

    let handle = app.clone();
    window.listen(EV_UPDATE_AVAILABLE, move |event| {
        // 只处理"菜单触发"的那一次：其它来源（面板点检查、启动 3s 静默检查）不发弹窗，
        // 与 Electron 的 `if (force && source === "menu")`（`main.js:839`）等价。
        let Some(state) = handle.try_state::<super::ShellState>() else {
            return;
        };
        let awaiting = {
            let mut guard = state
                .menu_check_at
                .lock()
                .expect("menu check lock poisoned");
            match *guard {
                Some(at) if at.elapsed() <= AWAIT_TIMEOUT => {
                    *guard = None;
                    true
                }
                Some(_) => {
                    // 过期：清掉，不为一次迟到的检查弹框
                    log::warn!("菜单触发的更新检查超过 {}s 才返回，跳过结果弹窗", AWAIT_TIMEOUT.as_secs());
                    *guard = None;
                    false
                }
                None => false,
            }
        };
        if !awaiting {
            return;
        }
        let result: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
        log::info!("收到菜单触发的检查结果，弹出结果对话框");
        show(&handle, &result);
    });
    log::info!("已注册 {EV_UPDATE_AVAILABLE} 监听（挂 WebviewWindow，匹配 updater 的发送目标）");
}

/// 标记"有一次菜单触发的检查在等结果"。返回 `false` 表示已有一次在等（避免连点叠标记）。
pub fn mark_menu_check_pending(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<super::ShellState>() else {
        return false;
    };
    let mut guard = state
        .menu_check_at
        .lock()
        .expect("menu check lock poisoned");
    let fresh = guard
        .map(|at| at.elapsed() > AWAIT_TIMEOUT)
        .unwrap_or(true);
    *guard = Some(Instant::now());
    fresh
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn error_result() -> Value {
        json!({ "error": "network unreachable", "updateAvailable": false, "latest": null })
    }

    #[test]
    fn error_branch_is_a_warning_dialog_with_the_raw_message() {
        let p = plan(Locale::ZhCn, "0.3.7", &error_result());
        assert_eq!(p.kind, MessageDialogKind::Warning);
        assert_eq!(p.title, "检查更新");
        assert_eq!(p.message, "检查更新失败");
        assert_eq!(p.detail, "network unreachable", "detail 必须是裸错误串（main.js:852）");
        assert!(p.buttons.is_none(), "失败分支只有一个 OK");
    }

    #[test]
    fn update_available_branch_matches_main_js_line_858_859() {
        let r = json!({ "error": null, "updateAvailable": true, "latest": "9.9.9" });
        let p = plan(Locale::ZhCn, "0.3.7", &r);
        assert_eq!(p.kind, MessageDialogKind::Info);
        assert_eq!(p.message, "发现新版本 (v9.9.9)");
        assert_eq!(
            p.detail,
            "iRouter 已有新版本可用。是否立即打开设置面板进行更新？\n\n当前版本：v0.3.7\n最新版本：v9.9.9"
        );
        assert_eq!(
            p.buttons,
            Some(("打开更新面板".to_string(), "稍后".to_string())),
            "两个按钮文案来自 i18n，缺一不可"
        );
    }

    #[test]
    fn up_to_date_branch_matches_main_js_line_871_872() {
        let r = json!({ "error": null, "updateAvailable": false, "latest": null });
        let p = plan(Locale::ZhCn, "0.3.7", &r);
        assert_eq!(p.kind, MessageDialogKind::Info);
        assert_eq!(p.message, "当前已是最新版本");
        assert_eq!(p.detail, "您正在使用最新版本的 iRouter。 (v0.3.7)");
        assert!(p.buttons.is_none());
    }

    /// `latest` 缺失时不照抄 Electron 的 "undefined" 字面量（见 `plan` 的注释）。
    #[test]
    fn missing_latest_does_not_render_undefined() {
        let r = json!({ "error": null, "updateAvailable": true, "latest": null });
        let p = plan(Locale::En, "1.2.3", &r);
        assert!(p.message.ends_with("(v?)"), "实际：{}", p.message);
        assert!(p.detail.contains("Latest Version：v?"), "实际：{}", p.detail);
    }

    #[test]
    fn english_and_traditional_chinese_are_translated() {
        let r = json!({ "error": null, "updateAvailable": true, "latest": "9.9.9" });
        let en = plan(Locale::En, "1.0.0", &r);
        assert_eq!(en.message, "New Version Available (v9.9.9)");
        assert_eq!(en.buttons, Some(("Open Settings".to_string(), "Later".to_string())));
        assert_eq!(en.title, "Check for Updates");

        let tw = plan(Locale::ZhTw, "1.0.0", &r);
        assert_eq!(tw.message, "發現新版本 (v9.9.9)");
        assert_eq!(tw.buttons, Some(("開啟更新面板".to_string(), "稍後".to_string())));
        assert_eq!(tw.title, "檢查更新");
    }

    /// `main.js:850` 的 `title = t.checkForUpdates.replace("…", "")`。
    #[test]
    fn title_strips_the_ellipsis() {
        for l in [Locale::En, Locale::ZhCn, Locale::ZhTw] {
            let p = plan(l, "1.0.0", &error_result());
            assert!(!p.title.contains('…'), "{:?} 的标题不该带省略号", l);
            assert!(!p.title.is_empty());
        }
    }

    /// 空字符串的 error 不算失败（`Value::as_str().filter(|s| !s.is_empty())`）。
    #[test]
    fn empty_error_falls_through_to_the_up_to_date_branch() {
        let r = json!({ "error": "", "updateAvailable": false });
        let p = plan(Locale::ZhCn, "0.3.7", &r);
        assert_eq!(p.message, "当前已是最新版本");
    }
}
