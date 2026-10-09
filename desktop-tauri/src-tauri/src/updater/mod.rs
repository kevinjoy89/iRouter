//! 应用内更新：检查 / 下载 / 校验 / 交系统安装器。
//!
//! **owner: updater 任务**。本文件与 `src/updater/**` 之外的任何文件都不要改。
//!
//! 参照实现是 `desktop/updater/*.js`（774 行，**行为等价表**见
//! `docs/plans/2026-10-07-updater-port-design.md`，1047 行）。移植前先把那张表读完——
//! 更新器出错等于已安装用户**永久断更**。
//!
//! ## 事件契约：五条硬约束（违反任何一条都会让面板静默出错）
//!   1. 真正的硬约束是 **`window.irouterShell` 的存在性**：为假则面板「软件更新」整段消失
//!      （`ShellSettingsModal.js:66-70`）。事件名属壳内实现，但仍**按同名设计**（零成本且与基线一致）。
//!   2. `shell:update-error` 的 payload 是**裸字符串**（`main.js:749,768` 都是 `err.message`），
//!      面板直接渲染成文案（`UpdateSettings.js:53-56,303-305`）→ Rust 必须 emit `String`，
//!      发对象会显示 `[object Object]`。
//!   3. **检查失败永不发 `update-error`**——错误装在 `shell:update-available` 的 `error` 字段里
//!      （`main.js:825-836` 恒发 available）。Rust 若把检查失败也 emit 成 error，面板会同时收到
//!      两条 → 状态竞态。
//!   4. shim 的 **unlisten 必须同步返回**：Tauri 的 `listen()` 是 async（返回
//!      `Promise<UnlistenFn>`），而面板写的是 `unsubX?.()`（`UpdateSettings.js:72-77`）——
//!      返回 Promise 会**静默不执行**，监听器泄漏、反复打开设置会叠加回调。
//!      设计里给了「一次 listen + 本地 Set 分发」的写法绕开竞态（§7）。
//!   5. 面板真正读取的字段只有 7 个：`res.updateAvailable / error / latest / assetSize /
//!      releaseURL`、`progress.percent`、`downloadInfo.isArchive`；其余**仍建议原样发**
//!      （面板是独立构建，可能比壳新）。
//!
//! ## 退出顺序（updater 设计 §10.3）
//! 安装器在 Windows 上走 RestartManager `RmForceShutdown` 强杀，**绕过一切 Rust 退出钩子**。
//! 因此顺序必须是：**先回收 sidecar → 再调起安装器（失败就 rollback 且不退出）→
//! `AppHandle::exit(0)`**。**绝不能用 `std::process::exit`**——它什么都不跑，
//! 还会漏掉 `single_instance::destroy`。
//!
//! ---
//!
//! # 落地结构（本目录 = `desktop/updater/index.js` 的 `pub use` 平铺）
//!
//! | 文件 | 对应 JS | 说明 |
//! | --- | --- | --- |
//! | `version.rs` | `version.js` | 数字三元组比较，**不用 semver** |
//! | `asset.rs` | `asset.js` | 产物名精确匹配 + Linux 对等形态回退 |
//! | `checksum.rs` | `checksum.js` | 流式 SHA-256（64 KiB）+ sha256sum 解析 |
//! | `checker.rs` | `checker.js` | GitHub Releases，**永不 reject** |
//! | `download.rs` | `download.js` | `.part` → rename，取消删 `.part` |
//! | `installer.rs` | `installer.js` | `tauri-plugin-opener`（**D-5 修正**） |
//! | `http.rs` | （两处内联） | 手动跟随重定向 + 超时/文案 |
//! | `clock.rs` | `Date` | ISO-8601 生成/解析，无日期库 |
//! | `state.rs` | `main.js:45-47` | 三个进程内存态 |
//! | `events.rs` | `main.js` 的 4 处 send | 4 个事件 + 进度节流 |
//! | `commands.rs` | `main.js:704-878` | 5 个 IPC + `triggerUpdateCheck` + 启动检查 |
//! | `shim.js` | `preload.js:10-62` | 注入面板的 `window.irouterShell` |
//!
//! ## 接线（`main.rs` 由 Lead 负责，本目录不碰它）
//! ```ignore
//! // 1) Builder：注册 5 个命令
//! .invoke_handler(tauri::generate_handler![
//!     updater::commands::shell_check_update,
//!     updater::commands::shell_download_update,
//!     updater::commands::shell_cancel_download,
//!     updater::commands::shell_install_update,
//!     updater::commands::shell_ignore_version,
//! ])
//! // 2) 两个建窗点都要注入 shim（否则「软件更新」整段消失，契约 1）
//! .initialization_script(updater::shim_js())
//! ```
//! capability 侧需要 `core:event:allow-listen` / `allow-unlisten` + 5 个
//! `allow-shell_*`（远端 origin 的自定义命令**必须**显式授权，见 `main.rs` 的 build.rs
//! app manifest）。
//!
//! ## 有意偏差（都已登记，不要"顺手改回去"）
//!   - **D-2 修**：校验失败只发一次 `shell:update-error`（现在发两次，面板幂等，不可见）。
//!   - **D-3 照抄**：取消下载仍 emit error + reject（Lead 签字）。
//!   - **D-4 照抄**：没有 `checksums.txt` 就跳过校验（Lead 签字，洞在发布侧 CI 堵）。
//!   - **D-5 修**：安装器调起失败 → 返回 Err、**不退出应用**。
//!   - 错误文案：Node fs/网络原始错误无法逐字复刻（见 `error.rs` 文件头）。

