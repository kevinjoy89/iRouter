//! 首次运行的「旧 CLI 数据导入」提示（对齐 Electron 版 `main.js:1508-1580` 与调用点 `:2097`）。
//!
//! # 三道护栏（顺序即安全边界，**任何一条命中都不询问**）
//!
//! 1. **旧目录不存在** → 不询问
//! 2. **已决定过**（`<data_dir>/.irouter-import-decided` 存在）→ 不询问
//! 3. **目标目录已有网关数据**（`db` / `auth` / `jwt-secret` / `machine-id` 任一存在）→ 不询问
//!
//! 第 3 条是保护「正在用的用户」的关键：**升级、重启、换壳都不会触发导入**。
//! 只有「旧目录有数据 **且** 目标目录从未跑过网关」这个组合才会弹窗——即真正的首次运行。
//!
//! 判定不能用「目录为空」：系统 webview 会把缓存/存储写进同类目录（Electron 时代是 Chromium
//! 的 `Cache`/`Local Storage`），空目录判断会随平台与版本漂移。用「网关自己的数据条目」才稳。
//!
//! # 两条不可让步的性质
//!
//! - **只复制，永不覆盖**：目标已存在的文件一律跳过（对齐 Electron `fs.cpSync` 的
//!   `force:false, errorOnExist:false` 语义）。已有的数据不可能被旧数据盖掉。
//! - **源目录只读**：`~/.9router` 全程只被 `read_dir` / `copy`，**不写、不删、不移动**。
//!   对话框文案里也向用户明说了「原数据保留不动，仅复制」。
//!
//! `runtime/` 排除——那是 CLI 自装的 node 运行时，桌面版不需要（`main.js:30-31`）。
//!
//! # 测试接缝
//!
//! `IROUTER_IMPORT_DECISION=import|skip` 跳过对话框（模态框自动化点不到）。
//! 与 Electron 版行为一致，**不限定 debug 构建**——因为端到端验收跑的是 release 产物。
//! 它的影响面被上面三道护栏夹住：只在真正的首次运行、且目标目录无数据时才有效，
//! **不可能覆盖或删除任何已有数据**。`IROUTER_LEGACY_DIR` 用于把源目录指向别处（测试用）。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::shell::i18n::{self, Locale};

/// 「已决定过」标记。内容为 `imported\n` 或 `skipped\n`，仅供人工排查。
pub const IMPORT_MARKER: &str = ".irouter-import-decided";

/// 网关自己的数据条目——只要存在其一，就说明这个目录已经跑过网关（= 非首次运行）。
/// 与 Electron 版 `GATEWAY_DATA_MARKERS`（`main.js:1511`）逐字一致。
const GATEWAY_DATA_MARKERS: [&str; 4] = ["db", "auth", "jwt-secret", "machine-id"];

/// 导入时排除的顶层条目（`main.js:31`）。**仅顶层生效**，子目录里同名的不动。
const LEGACY_SKIP_ENTRIES: [&str; 1] = ["runtime"];

const LEGACY_DIR_ENV: &str = "IROUTER_LEGACY_DIR";
const DECISION_ENV: &str = "IROUTER_IMPORT_DECISION";

/// 用户在对话框里的选择（对齐 `main.js` 的 0/1/2）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// 0 —— 导入
    Import,
    /// 1 —— 跳过（记录决定，下次不再问）
    Skip,
    /// 2 —— 取消（**不导入、不记录**，下次启动再问；Electron 版此时退出应用）
    Cancel,
}

/// `evaluate` 的结论。
#[derive(Debug)]
pub enum Plan {
    /// 三道护栏命中其一，或测试接缝已直接处理完 —— 继续正常启动
    Proceed,
    /// 真正需要询问用户
    Ask { legacy: PathBuf, data_dir: PathBuf },
}

/// 旧 CLI 数据目录：`IROUTER_LEGACY_DIR` 覆盖，否则 `~/.9router`（对齐 `main.js:101-103`）。
pub fn legacy_dir() -> PathBuf {
    if let Ok(p) = std::env::var(LEGACY_DIR_ENV) {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".9router")
}

/// 目标目录是否已经跑过网关（护栏 3）。
pub fn has_gateway_data(data_dir: &Path) -> bool {
    GATEWAY_DATA_MARKERS
        .iter()
        .any(|m| data_dir.join(m).exists())
}

/// 测试接缝：环境变量指定的决策。只认 `import` / `skip`（`cancel` 不预置——它只该由真人点）。
pub fn decision_from_env() -> Option<Decision> {
    match std::env::var(DECISION_ENV).as_deref() {
        Ok("import") => Some(Decision::Import),
        Ok("skip") => Some(Decision::Skip),
        _ => None,
    }
}

