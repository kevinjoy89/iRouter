//! 壳层设置**契约**的补充测试（被测对象是 `crate::settings`，只测不改）。
//!
//! ## 为什么这个模块存在
//!
//! `tests/unit/desktop-shell-settings.test.js` 有 **15 个 case**，而 `src/settings.rs` 只有
//! **8 个单测**——task-11 要求逐条对账（表见 `docs/plans/2026-10-08-r1-coverage.md`）。
//! 逐条比完之后有 7 个 case 在 Rust 侧没有**等价断言**：有的只是"大体覆盖"，
//! 有的是实现里有、但没人测过（目录创建、落盘规范化、路径形状、默认值形状）。
//!
//! 它们没有被补进 `src/settings.rs` 的原因很实际：task-11 的写域是
//! `desktop-tauri/src-tauri/src/shell/**`，`settings.rs` 由 Lead 持有。
//! 而放在这里也说得通——这些语义正是**壳层依赖的契约**：
//! `closeAction` 三档喂给关窗拦截（`mod.rs::current_close_action`），
//! 读写形状喂给 `shell_set_settings` 命令（`commands.rs`）。
//!
//! 用例名里的 `js_case_NN` 直接对应 JS 文件里第 N 个 `it(...)`（自上而下计数），
//! 便于将来有人对着旧文件复核。

#![cfg(test)]

use serde_json::json;

use crate::settings::{
    normalize, read, settings_path, write, ShellSettings, CLOSE_ACTIONS, DEFAULT_CLOSE_ACTION,
    SETTINGS_FILE_NAME,
};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("irouter-shell-settings-contract-{name}"));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// JS case 2：默认值**形状固定**——新增键必须显式登记，不能悄悄长出来。
/// JS 用 `toEqual` 深比全部键；Rust 等价断言是"序列化后恰有这 6 个键 + 值正确"。
///
/// ⚠️ 键数从 5 变 6 是本仓新增的 `locale`（见 `settings.rs` 头注）；
/// 它与 `commands.rs::settings_payload` 额外插入的 `launchAtLogin` / `appVersion` 不同——
/// 那两个是**载荷**字段，不落盘。
#[test]
fn js_case_02_default_shape_is_exactly_the_six_known_keys() {
    let value = serde_json::to_value(ShellSettings::default()).unwrap();
    let map = value.as_object().expect("设置必须是 JSON 对象");
    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "checkUpdates",
            "closeAction",
            "ignoredVersion",
            "lastCheckAt",
            "lastCheckResult",
            "locale"
        ],
        "键集合必须恰好是这 6 个（多一个=新键没登记，少一个=面板读到 undefined）"
    );
    assert_eq!(map["closeAction"], json!("dock"));
    assert_eq!(map["checkUpdates"], json!(true));
    assert_eq!(map["lastCheckAt"], json!(null));
    assert_eq!(map["lastCheckResult"], json!(null));
    assert_eq!(map["ignoredVersion"], json!(null));
    assert_eq!(map["locale"], json!(null), "默认未选择语言");
}

/// JS case 3：更新器相关键**非法类型回退默认，不抛**。
#[test]
fn js_case_03_invalid_updater_key_types_fall_back() {
    let n = normalize(&json!({
        "checkUpdates": "yes",
        "ignoredVersion": 42,
        "lastCheckAt": 123,
        "lastCheckResult": "oops",
    }));
    assert!(n.check_updates, "checkUpdates 非 bool → 默认 true");
    assert_eq!(n.ignored_version, None);
    assert_eq!(n.last_check_at, None);
    assert_eq!(n.last_check_result, None);
}

/// JS case 4：更新器相关键**合法值原样保留**（`normalize` 这一层，不经过写盘）。
#[test]
fn js_case_04_valid_updater_values_are_preserved_by_normalize() {
    let raw = json!({
        "checkUpdates": false,
        "ignoredVersion": "0.3.4",
        "lastCheckAt": "2026-09-30T00:00:00.000Z",
        "lastCheckResult": {"updateAvailable": false},
    });
    let n = normalize(&raw);
    assert!(!n.check_updates);
    assert_eq!(n.ignored_version.as_deref(), Some("0.3.4"));
    assert_eq!(n.last_check_at.as_deref(), Some("2026-09-30T00:00:00.000Z"));
    assert_eq!(n.last_check_result.unwrap()["updateAvailable"], json!(false));
    // 未提及的 closeAction 保持默认
    assert_eq!(n.close_action, "dock");
}