use tauri::{AppHandle, Manager};

pub mod asset;
pub mod checker;
pub mod checksum;
pub mod clock;
pub mod commands;
pub mod download;
pub mod error;
pub mod events;
pub mod http;
pub mod installer;
mod jscompat;
pub mod state;
pub mod version;

#[cfg(test)]
mod testserver;

// ---- barrel：对应 `desktop/updater/index.js:16-22` 的平铺导出（6 个模块无同名导出）----
//
// 二进制 crate 里没人引用这些名字就会有 unused_imports 警告；它们的存在意义是
// "调用点只依赖一个模块"（`desktop/main.js:24` 只 require 一次）。接线后 main.rs
// 会用到其中一部分，其余留给后续（例如菜单对话框）。
#[allow(unused_imports)]
pub use asset::{expected_asset_name, select_asset, ReleaseAsset};
#[allow(unused_imports)]
pub use checker::{
    check_for_updates, CheckOptions, CheckResult, Fetcher, HttpFetcher, DEFAULT_RELEASE_PAGE,
    GITHUB_REPO, RELEASES_API_URL,
};
#[allow(unused_imports)]
pub use checksum::{parse_checksums, verify_file_sha256};
#[allow(unused_imports)]
pub use clock::{iso8601_from_unix_ms, now_iso8601, now_unix_ms, parse_iso8601_ms};
#[allow(unused_imports)]
pub use commands::{
    arch_str, platform_str, shell_cancel_download, shell_check_update, shell_download_update,
    shell_ignore_version, shell_install_update, trigger_update_check, CheckSource,
};
#[allow(unused_imports)]
pub use download::{
    cancel_channel, default_downloads_dir, download_file, fetch_text, CancelSignal, DownloadHandle,
    DownloadOptions, DownloadProgress,
};
#[allow(unused_imports)]
pub use error::UpdaterError;
#[allow(unused_imports)]
pub use events::{DownloadedInfo, EV_AVAILABLE, EV_DOWNLOADED, EV_ERROR, EV_PROGRESS};
#[allow(unused_imports)]
pub use installer::{is_archive_package, open_installer};
#[allow(unused_imports)]
pub use state::UpdaterState;
#[allow(unused_imports)]
pub use version::{compare_versions, has_new_version, parse_version, VersionTriple};

/// 注入到 webview 的 shim 源码（`window.irouterShell`，等价 `preload.js`）。
///
/// 调试/资源检查用；**接线请用 [`shim_js`]**，它会把平台字面量一并注入。
pub const SHIM_JS: &str = include_str!("shim.js");

/// 带平台注入的 shim。平台取自 `std::env::consts::OS`（不是 `navigator.platform` 猜的）。
pub fn shim_js() -> String {
    format!(
        "window.__IROUTER_PLATFORM__={:?};\n{}",
        commands::platform_str(),
        SHIM_JS
    )
}

/// 由 `main.rs` 在 setup 阶段调用。**不得阻塞启动**。
///
/// 只做四件事：托管 `UpdaterState`（含 HTTP 客户端）、挂托盘/菜单的「检查更新」事件监听、
/// 起 3s 后的静默检查任务、记日志。网络/磁盘 I/O 全在任务里。
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    if app.try_state::<UpdaterState>().is_none() {
        app.manage(UpdaterState::new());
    }
    commands::listen_for_check_requests(app);
    commands::spawn_auto_check(app);
    log::info!(
        "updater 模块已装载：5 个 IPC 命令 + 4 个事件 + {} 监听 + 启动期静默检查（3s）",
        events::EV_CHECK_REQUESTED
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_js_injects_the_platform_and_keeps_the_abi() {
        let js = shim_js();
        assert!(
            js.contains(&format!(
                "window.__IROUTER_PLATFORM__={:?};",
                commands::platform_str()
            )),
            "shim 必须注入 Rust 侧的平台真值"
        );
        // 面板读的 7 个入口一个都不能少（方法名不可改）
        for name in [
            "checkUpdate",
            "downloadUpdate",
            "cancelDownload",
            "installUpdate",
            "ignoreVersion",
            "onUpdateProgress",
            "onUpdateAvailable",
            "onUpdateDownloaded",
            "onUpdateError",
            "platform",
        ] {
            assert!(js.contains(name), "shim 缺少 {name}");
        }
        // 4 个事件名逐字一致
        for ev in [EV_PROGRESS, EV_AVAILABLE, EV_DOWNLOADED, EV_ERROR] {
            assert!(js.contains(ev), "shim 缺少事件 {ev}");
        }
        // 存在性 + 合并（绝不整体覆盖）
        assert!(js.contains("window.irouterShell = shell"));
        assert!(js.contains("window.irouterShell"));
    }

    #[test]
    fn shim_unlisten_is_synchronous() {
        // 契约 4 的结构性断言：shim 里必须是"返回函数"而不是"返回 listen() 的 Promise"
        let js = SHIM_JS;
        assert!(
            js.contains("return function off()"),
            "onUpdate* 必须同步返回取消函数（返回 Promise → 面板 ?.() 静默不执行）"
        );
        assert!(
            !js.contains("return bridge.listen") && !js.contains("return listen("),
            "不得把 async listen 的结果直接返回给面板"
        );
        assert!(
            js.contains("listeners[event] = []"),
            "必须是本地 Set/数组分发，而不是每次订阅都 listen 一次"
        );
    }
}
