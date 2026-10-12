//! 主窗口显隐、macOS Dock 图块、退出路径。
//!
//! 对照 `desktop/main.js`：
//!   - `showWindow()`      `:421-430`
//!   - `showDock()`        `:413-415`
//!   - `hideDock()`        `:417-419`
//!   - `quit()`（退出）    见 `main.js` 的 quit 定义与 `:2148-2154` 的 before-quit

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Emitter, Manager, Wry};

/// 下载完成后通知面板的事件名。
///
/// **为什么需要它**：导出是**静默**落到 `~/Downloads` 的，用户在面板上只看到「配置已导出」，
/// 不知道文件去了哪。而路径只有壳层知道——面板既不知道系统下载目录，也不知道重名去重后的后缀
/// （`name (1).json`）。所以由壳层把**最终落盘路径**发给它。
pub const EV_DOWNLOAD_SAVED: &str = "shell:download-saved";

/// 最近一次下载请求的 (url, 目标路径)。
///
/// 需要它是因为 **wry 在 macOS 上不回填 `DownloadEvent::Finished.path`**（实测为 `None`），
/// 而 `Requested` 里的 `destination` 才是最终路径——按 url 配对取回。
static LAST_DESTINATION: Mutex<Option<(String, PathBuf)>> = Mutex::new(None);

/// 下载处理器。**必须注册** —— 否则 WKWebView 会**静默取消**下载。
///
/// 事实依据（不是推测）：wry 的导航代理里，只有当注册了下载处理器时才放行，
/// 否则直接 `WKNavigationActionPolicy::Cancel`：
/// `wry-0.57.0/src/wkwebview/navigation.rs:68-74`。
///
/// 不注册的后果是**假成功**：面板侧 `anchor.click()` 立即返回，于是它紧接着
/// `setStatus("配置已导出")` —— 界面说成功，文件却不存在。Electron 版没有这个问题
/// （Chromium 自带下载），所以这是换壳引入的**行为回归**，靠 CI 与单测都抓不到。
///
/// 落盘位置不用我们决定：wry 的 `download_policy` 已经把 destination 预填成
/// `~/Downloads/<suggestedFilename>`（即面板 `a.download` 设的名字）并做了重名去重
/// （`wry-0.57.0/src/wkwebview/download.rs:57-72`）——**与 Electron 的默认行为一致**。
/// 这里只负责放行与记录。
pub fn download_handler()
-> impl Fn(tauri::Webview<tauri::Wry>, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    |webview, event| {
        match event {
            DownloadEvent::Requested { url, destination } => {
                log::info!("[download] 请求 {url} → 落盘 {destination:?}");
                if let Ok(mut g) = LAST_DESTINATION.lock() {
                    *g = Some((url.to_string(), destination.clone()));
                }
            }
            DownloadEvent::Finished { url, path, success } => {
                let url_s = url.to_string();
                // wry 在 macOS 上不回填 `path`（实测 `None`）：用 Requested 记下的目的地配回来。
                let remembered = LAST_DESTINATION
                    .lock()
                    .ok()
                    .and_then(|g| {
                        g.as_ref()
                            .filter(|(u, _)| *u == url_s)
                            .map(|(_, p)| p.clone())
                    });
                let final_path = path.or(remembered);
                match (success, final_path) {
                    (true, Some(p)) => {
                        log::info!("[download] 完成 {url_s} → {p:?}");
                        notify_panel(&webview, &p);
                    }
                    (true, None) => {
                        // 完成但拿不到路径：面板就只显示原来的成功文案，不编造路径
                        log::warn!("[download] 完成但拿不到落盘路径：{url_s}");
                    }
                    (false, _) => {
                        // 失败必须留痕：否则又是一次"点了没反应"
                        log::error!("[download] 失败 {url_s}");
                    }
                }
            }
            _ => {}
        }
        // ★ 返回 false 会让本次下载被取消；true 才放行
        true
    }
}

/// 把最终落盘路径发给主窗口（失败只记日志，绝不影响下载本身）。
fn notify_panel(webview: &tauri::Webview<tauri::Wry>, path: &Path) {
    if let Err(e) = webview.emit_to(
        tauri::EventTarget::webview_window(MAIN_WINDOW),
        EV_DOWNLOAD_SAVED,
        serde_json::json!({ "path": path.to_string_lossy() }),
    ) {
        log::warn!("发送 {EV_DOWNLOAD_SAVED} 失败：{e}");
    }
}

