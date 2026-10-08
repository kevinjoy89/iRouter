//! 壳层设置：持久化与取值校验。
//!
//! **唯一实现**——shell 与 updater 都走这里（由 Lead 持有）。为什么不让两边各写一份：
//! 它们读写的是同一个 `<dataDir>/shell-settings.json`，两份实现 = 两个写者 = 互相丢键。
//!
//! 移植自 `desktop/settings.js`，**行为逐条对齐**（包括几处看起来可以"改进"的地方）：
//!   - 落盘位置：`<dataDir>/shell-settings.json`（与 `.gateway.pid` 同类，不塞进网关 sqlite）；
//!   - 取值校验：非法/缺失**一律回退默认，绝不抛**（文件缺失=升级路径、文件损坏=同款 fail-safe）；
//!   - 写盘：`JSON.stringify(next, null, 2) + "\n"` → 2 空格缩进 + **尾换行**；
//!   - **未知键会被丢弃**（`normalize` 只保留 5 个已知键）。这是原实现的既有行为，照抄——
//!     虽然"保留未知键"看起来更稳，但迁移期的验收标准是与 Electron 版**逐项对齐**，
//!     行为变更要单独评估，不能顺手改。
//!   - **不存开机自启**：那是系统状态，真相源是登录项；存副本只会产生
//!     「文件说开着、系统说关着」这类没有仲裁规则的不一致。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SETTINGS_FILE_NAME: &str = "shell-settings.json";

/// 关窗行为三档（与 `desktop/settings.js:24` 一致）。
///   quit — 关窗即退出；dock — 隐藏到托盘、保留 Dock 图块；tray — 隐藏到托盘并隐藏 Dock 图块
pub const CLOSE_ACTIONS: [&str; 3] = ["quit", "dock", "tray"];
pub const DEFAULT_CLOSE_ACTION: &str = "dock";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellSettings {
    #[serde(rename = "closeAction")]
    pub close_action: String,
    #[serde(rename = "checkUpdates")]
    pub check_updates: bool,
    #[serde(rename = "lastCheckAt")]
    pub last_check_at: Option<String>,
    #[serde(rename = "lastCheckResult")]
    pub last_check_result: Option<Value>,
    #[serde(rename = "ignoredVersion")]
    pub ignored_version: Option<String>,
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            close_action: DEFAULT_CLOSE_ACTION.to_string(),
            check_updates: true,
            last_check_at: None,
            last_check_result: None,
            ignored_version: None,
        }
    }
}

pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_FILE_NAME)
}