/// JS case 5：三档取值全部合法 + 常量本身与 `/settings` 页面对齐。
#[test]
fn js_case_05_close_action_triple_matches_the_js_constants() {
    assert_eq!(CLOSE_ACTIONS, ["quit", "dock", "tray"]);
    assert_eq!(DEFAULT_CLOSE_ACTION, "dock");
    assert_eq!(SETTINGS_FILE_NAME, "shell-settings.json");
    for action in CLOSE_ACTIONS {
        assert_eq!(normalize(&json!({ "closeAction": action })).close_action, action);
    }
}

/// JS case 6：非法取值回退默认，不抛（含类型不对的 `42` 与 `null`）。
#[test]
fn js_case_06_invalid_close_action_values_fall_back() {
    for bad in [json!("nope"), json!(42), json!(null), json!([]), json!({})] {
        assert_eq!(
            normalize(&json!({ "closeAction": bad })).close_action,
            "dock",
            "closeAction={bad} 应回退默认"
        );
    }
    assert_eq!(normalize(&json!({ "closeAction": "QUIT" })).close_action, "dock", "大小写敏感");
}

/// JS case 7：非对象输入回退默认。
///
/// ⚠️ 与 JS 的一处**必然差异**：JS 里 `undefined` 是独立取值，Rust 的 `serde_json::Value`
/// 没有 undefined——文件读不出来时 `read_raw` 返回 `Value::Null`（`src/settings.rs:60-63`），
/// 所以 `null` 覆盖了 JS 的 `null` 与 `undefined` 两种输入。
#[test]
fn js_case_07_non_object_input_falls_back_to_defaults() {
    for bad in [json!(null), json!([]), json!("quit"), json!(7), json!(true)] {
        let n = normalize(&bad);
        assert_eq!(n.close_action, "dock", "非对象输入 {bad} 应整体回退默认");
        assert!(n.check_updates);
        assert_eq!(n.last_check_at, None);
    }
}

/// JS case 13：目录不存在时写入会创建它（`src/settings.rs:119` 的 `create_dir_all`）。
#[test]
fn js_case_13_write_creates_missing_nested_directory() {
    let base = tmp("mkdir");
    let nested = base.join("a").join("b");
    assert!(!nested.exists(), "前置：目录必须不存在");
    let written = write(&nested, json!({"closeAction": "quit"}));
    assert_eq!(written.close_action, "quit");
    assert_eq!(read(&nested).close_action, "quit", "写入后应能读回");
    let _ = std::fs::remove_dir_all(&base);
}

/// JS case 14：**落盘内容是规范化后的结果，不是原始输入**。
/// JS 用 `closeAction: "bogus"` 验；Rust 侧同样从磁盘原文读回来比对。
#[test]
fn js_case_14_on_disk_content_is_normalized_not_raw() {
    let d = tmp("normalized");
    write(&d, json!({"closeAction": "bogus"}));
    let text = std::fs::read_to_string(settings_path(&d)).unwrap();
    let on_disk: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(on_disk, serde_json::to_value(ShellSettings::default()).unwrap());
    assert!(!text.contains("bogus"), "非法输入不能原样落盘：{text}");
    let _ = std::fs::remove_dir_all(&d);
}

/// JS case 15：文件名固定在 dataDir 下（与 `.gateway.pid` 同类）。
#[test]
fn js_case_15_settings_path_is_fixed_under_data_dir() {
    assert_eq!(
        settings_path(std::path::Path::new("/tmp/x")),
        std::path::Path::new("/tmp/x/shell-settings.json")
    );
    // 数据目录解析（gateway::resolve_data_dir）与本函数的组合形状：`<DATA_DIR>/shell-settings.json`
    assert!(settings_path(std::path::Path::new("/tmp/x")).ends_with("shell-settings.json"));
}

/// **已知的行为差异（有意保留，不是遗漏）**：JS 的 `typeof [] === "object"` 会把**数组**当作
/// 合法的 `lastCheckResult` 保留；Rust 的 `Value::is_object()` 对数组为假 → 丢弃。
///
/// 保留理由：① `lastCheckResult` 的唯一写入方是更新器（写 `CheckResult` 对象），数组不可能出现；
/// ② 丢弃非法形状比原样保留更安全。**若要严格等价，需要改 `src/settings.rs`（Lead 持有）。**
/// 这条测试的作用是把这个差异**钉成显式的**，而不是让它潜伏成"以为对齐了"。
#[test]
fn known_divergence_js_accepts_array_last_check_result_rust_drops_it() {
    let n = normalize(&json!({"lastCheckResult": [1, 2, 3]}));
    assert_eq!(n.last_check_result, None, "Rust 丢弃数组（JS 会保留）");
}
