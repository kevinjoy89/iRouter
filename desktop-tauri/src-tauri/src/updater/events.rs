//! 事件发送：4 个事件名 + payload 形状 + 进度节流（设计 §7/§14.3）。
//!
//! ## 三条硬契约，每条都在这里被"结构性地"保证
//!   1. **事件名逐字不变**（`EV_*` 常量，面板侧的 shim 用同一组字面量）。
//!   2. **`shell:update-error` 的 payload 是裸字符串** —— 所以 `emit_error` 收 `&str` 并
//!      `emit_to(..., msg.to_string())`。**不要**给它套 struct：面板把它直接渲染成 React
//!      子节点（`UpdateSettings.js:53-56,303-305`），对象会直接炸渲染而不是显示 `[object Object]`。
//!   3. **窗口守卫**：Electron 侧发送前有 `mainWindow && !mainWindow.isDestroyed()`
//!      （`main.js:728,748,762,767`）。这里等价于"窗口还在就只发主窗口、不在就静默丢弃"；
//!      emit 失败**只记日志**，绝不中断下载流程。

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use super::checker::CheckResult;
use super::download::DownloadProgress;

pub const EV_PROGRESS: &str = "shell:update-progress";
pub const EV_AVAILABLE: &str = "shell:update-available";
pub const EV_DOWNLOADED: &str = "shell:update-downloaded";
pub const EV_ERROR: &str = "shell:update-error";

/// **应用内部**事件（不出 webview）：托盘/应用菜单的「检查更新…」由 shell 模块发出
/// （`emit_to(EventTarget::app())`），载荷 `{"force": true}`。事件名与载荷由 shell-impl 定，
/// 不要改。等价 `main.js` 里菜单项直接调 `triggerUpdateCheck(true, {source:"menu"})`。
pub const EV_CHECK_REQUESTED: &str = "shell:check-update-requested";

/// 主窗口 label（`main.rs` 建窗时用的就是它）。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// `shell:update-downloaded` 的 payload（`main.js:756-761` 字面量的等价物）。
///
/// ⚠️ `releaseURL` 必须显式 `rename`：`rename_all = "camelCase"` 只会产出 `releaseUrl`，
/// 而 JS 侧键名是 `releaseURL`（`main.js:759`）。面板当前**不读**这个字段，但契约是
/// "7 个被读的字段之外，其余照原样发"（设计 §7.1）——少一个 = 给未来的面板埋静默失败。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedInfo {
    pub path: String,
    pub asset_name: String,
    #[serde(rename = "releaseURL")]
    pub release_url: String,
    pub is_archive: bool,
}

/// 主窗口还在 → 只发它（贴近 `mainWindow.webContents.send` 语义）；
/// 不在 → 广播（此时没有订阅者，等价于 Electron 的"窗口没了就不发"）。
fn target(app: &AppHandle) -> EventTarget {
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_some() {
        EventTarget::webview_window(MAIN_WINDOW_LABEL)
    } else {
        EventTarget::Any
    }
}

fn emit_json<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: &S) {
    if let Err(e) = app.emit_to(target(app), event, payload.clone()) {
        log::warn!("发送 {event} 失败（窗口可能已销毁）：{e}");
    }
}

/// `shell:update-progress`（每 chunk 由节流器决定是否真的发）。
pub fn emit_progress(app: &AppHandle, progress: &DownloadProgress) {
    emit_json(app, EV_PROGRESS, progress);
}

/// `shell:update-available`：**检查失败也照发**（错误在 `error` 字段里，见下）。
pub fn emit_available(app: &AppHandle, result: &CheckResult) {
    emit_json(app, EV_AVAILABLE, result);
}

/// `shell:update-downloaded`：下载并**校验通过**之后才发。
pub fn emit_downloaded(app: &AppHandle, info: &DownloadedInfo) {
    emit_json(app, EV_DOWNLOADED, info);
}

/// `shell:update-error`：**裸字符串** payload（`main.js:749,768` 都是 `err.message`）。
///
/// 调用面只有两处：下载/校验失败、用户取消（D-3 照抄）。**检查失败不走这里**
/// ——那条路径只发 `shell:update-available`，错误装在 `error` 字段里。
pub fn emit_error(app: &AppHandle, message: &str) {
    if let Err(e) = app.emit_to(target(app), EV_ERROR, error_payload(message)) {
        log::warn!("发送 {EV_ERROR} 失败（窗口可能已销毁）：{e}");
    }
}

/// 单独抽出来是为了让"payload 是字符串"这件事**可以被单测钉住**。
pub(crate) fn error_payload(message: &str) -> String {
    message.to_string()
}