/// 读原始 JSON；文件缺失或损坏 → 空对象（不抛）。
fn read_raw(data_dir: &Path) -> Value {
    match std::fs::read_to_string(settings_path(data_dir)) {
        Ok(text) => serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// 取值校验：非法/缺失一律回退默认。对应 `desktop/settings.js:44-63` 的 `normalize`。
pub fn normalize(raw: &Value) -> ShellSettings {
    let base = ShellSettings::default();
    let Value::Object(map) = raw else {
        return base;
    };
    ShellSettings {
        close_action: map
            .get("closeAction")
            .and_then(Value::as_str)
            .filter(|s| CLOSE_ACTIONS.contains(s))
            .unwrap_or(DEFAULT_CLOSE_ACTION)
            .to_string(),
        check_updates: map.get("checkUpdates").and_then(Value::as_bool).unwrap_or(base.check_updates),
        last_check_at: map
            .get("lastCheckAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        last_check_result: map
            .get("lastCheckResult")
            .filter(|v| v.is_object())
            .cloned(),
        ignored_version: map
            .get("ignoredVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// 读设置。文件缺失（升级路径）或损坏 → 默认值，**永不抛**。
pub fn read(data_dir: &Path) -> ShellSettings {
    normalize(&read_raw(data_dir))
}

/// 合并 patch 后归一化并落盘，返回落盘后的完整设置。
///
/// 写盘失败只记日志、不抛——与原实现一致（`desktop/settings.js:84-88`）：设置读写不该
/// 因为磁盘问题把壳层带崩。
pub fn write(data_dir: &Path, patch: Value) -> ShellSettings {
    let mut merged = read_raw(data_dir);
    if !merged.is_object() {
        merged = Value::Object(serde_json::Map::new());
    }
    if let (Value::Object(dst), Value::Object(src)) = (&mut merged, &patch) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let next = normalize(&merged);
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&next).unwrap_or_else(|_| "{}".to_string())
    );
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        log::error!("[shell-settings] 创建数据目录失败：{e}");
        return next;
    }
    if let Err(e) = std::fs::write(settings_path(data_dir), text) {
        log::error!("[shell-settings] 写 {} 失败：{e}", settings_path(data_dir).display());
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("irouter-settings-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn defaults_match_the_js_implementation() {
        let s = ShellSettings::default();
        assert_eq!(s.close_action, "dock");
        assert!(s.check_updates);
        assert!(s.last_check_at.is_none() && s.last_check_result.is_none() && s.ignored_version.is_none());
    }

    #[test]
    fn normalize_falls_back_on_garbage_and_never_throws() {
        for bad in [json!(null), json!("x"), json!(1), json!([]), json!({})] {
            let s = normalize(&bad);
            assert_eq!(s.close_action, "dock");
            assert!(s.check_updates);
        }
        // 非法 closeAction 回退默认；类型不对的字段也回退
        let s = normalize(&json!({"closeAction": "nope", "checkUpdates": "yes", "lastCheckAt": 5}));
        assert_eq!(s.close_action, "dock");
        assert!(s.check_updates);
        assert!(s.last_check_at.is_none());
    }

    #[test]
    fn read_of_missing_file_is_default() {
        let d = tmp("missing");
        assert_eq!(read(&d).close_action, "dock");
    }

    #[test]
    fn read_of_corrupt_file_is_default() {
        let d = tmp("corrupt");
        std::fs::write(settings_path(&d), "{ not json").unwrap();
        assert_eq!(read(&d).close_action, "dock");
    }

    #[test]
    fn write_merges_patch_and_keeps_other_keys() {
        let d = tmp("merge");
        write(&d, json!({"closeAction": "tray", "ignoredVersion": "0.3.7"}));
        let s = write(&d, json!({"checkUpdates": false}));
        assert_eq!(s.close_action, "tray", "patch 不应覆盖未提及的键");
        assert_eq!(s.ignored_version.as_deref(), Some("0.3.7"));
        assert!(!s.check_updates);
    }

    #[test]
    fn file_format_is_two_space_indent_with_trailing_newline() {
        let d = tmp("format");
        write(&d, json!({"closeAction": "quit"}));
        let text = std::fs::read_to_string(settings_path(&d)).unwrap();
        assert!(text.ends_with("\n"), "必须有尾换行（对齐 desktop/settings.js:82）");
        assert!(text.contains("\n  \"closeAction\""), "必须是 2 空格缩进");
    }

    #[test]
    fn unknown_keys_are_dropped_like_the_js_implementation() {
        let d = tmp("unknown");
        std::fs::write(settings_path(&d), r#"{"closeAction":"tray","futureKey":42}"#).unwrap();
        write(&d, json!({"checkUpdates": true}));
        let text = std::fs::read_to_string(settings_path(&d)).unwrap();
        assert!(!text.contains("futureKey"), "原实现只保留 5 个已知键，照抄");
        assert!(text.contains("\"closeAction\": \"tray\""), "已知键要保留");
    }

    #[test]
    fn roundtrip_preserves_every_known_key() {
        let d = tmp("roundtrip");
        let patch = json!({
            "closeAction": "tray", "checkUpdates": false,
            "lastCheckAt": "2026-10-08T00:00:00Z",
            "lastCheckResult": {"updateAvailable": false},
            "ignoredVersion": "9.9.9"
        });
        let written = write(&d, patch);
        let back = read(&d);
        assert_eq!(written.close_action, back.close_action);
        assert_eq!(back.close_action, "tray");
        assert!(!back.check_updates);
        assert_eq!(back.last_check_at.as_deref(), Some("2026-10-08T00:00:00Z"));
        assert_eq!(back.last_check_result.unwrap()["updateAvailable"], json!(false));
        assert_eq!(back.ignored_version.as_deref(), Some("9.9.9"));
    }
}
