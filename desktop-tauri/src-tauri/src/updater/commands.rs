//! IPC 命令 + `triggerUpdateCheck`（设计 §2.8 / §7.3 / §10.3）。
//!
//! 5 个命令名 = Rust 函数名原样（`tauri-macros` 默认 `RenamePolicy::Keep`），
//! 参数按 camelCase 从 JS payload 取值（都是单词，两侧一致）：
//!
//! | shim 方法 | 命令 | 返回 |
//! | --- | --- | --- |
//! | `checkUpdate(force)` | `shell_check_update` | `CheckResult`（错误在结构体里） |
//! | `downloadUpdate()` | `shell_download_update` | `DownloadedInfo` |
//! | `cancelDownload()` | `shell_cancel_download` | `bool` |
//! | `installUpdate()` | `shell_install_update` | `true` |
//! | `ignoreVersion(v)` | `shell_ignore_version` | `true` |
//!
//! ## 退出顺序（**别写反**，设计 §10.3）
//!
//! ```text
//! shell_install_update:
//!   1) 先回收 sidecar（gateway::Gateway::kill）
//!   2) 再调起安装器 —— 失败就返回 Err：**不退出**、不动状态（D-5）
//!   3) 成功才 tokio::sleep(500ms) → AppHandle::exit(0)
//! ```
//!
//! 为什么"先 kill"：Windows 安装器走 RestartManager `RmForceShutdown` **强杀**本进程，
//! 绕过一切 Rust 退出钩子（`RunEvent::Exit` 不会跑）→ 若等到退出时才回收，用户机器上会留下
//! 常驻的孤儿网关进程并占住端口。
//!
//! **绝不能用 `std::process::exit`**：它什么都不跑（`App::cleanup_before_exit` 被跳过），
//! 还会漏掉 `single_instance::destroy` —— 下次启动会误判"已有实例"。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use super::checker::{check_for_updates, CheckOptions, CheckResult, HttpFetcher};
use super::checksum::{parse_checksums, verify_file_sha256};
use super::clock;
use super::download::{self, CancelSignal, DownloadOptions, DownloadProgress};
use super::error::UpdaterError;
use super::events::{self, DownloadedInfo, ProgressThrottle};
use super::installer;
use super::state::UpdaterState;
use crate::settings;

/// `triggerUpdateCheck(force, {source})` 的来源（`main.js:814`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckSource {
    /// 面板 `shell_check_update`（`UpdateSettings.js:62,88`）
    Renderer,
    /// 菜单/托盘（`force=true` 时会弹原生对话框——**本模块未实现，见文件头 gap 说明**）
    Menu,
    /// 启动 3s 后的静默检查（`main.js:2127-2135`）
    AutoCheck,
}

/// 与 `process.platform` 对齐（`std::env::consts::OS` 的映射，见设计 §6.3）。
pub fn platform_str() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// 与 `process.arch` 对齐。
pub fn arch_str() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        "arm" => "arm",
        other => other,
    }
}

/// 触发一次版本检查（`main.js:814-878`）。
///
/// 副作用顺序照抄：写回 `shell-settings.json`（仅 `!error` 时）→ 内存 `latestCheckedUpdate`
/// → 发 `shell:update-available`。
///
/// ⚠️ **已知 gap（诚实登记，不猜）**：`main.js:839-875` 的"菜单来源 + force → 原生对话框"
/// 这一段**未实现**。它需要 `tauri-plugin-dialog`（Cargo.toml 里没有）、菜单 i18n 文案
/// （shell 模块的 `getMenuI18n`）与 `openSettings("updates")`——三者都不在本模块写域内。
/// 见交付简报的 unverified 清单。
pub async fn trigger_update_check(app: &AppHandle, force: bool, source: CheckSource) -> CheckResult {
    let version = app.package_info().version.to_string();
    let data_dir = crate::gateway::resolve_data_dir(app).ok();

    let result = match data_dir.as_ref() {
        None => {
            let mut r = CheckResult::initial(Some(&version));
            r.error = Some("无法解析数据目录，已跳过更新检查".to_string());
            r
        }
        Some(dir) => {
            let snapshot = settings::read(dir);
            let client = app
                .try_state::<UpdaterState>()
                .map(|s| s.client())
                .unwrap_or_else(|| reqwest::Client::new());
            let fetcher = HttpFetcher::new(client);
            let opts = CheckOptions {
                current_version: Some(&version),
                platform: platform_str(),
                arch: arch_str(),
                // 生产从不传 installSource（`main.js:817-823`）——照抄，见设计 §6.3
                install_source: None,
                force,
                last_check_at: snapshot.last_check_at.as_deref(),
                last_check_result: snapshot.last_check_result.as_ref(),
                ignored_version: snapshot.ignored_version.as_deref(),
            };
            check_for_updates(&fetcher, &opts, clock::now_unix_ms()).await
        }
    };

    // ③ 写回：只在没有 error 时写；**命中缓存也会写** → 4h 窗口是滑动的（D-9，照抄）
    if result.error.is_none() {
        if let Some(dir) = data_dir.as_ref() {
            settings::write(
                dir,
                json!({
                    "lastCheckAt": clock::now_iso8601(),
                    "lastCheckResult": result,
                }),
            );
        }
    }

    // ④ 进程内存态（restart 即失）
    if let Some(state) = app.try_state::<UpdaterState>() {
        state.set_latest(result.clone());
    }

    // ⑤ 恒发 available —— **检查失败也发**（错误在 `error` 字段里）；
    //    **绝不**在这条路径上发 `shell:update-error`（契约第 3 条）
    events::emit_available(app, &result);

    if force && source == CheckSource::Menu {
        // 对话框由 shell 实现（`shell/dialogs.rs`，经 `shell:update-available` 事件触发），
        // updater 保持无 UI。原先这里写的是「对话框未实现」——那句话已经过时且会误导排障，
        // 于 2026-10-08 由 shell-impl 指出（他们实现了对话框）。
        log::info!("菜单触发的检查完成，结果已发 shell:update-available，由 shell 弹结果对话框");
    }

    result
}