use super::ShellState;

/// 哪些新窗口请求该交给系统浏览器。**纯函数，便于单测**（`NewWindowFeatures` 在测试里
/// 无法构造，所以判定必须与处理器闭包分开）。
///
/// 只放行 `http` / `https`：其余 scheme（`file:` / `javascript:` / `data:` / 自定义 scheme）
/// 一律只拒绝、不交给系统。面板理论上不该发出这类新窗口请求；真出现了更可能是被注入的内容，
/// 而交给系统等于把「用任意 scheme 唤起本机程序」这条路打开。
pub fn is_external_openable(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// 新窗口请求处理器：把 `target="_blank"` / `window.open` 的外链交给**系统默认浏览器**。
///
/// ## 为什么必须注册（不注册就是「点了没反应」）
///
/// 面板里所有站外链接都是 `<a target="_blank" rel="noopener noreferrer">`（提供商详情页的
/// 「Get API Key」「Sign up / Learn more」、凭据弹窗里的官网与 `dash.cloudflare.com` 等）。
/// 用户实测这些链接**全部点击无效**，根因在 wry 的默认分支：
///
/// wry 0.57.0 **无条件**注册 WebView2 的 `NewWindowRequested`，而**没有**用户处理器时走：
/// ```text
/// } else {
///   args.SetHandled(true)?;      // wry-0.57.0/src/webview2/mod.rs:848-850
/// }
/// ```
/// `SetHandled(true)` 却不给 `SetNewWindow`，按微软文档的语义是「弹出一个不加载、立刻关闭的
/// 占位窗口」——**表现就是点击毫无反应**，且**不会**落到系统浏览器。Linux/WebKitGTK 同理
/// （wry 只在有处理器时才连 `create` 信号，没有就维持 WebKit 默认 = 不建窗口）。
///
/// ## 为什么返回 `Deny`
///
/// - `Allow` 会让 WebView2 走它自己的默认实现 → 弹出一个**应用内的裸 WebView2 窗口**，
///   既不是系统浏览器、又不受壳层管控（无守卫 UA、无下载处理器、无右键菜单）。
/// - `Create` 需要 `with_environment`（Windows）/ `with_related_view`（Linux）等一堆
///   与父 webview 同环境的约束（`tauri-2.12.1/src/webview/mod.rs:248-252` 的平台说明），
///   对「打开一个外部网页」这件事是纯粹的复杂度。
/// - `Deny` 只拒绝 WebView2 自建窗口；**我们已经先把 URL 交给系统浏览器了**，
///   所以用户看到的是「点链接 → 浏览器打开」，且应用窗口自身不跳转
///   —— 正是 `openspec/changes/irouter-desktop-shell/specs/app-shell/spec.md:72-84` 那条
///   「站外链接走系统浏览器 / 应用窗口不跳转」的要求。
///
/// ## 为什么不用 `on_navigation`
///
/// 两者是**不同的 WebView2 事件**：`target="_blank"` 走 `NewWindowRequested`，
/// 而 `on_navigation` 对应 `NavigationStarting`（只覆盖**本 webview 的同窗导航**）。
/// 只挂 `on_navigation` 拦不到这类点击。
///
/// ## 权限
///
/// **不需要改 capability**：`capabilities/README.md` 那条「不要加 `opener:*`」针对的是
/// **webview → IPC** 的命令面；这里调的是 Rust 侧自由函数，插件文档明说自由函数
/// **不做 scope 检查**（`tauri-plugin-opener-2.7.0/src/lib.rs:7-10`）。
/// 因此 `capabilities/default.json` 一行不动，攻击面也不扩大。
pub fn new_window_handler()
-> impl Fn(tauri::Url, tauri::webview::NewWindowFeatures) -> tauri::webview::NewWindowResponse<Wry>
       + Send
       + 'static {
    |url, _features| {
        if is_external_openable(&url) {
            match tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
                Ok(()) => log::info!("[new-window] 交给系统浏览器：{url}"),
                // 失败必须留痕：否则又是一次「点了没反应」，且这次连日志都没有
                Err(e) => log::error!("[new-window] 打开外链失败 {url}：{e}"),
            }
        } else {
            log::warn!("[new-window] 拒绝非 http(s) 的新窗口请求：{url}");
        }
        // 无论成功与否都不让 webview 自己建窗（理由见上）
        tauri::webview::NewWindowResponse::Deny
    }
}