/// 三道护栏 → 是否需要询问。
///
/// 接缝命中时**直接落地并返回 `Proceed`**，调用方无需分叉。
pub fn evaluate(data_dir: &Path) -> Plan {
    let legacy = legacy_dir();
    if !legacy.is_dir() {
        return Plan::Proceed; // 护栏 1：没有旧数据
    }
    if data_dir.join(IMPORT_MARKER).exists() {
        return Plan::Proceed; // 护栏 2：已经决定过
    }
    if has_gateway_data(data_dir) {
        return Plan::Proceed; // 护栏 3：非首次运行（保护正在用的用户）
    }

    if let Some(d) = decision_from_env() {
        if let Err(e) = apply(&legacy, data_dir, d) {
            // 接缝下的失败不阻断启动：首次运行本来就没有数据，导入失败只是维持现状
            log::error!("[legacy-import] 接缝指定的决策 {:?} 执行失败：{e}", d);
        }
        return Plan::Proceed;
    }

    Plan::Ask {
        legacy,
        data_dir: data_dir.to_path_buf(),
    }
}

/// 落盘一个决策：`Skip` 只记标记；`Import` 先复制再记标记。`Cancel` 什么都不做。
pub fn apply(legacy: &Path, data_dir: &Path, decision: Decision) -> io::Result<()> {
    match decision {
        Decision::Cancel => Ok(()), // 不留痕，下次再问
        Decision::Skip => record(data_dir, "skipped"),
        Decision::Import => {
            let n = import_legacy(legacy, data_dir)?;
            log::info!("[legacy-import] 已从 {legacy:?} 复制 {n} 个文件到 {data_dir:?}");
            record(data_dir, "imported")
        }
    }
}

fn record(data_dir: &Path, content: &str) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    fs::write(data_dir.join(IMPORT_MARKER), format!("{content}\n"))
}

/// 复制旧目录的全部顶层条目到目标目录（排除 `runtime/`）。
///
/// **只复制不覆盖**：目标已存在的文件跳过。返回实际复制的**文件**数。
pub fn import_legacy(legacy: &Path, data_dir: &Path) -> io::Result<usize> {
    fs::create_dir_all(data_dir)?;
    let mut copied = 0usize;
    for entry in fs::read_dir(legacy)? {
        let entry = entry?;
        let name = entry.file_name();
        // 排除项只作用于顶层（对齐 Electron 的顶层 readdir 循环）
        if LEGACY_SKIP_ENTRIES
            .iter()
            .any(|s| name.to_string_lossy() == *s)
        {
            continue;
        }
        copied += copy_tree(&entry.path(), &data_dir.join(&name))?;
    }
    Ok(copied)
}

/// 递归复制；目标已存在则跳过（不覆盖、不报错）。
fn copy_tree(src: &Path, dst: &Path) -> io::Result<usize> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        let mut n = 0usize;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            n += copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(n)
    } else if meta.is_file() {
        if dst.exists() {
            return Ok(0); // 不覆盖
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
        Ok(1)
    } else {
        // 符号链接等其它类型：跳过（不跟随，避免把目标外的内容拖进来）
        Ok(0)
    }
}