/// `shell:check-update`（`main.js:706-708`）：返回 `CheckResult`，**不 reject**。
#[tauri::command]
pub async fn shell_check_update(app: AppHandle, force: Option<bool>) -> Result<CheckResult, String> {
    Ok(trigger_update_check(&app, force.unwrap_or(false), CheckSource::Renderer).await)
}

/// `shell:download-update`（`main.js:711-774`）。
#[tauri::command]
pub async fn shell_download_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<DownloadedInfo, String> {
    let Some(latest) = state.latest() else {
        return Err(UpdaterError::NoAssetAvailable.message());
    };
    if latest.download_url.is_empty() {
        return Err(UpdaterError::NoAssetAvailable.message());
    }

    // ① 中止上一次下载（`:715-717`）
    if let Some(previous) = state.take_download() {
        previous.cancel();
    }
    // ② 新建 AbortController 的对应物
    let (handle, signal) = download::cancel_channel();
    state.put_download(handle);

    let asset_name = latest.effective_asset_name();
    let client = state.client();
    let outcome = run_download(&app, &client, &latest, &asset_name, signal).await;

    // finally：清空 controller（`:771-773`）
    state.clear_download();

    match outcome {
        Ok(info) => {
            // ⑥ 只有下载 + 校验都过了才记路径、才发 downloaded
            state.set_downloaded(std::path::PathBuf::from(&info.path));
            events::emit_downloaded(&app, &info);
            Ok(info)
        }
        Err(e) => {
            // ⑦ 失败（含取消）发一次 `shell:update-error` 并 reject。
            //    **D-2 修正**：`main.js:747-752` + `:766-770` 在校验失败时会发**两次**
            //    （内层 catch 发一次再 rethrow，外层 catch 再发一次）。两条文案完全相同、
            //    面板 `setState(error)` 幂等 → 去重不可见。Lead 已签字「修」。
            //    **D-3 照抄**：取消走的就是这条路径（面板可能落 error 态）——Lead 已签字
            //    「保留现状」，理由是面板可能正是靠这条 error 把 UI 从 downloading 复位。
            let msg = e.message();
            events::emit_error(&app, &msg);
            Err(msg)
        }
    }
}