/// 主窗口 label（`main.rs` 建窗时用的就是 "main"）。
pub const MAIN_WINDOW: &str = "main";

pub fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// 对齐 `desktop/main.js:421-430` 的 `showWindow()`：
/// 先恢复 Dock（`showDock()`），再 `restore → show → focus`。
pub fn show_window(app: &AppHandle) {
    show_dock(app);
    let Some(window) = main_window(app) else {
        // 窗口还没建出来（setup 阶段被托盘/菜单事件提前调用）或已被销毁。
        // Electron 版这里是 createWindow()；Tauri 版建窗归 main.rs，壳层只记一条日志。
        log::warn!("show_window：主窗口不存在，跳过（建窗归 main.rs）");
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 关窗行为里的"隐藏到托盘"：只隐藏窗口，不销毁（网关继续跑）。
pub fn hide_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        if let Err(e) = window.hide() {
            log::error!("隐藏主窗口失败：{e}");
        }
    }
}

/// 对齐 `desktop/main.js:413-415` 的 `showDock()`。
///
/// Electron 的 `app.dock.show()` 在 Tauri 里的对应物是 **激活策略**（非同名 API，别找 `dock()`）：
/// `ActivationPolicy::Regular`（常规应用，有 Dock 图块）↔ `Accessory`（无 Dock 图块、
/// 不进 Cmd+Tab）。见 `docs/plans/2026-10-07-tauri-shell-api-notes.md` §8 末段，
/// 签名 `AppHandle::set_activation_policy`（`tauri-2.12.1/src/app.rs:658`）。
#[cfg(target_os = "macos")]
pub fn show_dock(app: &AppHandle) {
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        log::warn!("恢复 Dock 图块失败：{e}");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn show_dock(_app: &AppHandle) {
    // 非 macOS 平台 `app.dock` 不存在；Electron 版这两个函数也是空操作（`main.js:414,418`）。
}

/// 对齐 `desktop/main.js:417-419` 的 `hideDock()`（closeAction == "tray" 那一档）。
#[cfg(target_os = "macos")]
pub fn hide_dock(app: &AppHandle) {
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
        log::warn!("隐藏 Dock 图块失败：{e}");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn hide_dock(_app: &AppHandle) {}

/// 退出应用：对齐 `main.js` 的 `quit()` 与 `before-quit`（`:2148-2154`）的合成语义——
/// 先置 `quitting` 标志（让关窗拦截不再 prevent）、回收 sidecar，再走 `AppHandle::exit`。
///
/// **必须用 `AppHandle::exit` 而不是 `std::process::exit`**：后者不跑任何钩子
/// （`single_instance::destroy` 与 main.rs 的 `RunEvent::Exit` 回收都会被跳过，
/// 见 `docs/plans/2026-10-07-tauri-shell-api-notes.md` §6.3 路径 3）。
///
/// ⚠️ **本函数必须保持幂等**——有两个调用方，且它们可能相继到达：
///   1. 托盘「退出」/ 应用菜单「退出 iRouter」/ `closeAction=quit`（`mod.rs::on_close_requested`）；
///   2. 信号监视线程（`signals.rs`，收到 SIGINT/SIGTERM 后）。
/// 用户先点「退出」、随即又 `kill -TERM` 就会同时命中两处。当前的三步都是幂等的
/// （`set_quitting` 重复置真、`Gateway::kill` 已 `take` 走 child → 第二次空操作、
/// `exit(0)` 重复投递无害）——**重构时不要破坏这一点**：任何"只应执行一次"的副作用
/// （写文件、删文件、发送消息）放进来之前都要先想清楚上面这条竞态。
pub fn quit(app: &AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        state.set_quitting();
    }
    if let Some(gw) = app.try_state::<crate::gateway::Gateway>() {
        gw.kill();
    }
    log::info!("退出应用（closeAction=quit 或菜单/托盘「退出」，或收到 SIGINT/SIGTERM）");
    app.exit(0);
}

/// `--from-autostart`：复刻 Electron `openAsHidden` 的标记参数法
/// （`desktop/main.js:2120-2125` 的 `wasOpenedAtLogin` 分支；API notes §3）。
pub const AUTOSTART_ARG: &str = "--from-autostart";

/// 本次启动是否来自登录项（应只驻留托盘、不显窗口）。
///
/// 调用点：`main.rs:114` 的就绪线程在 `window.show()` 之前问这一句
/// （Lead 已按本模块的请求接上；原先这里有一段 20s 轮询兜底，钩子接上后**已删除**，
/// 因为轮询只会在用户主动从托盘唤出窗口时把它again 隐藏掉）。
pub fn opened_at_login() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 面板里那些 `target="_blank"` 外链必须被判为「可交给系统浏览器」。
    /// 取自真实源码里的 href（提供商详情页与凭据弹窗），不是编的。
    #[test]
    fn external_http_links_are_openable() {
        for u in [
            "https://dash.cloudflare.com",
            "https://opencode.ai/workspace/wrk_abc/go",
            "http://example.com/plain",
        ] {
            let url = tauri::Url::parse(u).expect("test url");
            assert!(is_external_openable(&url), "{u} 应交给系统浏览器");
        }
    }

    /// ★ 安全边界：非 http(s) 一律不交给系统。
    ///
    /// 交给系统 = 让系统按 scheme 唤起对应程序。`file:` 能打开本地路径、
    /// 自定义 scheme 能唤起已注册的任意本机应用；`javascript:` / `data:` 更不该出网。
    /// 面板理论不该发出这类请求，真出现了更可能是被注入的内容。
    #[test]
    fn non_http_schemes_are_not_openable() {
        for u in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,<h1>x</h1>",
            "mailto:a@b.com",
            "ms-settings:privacy",
            "vscode://file/C:/x",
        ] {
            let url = tauri::Url::parse(u).unwrap_or_else(|_| panic!("test url {u} 应可解析"));
            assert!(!is_external_openable(&url), "{u} 绝不能交给系统程序");
        }
    }

    /// 面板自身的地址也会被判为「可打开」——这是**刻意**的。
    ///
    /// 面板里没有任何 `window.open` 指向同源 URL（OAuth 已改成服务端 /callback 收口），
    /// 所以这条路径当前不可达。若日后重新引入「同源弹窗在应用内打开」，
    /// 必须在这里按 host/port 加分支 —— 那时的失败形态是「弹到系统浏览器里」，
    /// 可见且可诊断，而不是这次这种「点了没反应」的静默失败。
    #[test]
    fn panel_origin_is_treated_as_external_today() {
        let url = tauri::Url::parse("http://127.0.0.1:20128/dashboard").expect("test url");
        assert!(
            is_external_openable(&url),
            "当前实现不区分同源；重新引入同源弹窗时要在此加 host/port 判断"
        );
    }

    /// ★ 接线守卫：`on_new_window` 必须在**两个**建窗处都挂上。
    ///
    /// 这条守卫针对的正是本 bug 的形态：**逻辑写对了但没接上 = 等于没修**，而且表现是
    /// 「点击毫无反应、零报错、CI 全绿」。`main.rs` 有两条建窗路径（dev 捷径
    /// `IROUTER_PANEL_URL` 与正常启动），漏掉任一条就会在那条路径上复现。
    /// 下载处理器（`on_download`）有过同样的要求，这里把两者一起钉住。
    #[test]
    fn both_window_builders_attach_the_new_window_handler() {
        // 本文件在 src/shell/，main.rs 在 src/ —— 相对本文件是 ../../src/main.rs
        let main_rs = include_str!("../../src/main.rs");
        let attach = main_rs.matches("on_new_window").count();
        let downloads = main_rs.matches("on_download").count();
        assert_eq!(
            attach, 2,
            "on_new_window 应恰好挂 2 处（dev 捷径 + 正常启动），实际 {attach} 处"
        );
        assert_eq!(
            downloads, 2,
            "on_download 应恰好挂 2 处，实际 {downloads} 处（新增建窗路径时两者都要挂）"
        );
        // 挂的必须是本模块的实现，而不是空壳
        assert!(
            main_rs.contains("shell::new_window_handler()"),
            "两处都应挂 shell::new_window_handler()"
        );
    }
}
