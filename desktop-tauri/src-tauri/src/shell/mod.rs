//! 壳功能：托盘、开机自启、单实例、应用菜单、右键菜单、快捷键、窗口关闭行为、设置模态 IPC。
//!
//! **owner: shell 任务**。本文件与 `src/shell/**` 之外的任何文件都不要改——
//! `main.rs` / `gateway.rs` / `guard.rs` 归 Lead，`tauri.conf.json` 与 `capabilities/**` 归 packaging。
//!
//! 插件注册在 `main.rs` 里（顺序有讲究：single-instance 必须最先，见 Tauri 文档），
//! 本模块只负责事件处理与业务。可照抄的事实依据：
//! `docs/plans/2026-10-07-tauri-shell-api-notes.md`（512 行，含确切签名与出处）。
//!
//! 必须先读的三条（都是核查出来的硬事实，别按直觉写）：
//!   1. **macOS 上 Cmd/Ctrl+C/V/A 需要 Edit 菜单项**才生效——所以 Electron 那 80 行
//!      `before-input-event` shim（`desktop/main.js:512-560`）不能直接删，但正确做法是
//!      **加菜单**而不是重写 shim。Win/Linux 是否原生可用**无官方文档**（recon 标 U）。
//!   2. **Tauri v2 没有 Electron 那样的 context-menu 事件**——右键菜单要用
//!      `WebviewWindow::popup_menu_at`，触发只能用壳注入的 init 脚本挂 DOM `contextmenu` 再 invoke 回来。
//!   3. **`TrayIconEvent` 的 `DoubleClick` 是 Windows only**（macOS 双击要自己用两次 Click 判时差）；
//!      托盘图标 macOS 模板图用 `.icon_as_template(true)`。
//!
//! 关闭行为要对齐 `desktop/main.js:605-612`：「退出」与「最小化到托盘」两种 closeAction。
//! 注意 Tauri **没有** Electron 的 `close` 事件 `preventDefault`；拦截窗口关闭是
//! `RunEvent::WindowEvent { event: WindowEvent::CloseRequested { api, .. } }` + `api.prevent_close()` + `window.hide()`。

use tauri::AppHandle;

/// 由 `main.rs` 在 setup 阶段调用。**不得阻塞启动**，需要 I/O 的工作自己起任务。
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    log::info!("shell 模块已装载（托盘/自启/菜单尚未实现——Phase 4）");
    let _ = app;
    Ok(())
}

/// single-instance 插件回调：第二次启动时聚焦已有窗口。
///
/// 现 Electron 版只看 `second-instance` 不看 argv（`desktop/main.js:2140-2142`）；
/// Tauri 的 `init(|app, args: Vec<String>, cwd: String|)` **直接给 argv**，比现状更强——
/// 可用它实现「用文件路径/开关二次唤起」这类能力。
pub fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    log::info!("二次启动：args={args:?} cwd={cwd}");
    if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
