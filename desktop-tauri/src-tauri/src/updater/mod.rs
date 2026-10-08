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

use tauri::AppHandle;

/// 由 `main.rs` 在 setup 阶段调用。**不得阻塞启动**。
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    log::info!("updater 模块已装载（检查/下载/安装尚未实现——Phase 4）");
    let _ = app;
    Ok(())
}