/// 下载 → （有 checksums 时）校验 → 组装 `DownloadedInfo`。
async fn run_download(
    app: &AppHandle,
    client: &reqwest::Client,
    latest: &CheckResult,
    asset_name: &str,
    cancel: CancelSignal,
) -> Result<DownloadedInfo, UpdaterError> {
    let app_for_progress = app.clone();
    let last: Arc<Mutex<Option<DownloadProgress>>> = Arc::new(Mutex::new(None));
    let last_for_cb = Arc::clone(&last);
    // 节流器要跨"下载完成之后"使用（收尾那次必须发），所以放 Arc<Mutex<>> 而不是被闭包吞掉
    let throttle: Arc<Mutex<ProgressThrottle>> = Arc::new(Mutex::new(ProgressThrottle::new()));
    let throttle_for_cb = Arc::clone(&throttle);

    let path = download::download_file(
        client,
        DownloadOptions {
            url: &latest.download_url,
            // `destinationDir` 缺省 = $HOME/Downloads（download.js:85）
            destination_dir: None,
            file_name: asset_name,
            // `sizeHint: latestCheckedUpdate.assetSize`（main.js:725）
            size_hint: latest.asset_size,
            cancel: Some(cancel),
        },
        move |p| {
            *last_for_cb.lock().unwrap() = Some(p);
            if throttle_for_cb.lock().unwrap().should_emit(&p) {
                events::emit_progress(&app_for_progress, &p);
            }
        },
    )
    .await?;

    // 设计 §7.6：节流**不能吞掉最后一次**（A3 断言"最终 100%"）
    if let Some(p) = *last.lock().unwrap() {
        throttle.lock().unwrap().force(&p);
        events::emit_progress(app, &p);
    }

    // `if (latestCheckedUpdate.checksumsURL)` —— **D-4 照抄**：没有 checksums.txt 就
    // 整段跳过校验。Lead 已签字：客户端不改，洞在发布侧 CI 用"每个 release 必须带
    // checksums.txt"的断言堵。（改 fail-closed 会让某次坏发版无法自更新，是产品决策。）
    if !latest.checksums_url.is_empty() {
        let text = download::fetch_text(client, &latest.checksums_url).await?;
        let checksums = parse_checksums(text.as_bytes());
        let expected = checksums
            .get(asset_name)
            .ok_or_else(|| UpdaterError::ChecksumMissing(asset_name.to_string()))?;
        if !verify_file_sha256(&path, expected).await? {
            return Err(UpdaterError::ChecksumMismatch);
        }
    }

    Ok(DownloadedInfo {
        path: path.to_string_lossy().to_string(),
        asset_name: asset_name.to_string(),
        release_url: latest.release_url.clone(),
        is_archive: installer::is_archive_package(&path),
    })
}

/// `shell:cancel-download`（`main.js:777-784`）：有在飞下载 → `true`，否则 `false`。
#[tauri::command]
pub fn shell_cancel_download(state: State<'_, UpdaterState>) -> bool {
    match state.take_download() {
        Some(handle) => {
            handle.cancel();
            true
        }
        None => false,
    }
}

/// `shell:install-update`（`main.js:787-797`）。顺序见文件头 —— **先回收 sidecar**。
#[tauri::command]
pub async fn shell_install_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<bool, String> {
    let Some(path) = state.downloaded() else {
        return Err(UpdaterError::NoDownloadedPackage.message());
    };

    // ① 先回收 sidecar：Windows 安装器会强杀本进程，退出钩子跑不到（见文件头）
    match app.try_state::<crate::gateway::Gateway>() {
        Some(gw) => {
            log::info!("安装前回收网关 sidecar");
            gw.kill();
        }
        None => log::warn!("安装前找不到 Gateway 状态，跳过 sidecar 回收"),
    }

    // ② 再调起安装器；失败 → **不退出**（D-5）。
    //    这里的"rollback"只做到「进程继续跑 + `downloadedPackagePath` 不动 + 用户可重试」：
    //    sidecar 已在上一步被回收，而本模块**无法重启它**（`gateway::spawn` 需要 `PanelGuard`，
    //    且窗口 UA 与端口已经固定）。**已知限制**，Lead 已决定不新增 `gateway::restart()`；
    //    此时应用活着但面板连不上网关，用户重开应用即恢复。
    if let Err(e) = installer::open_installer(&path).await {
        let msg = e.message();
        log::error!(
            "调起安装器失败，应用保持运行（安装包仍在 {}）：{msg}",
            path.display()
        );
        return Err(msg);
    }

    // ③ 成功才延迟退窗。`setTimeout(app.quit, 500)` 的等价物；**用 AppHandle::exit**
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        log::info!("更新安装器已调起，退出应用");
        handle.exit(0);
    });

    Ok(true)
}

/// `shell:ignore-version`（`main.js:800-804`）：写 `shell-settings.json` 的
/// `ignoredVersion`（**单个字符串**，不是列表），随后由检查逻辑比对。
#[tauri::command]
pub fn shell_ignore_version(app: AppHandle, version: Option<Value>) -> Result<bool, String> {
    let dir = crate::gateway::resolve_data_dir(&app).map_err(|e| e)?;
    settings::write(&dir, ignored_version_patch(version));
    Ok(true)
}

/// `settings.js:60-61` 的 `ignoredVersion` 归一：**非字符串 → null**（`typeof x === "string"`）。
fn ignored_version_patch(version: Option<Value>) -> Value {
    match version {
        Some(Value::String(s)) => json!({ "ignoredVersion": s }),
        _ => json!({ "ignoredVersion": Value::Null }),
    }
}