/// 进度节流（设计 §7.6）：`percent` 变化 ≥1 **或** 累计 ≥1 MiB 才发。
///
/// 等价性论证：面板只把 `percent` 用于渲染（`UpdateSettings.js:274,280`），把 state 置成
/// `downloading` 的是**第一个**事件（`:43-46`）——所以 `last_percent` 初值为 `None`，
/// 第一个 chunk 一定发；"下载完成"由 `shell:update-downloaded` 保证，丢中间进度只影响
/// 刷新率，不影响任何状态迁移。**最后一次必须由调用方无条件发**（`force`）。
pub struct ProgressThrottle {
    last_percent: Option<u32>,
    last_emitted_downloaded: u64,
}

/// 1 MiB：`downloaded` 的增长阈值。
const BYTES_THRESHOLD: u64 = 1024 * 1024;

impl Default for ProgressThrottle {
    fn default() -> Self {
        Self::new()
    }
}

impl ProgressThrottle {
    pub fn new() -> Self {
        Self {
            last_percent: None,
            last_emitted_downloaded: 0,
        }
    }

    /// 是否该发。为真时会更新内部游标。
    pub fn should_emit(&mut self, p: &DownloadProgress) -> bool {
        let percent_changed = self
            .last_percent
            .map(|last| last != p.percent)
            .unwrap_or(true);
        let bytes_advanced = p.downloaded.saturating_sub(self.last_emitted_downloaded)
            >= BYTES_THRESHOLD;
        if percent_changed || bytes_advanced {
            self.last_percent = Some(p.percent);
            self.last_emitted_downloaded = p.downloaded;
            true
        } else {
            false
        }
    }

    /// 强制发（收尾用）。
    pub fn force(&mut self, p: &DownloadProgress) {
        self.last_percent = Some(p.percent);
        self.last_emitted_downloaded = p.downloaded;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn event_names_are_frozen() {
        // 面板侧 shim 用同一组字面量；改名 = 面板静默收不到任何更新状态
        assert_eq!(EV_PROGRESS, "shell:update-progress");
        assert_eq!(EV_AVAILABLE, "shell:update-available");
        assert_eq!(EV_DOWNLOADED, "shell:update-downloaded");
        assert_eq!(EV_ERROR, "shell:update-error");
    }

    #[test]
    fn error_payload_is_a_bare_string() {
        let v = serde_json::to_value(error_payload("Download canceled by user")).unwrap();
        assert!(v.is_string(), "update-error 必须是裸字符串，发对象面板渲染会炸");
        assert_eq!(v, json!("Download canceled by user"));
    }

    #[test]
    fn progress_payload_shape_is_camel_case() {
        let v = serde_json::to_value(DownloadProgress::new(12_345_678, 157_000_000)).unwrap();
        assert_eq!(
            v,
            json!({"downloaded": 12_345_678u64, "total": 157_000_000u64, "percent": 8u32})
        );
    }

    #[test]
    fn downloaded_payload_shape_matches_main_js() {
        let info = DownloadedInfo {
            path: "/Users/x/Downloads/iRouter-0.3.2-macos-arm64.dmg".into(),
            asset_name: "iRouter-0.3.2-macos-arm64.dmg".into(),
            release_url: "https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.2".into(),
            is_archive: false,
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            json!({
                "path": "/Users/x/Downloads/iRouter-0.3.2-macos-arm64.dmg",
                "assetName": "iRouter-0.3.2-macos-arm64.dmg",
                "releaseURL": "https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.2",
                "isArchive": false
            })
        );
    }

    #[test]
    fn throttle_emits_first_percent_change_and_byte_advance() {
        let mut t = ProgressThrottle::new();
        // 第一个 chunk（percent 0）必须发 —— 面板靠它把 state 置成 downloading
        assert!(t.should_emit(&DownloadProgress::new(1024, 1_000_000)));
        // 同一 percent、增量 < 1MiB → 不发
        assert!(!t.should_emit(&DownloadProgress::new(2048, 1_000_000)));
        assert!(!t.should_emit(&DownloadProgress::new(100 * 1024, 100_000_000)));
        // percent 变了（0 → 1）→ 发
        assert!(t.should_emit(&DownloadProgress::new(1_100_000, 100_000_000)));
    }

    #[test]
    fn throttle_emits_on_one_mib_of_bytes_even_with_frozen_percent() {
        let mut t = ProgressThrottle::new();
        // total=0 → percent 恒 0，只能靠字节阈值推进
        assert!(t.should_emit(&DownloadProgress::new(0, 0)));
        assert!(!t.should_emit(&DownloadProgress::new(1024, 0)));
        assert!(!t.should_emit(&DownloadProgress::new(BYTES_THRESHOLD - 1, 0)));
        assert!(t.should_emit(&DownloadProgress::new(BYTES_THRESHOLD, 0)));
    }

    #[test]
    fn throttle_force_always_emits_the_last_one() {
        let mut t = ProgressThrottle::new();
        let _ = t.should_emit(&DownloadProgress::new(50, 100));
        // 最后一次即便被节流吞掉，调用方也会 force 发一次（100%）
        t.force(&DownloadProgress::new(100, 100));
        assert_eq!(t.last_percent, Some(100));
        assert!(!t.should_emit(&DownloadProgress::new(101, 100)));
    }
}