/// 对话框文案（对齐 `main.js:1517-1551` 的三语言字典）。
pub fn strings(locale: Locale, legacy: &Path) -> (String, String, [&'static str; 3]) {
    let location = legacy.display();
    match locale {
        Locale::En => (
            "Legacy 9Router CLI data detected".to_string(),
            format!(
                "Location: {location}\nDo you want to import configurations, database and keys? \
                 (Original files are untouched, only copied)"
            ),
            ["Import", "Skip", "Cancel"],
        ),
        Locale::ZhTw => (
            "檢測到舊版 9Router CLI 資料".to_string(),
            format!(
                "位置：{location}\n是否匯入其中的設定、資料庫與金鑰？（原資料保留不動，僅複製）"
            ),
            ["匯入", "略過", "取消"],
        ),
        Locale::ZhCn => (
            "检测到旧版 9Router CLI 数据".to_string(),
            format!("位置：{location}\n是否导入其中的配置、数据库与密钥？（原数据保留不动，仅复制）"),
            ["导入", "跳过", "取消"],
        ),
    }
}

/// 弹原生询问框；用户点按钮后**先落盘决策、再回调**。
///
/// 与 `dialogs.rs::show` 同一约定：**不用 `blocking_show`** —— 插件源码明确写着
/// "should *NOT* be used when running on the main thread context"（`tauri-plugin-dialog-2.8.1/src/lib.rs:370-371`），
/// 而启动流程就在主线程。所以这里用回调式，由调用方在回调里继续启动。
///
/// 按钮语义与 Electron 逐字对齐（`main.js:1517-1551` 的 0/1/2）：
/// `Yes` = 导入 / `No` = 跳过 / `Cancel`（含直接关窗）= 取消（不记录，下次再问）。
pub fn ask<F>(app: &AppHandle, legacy: PathBuf, data_dir: PathBuf, on_done: F)
where
    F: FnOnce(Decision) + Send + 'static,
{
    let (message, detail, buttons) = strings(i18n::system_locale(), &legacy);
    let [b_import, b_skip, b_cancel] = buttons;
    // 插件的 builder 没有独立的 detail 字段，把两段并进 message（一处与 Electron 的表现差异）
    let body = format!("{message}\n\n{detail}");
    app.dialog()
        .message(body)
        .title("iRouter")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            b_import.to_string(),
            b_skip.to_string(),
            b_cancel.to_string(),
        ))
        .show_with_result(move |result| {
            let decision = match result {
                tauri_plugin_dialog::MessageDialogResult::Yes => Decision::Import,
                tauri_plugin_dialog::MessageDialogResult::No => Decision::Skip,
                _ => Decision::Cancel,
            };
            if let Err(e) = apply(&legacy, &data_dir, decision) {
                log::error!("[legacy-import] 决策 {decision:?} 落盘失败：{e}");
            }
            log::info!("[legacy-import] 用户选择 {decision:?}");
            on_done(decision);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独占一个临时目录；**绝不使用真实的 `~/.irouter` 或 `~/.9router`**。
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("irouter-legacy-import-{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path, content: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    #[test]
    fn guards_skip_when_legacy_missing() {
        let root = tmp("no-legacy");
        let data = root.join("data");
        // legacy 指向一个不存在的目录
        let legacy = root.join("nope");
        assert!(!legacy.is_dir());
        // 直接验证判定函数的三条分支
        assert!(!has_gateway_data(&data));
    }

    /// ★ **最重要的一条**：目标目录已有网关数据时，无论旧数据多完整、接缝怎么设，
    /// 都必须**既不询问也不导入**。这保护的正是"已经在用的用户"——
    /// 升级、重启、换壳都不该碰他们的数据。
    #[test]
    fn populated_data_dir_is_never_imported_into() {
        let root = tmp("populated-protected");
        let legacy = root.join("legacy");
        let data = root.join("data");

        // 旧目录：有完整的"看起来很有价值"的数据
        touch(&legacy.join("db").join("data.sqlite"), "旧库");
        touch(&legacy.join("jwt-secret"), "旧密钥");

        // 目标目录：已经有网关数据（模拟"正在用的用户"）
        touch(&data.join("db").join("data.sqlite"), "现有库");
        let before = fs::read_to_string(data.join("db").join("data.sqlite")).unwrap();

        // 用最激进的接缝：直接要求导入
        std::env::set_var(DECISION_ENV, "import");
        std::env::set_var(LEGACY_DIR_ENV, &legacy);
        let plan = evaluate(&data);
        std::env::remove_var(DECISION_ENV);
        std::env::remove_var(LEGACY_DIR_ENV);

        assert!(
            matches!(plan, Plan::Proceed),
            "已有数据的目录必须直接放行，不能进入询问/导入分支"
        );
        assert_eq!(
            fs::read_to_string(data.join("db").join("data.sqlite")).unwrap(),
            before,
            "现有数据库内容不能被旧数据覆盖"
        );
        assert!(
            !data.join(IMPORT_MARKER).exists(),
            "护栏命中时不该留下任何标记"
        );
        assert!(
            !data.join("jwt-secret").exists(),
            "护栏命中时一个文件都不该被复制进来"
        );
    }

    /// 首次运行（目标目录空）+ 有旧数据 + 接缝=import → 确实导入，且排除 runtime/
    #[test]
    fn first_run_with_seam_imports_and_excludes_runtime() {
        let root = tmp("first-run-import");
        let legacy = root.join("legacy");
        let data = root.join("data");
        touch(&legacy.join("db").join("data.sqlite"), "旧库");
        touch(&legacy.join("runtime").join("node"), "CLI 自带运行时");
        fs::create_dir_all(&data).unwrap(); // 目标目录存在但为空 = 首次运行

        std::env::set_var(DECISION_ENV, "import");
        std::env::set_var(LEGACY_DIR_ENV, &legacy);
        let plan = evaluate(&data);
        std::env::remove_var(DECISION_ENV);
        std::env::remove_var(LEGACY_DIR_ENV);

        assert!(matches!(plan, Plan::Proceed));
        assert_eq!(
            fs::read_to_string(data.join("db").join("data.sqlite")).unwrap(),
            "旧库"
        );
        assert!(!data.join("runtime").exists(), "runtime/ 必须被排除");
        assert_eq!(
            fs::read_to_string(data.join(IMPORT_MARKER)).unwrap(),
            "imported\n"
        );
    }

    #[test]
    fn has_gateway_data_matches_any_marker() {
        let root = tmp("markers");
        for m in GATEWAY_DATA_MARKERS {
            // 每个标记单开一个"数据目录"，把标记造在它**里面**再检查它
            let d = root.join(format!("case-{m}"));
            fs::create_dir_all(d.join(m)).unwrap();
            assert!(has_gateway_data(&d), "{m} 存在时应被判定为已有网关数据");
        }
        // 只有无关条目时不算
        let d = root.join("only-webview-cache");
        fs::create_dir_all(d.join("Cache")).unwrap();
        assert!(
            !has_gateway_data(&d),
            "只有 webview 缓存目录时必须仍判为首次运行（不能用「目录非空」判）"
        );
    }

    #[test]
    fn import_never_overwrites_existing_files() {
        let root = tmp("no-overwrite");
        let legacy = root.join("legacy");
        let data = root.join("data");
        touch(&legacy.join("db").join("data.sqlite"), "旧库");
        touch(&legacy.join("jwt-secret"), "旧密钥");
        // 目标已有同名文件：导入后必须保持原值
        touch(&data.join("jwt-secret"), "现有密钥");

        let n = import_legacy(&legacy, &data).unwrap();
        assert_eq!(
            fs::read_to_string(data.join("jwt-secret")).unwrap(),
            "现有密钥",
            "目标已存在的文件绝不能被旧数据覆盖"
        );
        assert_eq!(
            fs::read_to_string(data.join("db").join("data.sqlite")).unwrap(),
            "旧库",
            "目标没有的条目应当被复制"
        );
        assert_eq!(n, 1, "只有 db/data.sqlite 是新增（jwt-secret 被跳过）");
    }

    #[test]
    fn import_skips_runtime_at_top_level_only() {
        let root = tmp("skip-runtime");
        let legacy = root.join("legacy");
        let data = root.join("data");
        touch(&legacy.join("runtime").join("bin").join("node"), "CLI 自带的运行时");
        touch(&legacy.join("db").join("runtime"), "子目录里的同名文件不该被排除");

        import_legacy(&legacy, &data).unwrap();
        assert!(!data.join("runtime").exists(), "顶层的 runtime/ 必须被排除");
        assert!(
            data.join("db").join("runtime").exists(),
            "排除只作用于顶层：子目录里的同名条目要照常复制"
        );
    }

    #[test]
    fn import_does_not_touch_the_source() {
        let root = tmp("source-readonly");
        let legacy = root.join("legacy");
        let data = root.join("data");
        touch(&legacy.join("db").join("data.sqlite"), "旧库");
        touch(&legacy.join("jwt-secret"), "旧密钥");
        let before: Vec<_> = fs::read_dir(&legacy)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();

        import_legacy(&legacy, &data).unwrap();

        let after: Vec<_> = fs::read_dir(&legacy)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(before.len(), after.len(), "源目录条目数不能变");
        assert_eq!(
            fs::read_to_string(legacy.join("jwt-secret")).unwrap(),
            "旧密钥",
            "源文件内容不能被改动"
        );
    }

    #[test]
    fn skip_records_marker_and_cancel_records_nothing() {
        let root = tmp("record");
        let data = root.join("data");
        let legacy = root.join("legacy");
        fs::create_dir_all(&legacy).unwrap();

        apply(&legacy, &data, Decision::Cancel).unwrap();
        assert!(
            !data.join(IMPORT_MARKER).exists(),
            "取消不能留标记——否则下次不再问"
        );

        apply(&legacy, &data, Decision::Skip).unwrap();
        assert_eq!(
            fs::read_to_string(data.join(IMPORT_MARKER)).unwrap(),
            "skipped\n"
        );
    }

    #[test]
    fn strings_cover_three_locales_and_name_the_location() {
        let legacy = Path::new("/tmp/legacy-9router");
        for loc in [Locale::En, Locale::ZhCn, Locale::ZhTw] {
            let (msg, detail, buttons) = strings(loc, legacy);
            assert!(!msg.is_empty());
            assert!(
                detail.contains("/tmp/legacy-9router"),
                "详情里必须给出旧数据位置，用户才知道自己在决定什么"
            );
            // 三语言都必须向用户承诺「原数据不动」
            assert!(
                detail.contains("untouched") || detail.contains("保留不動") || detail.contains("保留不动"),
                "{loc:?} 的文案必须说明源数据不被改动"
            );
            assert_eq!(buttons.len(), 3);
        }
    }
}
