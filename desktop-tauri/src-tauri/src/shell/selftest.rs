//! 壳层自动化自检接缝（**仅 debug 构建**）。
//!
//! ## 为什么存在
//!
//! 壳层的大部分能力（托盘点击、菜单项、原生对话框）在自动化环境里**点不到**，而 task-7/task-8
//! 证明了两件事：
//!   1. 链路级验证能抓到静态检查抓不到的问题——最典型的是 updater 那条事件：
//!      `emit_to(EventTarget::webview_window("main"))` 与 `AppHandle::listen` 的目标类型不匹配，
//!      事件**静默丢失**，靠"那行日志根本没出现"才发现；
//!   2. 当时的两条缝（`IROUTER_SHELL_SELFTEST_DIALOG` / `IROUTER_SHELL_SELFTEST_QUIT`）都是
//!      **临时加、跑完删**，等于每次重造一遍。
//!
//! 本模块把它们收敛成**单一入口**，由 `npm run verify:shell`（`scripts/verify-shell.mjs`）固化跑。
//!
//! ## 与 Electron 基线的对应关系
//!
//! Phase 4 的出口条件写着「自动化接缝可用」。Electron 版有两条同类东西：
//!   - **`--smoke`**（`desktop/main.js:28`）：端到端自动化开关。本壳也保留了它
//!     （`mod.rs::smoke_mode`，只影响关窗行为：恒走隐藏档，见 `main.js:603-606`）；
//!   - **`IROUTER_IMPORT_DECISION`**（`main.js:1519-1521`）：把"无法自动点击的模态框"
//!     变成可编程决策——正是本模块在做的事（对话框、退出、打开设置都是点不到的模态动作）。
//!
//! 所以这**不是新机制**，而是 Electron 那两条基线在本壳里的等价延续；本模块多做了两件事：
//! 单一环境变量（不让每加一条缝就多一个变量）、以及**只在 debug 构建里存在**。
//!
//! ## 用法
//!
//! ```text
//! IROUTER_SHELL_SELFTEST=update-dialog          # 就绪后触发 request_update_check（监听注册 → updater → 结果 → 弹窗链）
//! IROUTER_SHELL_SELFTEST=quit                   # 就绪后走 window::quit（正常退出路径，等价托盘「退出」）
//! IROUTER_SHELL_SELFTEST=open-settings:updates  # 就绪后走 open_settings(Some("updates"))（补发/分段）
//! IROUTER_SHELL_SELFTEST=open-settings          # 同上，不带分段
//! ```
//!
//! 触发时机**统一在网关就绪后**：即主窗口加载到面板页（host = 127.0.0.1）完成时
//! （`mod.rs` 的插件 `on_page_load` 钩子，与 `flush_pending_open_settings` 同一个信号），
//! **不靠 sleep**。
//!
//! ## 安全边界：只在 debug 构建启用
//!
//! 一个"能触发动作"的环境变量若进了 release，就是**本地任意进程可用的后门**
//! （设置 `IROUTER_SHELL_SELFTEST=quit` 就能让应用退出）。因此整个模块被
//! `#[cfg(debug_assertions)]` 门控：release 下**连字符串字面量都不参与编译**
//! （验证方式与**实测结果**，2026-10-08）：
//!   - 正常 debug 构建：`strings target/debug/irouter | grep -c IROUTER_SHELL_SELFTEST` → **1**；
//!   - `cargo rustc --bin irouter -- -C debug-assertions=off`（等价 release 的 cfg，只重编本 crate，
//!     无需 release 全量构建）：同一条命令 → **0**。
//! 即"环境变量字面量随模块一起从产物里消失"是**实测**的，不是推断。
//! `verify-shell.mjs` 的 R1 在 debug 侧断言这一点；**真正的 release 产物建议由 CI 加同一行断言**
//! （三平台产物都已现成，见 `.github/workflows/desktop-tauri.yml`）。

use tauri::AppHandle;