/// 启动期自动检查（`main.js:2127-2135`）：3s 后、受 `checkUpdates` 开关与 4h 缓存保护、
/// **不阻塞启动**。
///
/// `--smoke` 与 Electron 版一致地跳过（`main.js:28,2127`）。
pub fn spawn_auto_check(app: &AppHandle) {
    if std::env::args().any(|a| a == "--smoke") {
        log::info!("--smoke：跳过启动期更新检查");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let settings_snapshot = crate::gateway::resolve_data_dir(&app)
            .ok()
            .map(|d| settings::read(&d));
        let enabled = settings_snapshot
            .map(|s| s.check_updates)
            .unwrap_or(true);
        if enabled {
            let _ = trigger_update_check(&app, false, CheckSource::AutoCheck).await;
        } else {
            log::info!("checkUpdates=false：跳过启动期更新检查");
        }
    });
}

/// 监听 shell 模块发来的「检查更新…」应用内事件（托盘 / 应用菜单）。
///
/// 接口由 shell-impl 定：事件名 [`events::EV_CHECK_REQUESTED`]，载荷 `{"force": true}`，
/// 用 `emit_to(EventTarget::app())` 只发给 Rust 侧 listener。**不要改这个接口。**
pub fn listen_for_check_requests(app: &AppHandle) {
    use tauri::Listener;
    let handle = app.clone();
    app.listen(events::EV_CHECK_REQUESTED, move |event| {
        let force = check_request_force(event.payload());
        log::info!("收到 {}（force={force}），开始更新检查", events::EV_CHECK_REQUESTED);
        let app = handle.clone();
        tauri::async_runtime::spawn(async move {
            let result = trigger_update_check(&app, force, CheckSource::Menu).await;
            if let Some(err) = result.error.as_deref() {
                log::warn!("菜单触发的更新检查失败：{err}");
            }
        });
    });
}

/// 解析 `shell:check-update-requested` 的载荷。
///
/// 解析不出来时**保守地按 `force = true`**：能走到这个事件就说明用户显式点了"检查更新"，
/// 与 `main.js:839` 的 `force=true` 同义（force 只绕过 4h 缓存，不是危险操作）。
fn check_request_force(payload: &str) -> bool {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|v| v.get("force").and_then(Value::as_bool))
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_and_arch_map_to_process_values() {
        let p = platform_str();
        assert!(
            matches!(p, "darwin" | "win32" | "linux") || p == std::env::consts::OS,
            "unexpected platform {p}"
        );
        #[cfg(target_os = "macos")]
        assert_eq!(p, "darwin");
        #[cfg(target_os = "windows")]
        assert_eq!(p, "win32");
        #[cfg(target_os = "linux")]
        assert_eq!(p, "linux");

        let a = arch_str();
        assert!(
            matches!(a, "arm64" | "x64" | "ia32" | "arm"),
            "unexpected arch {a}"
        );
        #[cfg(target_arch = "aarch64")]
        assert_eq!(a, "arm64");
        #[cfg(target_arch = "x86_64")]
        assert_eq!(a, "x64");
    }

    #[test]
    fn ignored_version_only_accepts_strings_like_js_normalize() {        assert_eq!(
            ignored_version_patch(Some(Value::String("0.3.2".into()))),
            json!({"ignoredVersion": "0.3.2"})
        );
        assert_eq!(
            ignored_version_patch(Some(Value::String("".into()))),
            json!({"ignoredVersion": ""})
        );
        for bad in [
            None,
            Some(Value::Null),
            Some(json!(3)),
            Some(json!(true)),
            Some(json!(["0.3.2"])),
            Some(json!({"v": "0.3.2"})),
        ] {
            assert_eq!(ignored_version_patch(bad), json!({"ignoredVersion": null}));
        }
    }

    #[test]
    fn check_request_payload_defaults_to_force() {
        // shell 的约定载荷
        assert!(check_request_force(r#"{"force": true}"#));
        assert!(!check_request_force(r#"{"force": false}"#));
        // 缺失/畸形 → 保守按"用户点了检查更新"处理
        assert!(check_request_force("{}"));
        assert!(check_request_force(""));
        assert!(check_request_force("not json"));
        assert!(check_request_force(r#"{"force": "yes"}"#));
    }

    #[test]
    fn check_request_event_name_is_frozen() {
        // 与 shell-impl 的接口约定，改名 = 托盘"检查更新"静默失效
        assert_eq!(events::EV_CHECK_REQUESTED, "shell:check-update-requested");
    }
}