/// 环境变量名（**只在 debug 构建里存在这个字面量**，见模块头"安全边界"）。
#[cfg(debug_assertions)]
pub const ENV: &str = "IROUTER_SHELL_SELFTEST";

/// 面板页加载完成（= 网关就绪）后调用。**只触发一次**，忽略后续页面加载。
///
/// release 构建下是空函数（调用点仍然存在，但里面什么都不做、也没有可触发的代码路径）。
#[cfg(not(debug_assertions))]
pub fn on_panel_ready(_app: &AppHandle, _webview_label: &str) {}

#[cfg(debug_assertions)]
pub fn on_panel_ready(app: &AppHandle, webview_label: &str) {
    use std::sync::atomic::{AtomicBool, Ordering};

    static FIRED: AtomicBool = AtomicBool::new(false);

    if webview_label != super::window::MAIN_WINDOW {
        return;
    }
    // 「网关就绪后」的判据与 `flush_pending_open_settings` 一致：只有面板页（127.0.0.1）算就绪，
    // 兜底页（tauri://localhost）不算。
    if !super::commands::panel_ready(app) {
        return;
    }
    let Ok(spec) = std::env::var(ENV) else {
        return;
    };
    if spec.trim().is_empty() {
        return;
    }
    if FIRED.swap(true, Ordering::SeqCst) {
        return; // 只触发一次（导航/重载会再来 page load）
    }

    log::info!("[selftest] 网关就绪，触发场景 {spec:?}");
    let Some(scenario) = parse(&spec) else {
        log::warn!("[selftest] 无法识别的场景 {spec:?}（可用：update-dialog / quit / open-settings[:section]）");
        return;
    };

    match scenario {
        Scenario::UpdateDialog => {
            // 走的就是托盘/菜单「检查更新…」的入口：注册结果监听 → 打标记 → 发
            // `shell:check-update-requested`；updater 跑检查后发 `shell:update-available`，
            // 监听器命中后弹结果对话框（三段分支见 `dialogs::plan`）。
            super::commands::request_update_check(app);
        }
        Scenario::Quit => {
            // 等价托盘「退出」：置 quitting → kill 网关进程树 → AppHandle::exit(0)。
            super::window::quit(app);
        }
        Scenario::OpenSettings(section) => {
            super::commands::open_settings(app, section.as_deref());
        }
    }
}

/// 场景解析。写成独立纯函数是为了能单测（`parse` 的失败分支也要有用例）。
#[cfg(debug_assertions)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scenario {
    UpdateDialog,
    Quit,
    OpenSettings(Option<String>),
}

#[cfg(debug_assertions)]
pub fn parse(spec: &str) -> Option<Scenario> {
    let spec = spec.trim();
    match spec {
        "update-dialog" => Some(Scenario::UpdateDialog),
        "quit" => Some(Scenario::Quit),
        "open-settings" => Some(Scenario::OpenSettings(None)),
        other => other.strip_prefix("open-settings:").and_then(|section| {
            // 空分段不当作合法场景：`open-settings:` 静默变成"无分段"会掩盖脚本里的拼写错误。
            if section.is_empty() {
                None
            } else {
                Some(Scenario::OpenSettings(Some(section.to_string())))
            }
        }),
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;

    #[test]
    fn parses_the_three_documented_scenarios() {
        assert_eq!(parse("update-dialog"), Some(Scenario::UpdateDialog));
        assert_eq!(parse("quit"), Some(Scenario::Quit));
        assert_eq!(
            parse("open-settings:updates"),
            Some(Scenario::OpenSettings(Some("updates".to_string())))
        );
        assert_eq!(parse("open-settings"), Some(Scenario::OpenSettings(None)));
        // 前后空白容错（环境变量里常有人带空格）
        assert_eq!(parse("  quit  "), Some(Scenario::Quit));
    }

    #[test]
    fn rejects_unknown_scenarios_instead_of_guessing() {
        assert_eq!(parse("nope"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse("quit:now"), None);
        // 空分段也算未知：避免 `open-settings:` 静默退化成"无分段"
        assert_eq!(parse("open-settings:"), None);
    }
}
