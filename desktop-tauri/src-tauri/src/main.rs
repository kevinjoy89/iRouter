//! iRouter 桌面壳层入口（Tauri v2）。
//!
//! 启动序列（每一步都刻意可观测）：
//!   1. 生成**本次启动的随机**面板守卫令牌（`guard.rs`）
//!   2. 找空闲端口 → 拉起 Bun sidecar 跑网关（`gateway.rs`）
//!   3. 窗口先指向本地兜底页并**隐藏**（不闪白屏、不显示加载失败）
//!   4. 后台线程等网关就绪 → `navigate` 到面板 → `show`
//!   5. `RunEvent::Exit` → kill 网关子进程（孤儿回收，见 `gateway.rs` 顶部注释）
//!
//! 开发期捷径：设 `IROUTER_PANEL_URL` 可跳过 sidecar 直接指向已有网关（例如正在跑的 Electron 版）。

mod gateway;
mod guard;
mod settings;
mod shell;
mod updater;

use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use gateway::Gateway;
use guard::PanelGuard;

/// 给面板（**远端 origin**）按**实际端口**动态加 capability。
///
/// 为什么不能写死在配置文件里：`pickPort` 扫完 50 个端口后会回落 **OS 临时端口**
/// （`desktop/main.js:151-159`），端口无上界——写死 20128 的话，一旦漂移，更新通道与设置读写
/// 会被 ACL 拒绝，而且**不报错到面板**（表现为功能无声消失）。
///
/// 依据（tag tauri-v2.12.1）：`Manager::add_capability`（`tauri/src/lib.rs:840-848`，
/// `dynamic-acl` feature，默认开启）；远端匹配走 IPC 请求的 `Origin` 头
/// （`tauri/src/ipc/authority.rs:462-479`）。详见 `capabilities/README.md`。
fn add_remote_panel_capability(app: &tauri::AppHandle, port: u16) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("remote-panel")
            // 只对远端 origin 生效。不加这句会连带把 Local 也授出去
            // （resolved.rs:280 的 `if capability.local { contexts.push(Local) }`）
            .local(false)
            .window("main")
            .remote(format!("http://127.0.0.1:{port}"))
            // 事件：面板只订阅（更新 4 个事件 + shell:open-settings），unlisten 也要放行
            .permission("core:event:allow-listen")
            .permission("core:event:allow-unlisten")
            // 更新器 5 条
            .permission("allow-shell-check-update")
            .permission("allow-shell-download-update")
            .permission("allow-shell-cancel-download")
            .permission("allow-shell-install-update")
            .permission("allow-shell-ignore-version")
            // shell 3 条
            .permission("allow-shell-get-settings")
            .permission("allow-shell-set-settings")
            .permission("allow-shell-context-menu"),
    )
}

/// 壳层日志：不引第三方日志后端，`log` 门面 + 这里的极简实现直接打 stderr。
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        eprintln!("[iRouter] {} {}", record.level(), record.args());
    }
    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

fn main() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);

    tauri::Builder::default()
        // single-instance 必须最先注册（Tauri 文档要求），回调里聚焦已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            shell::on_second_instance(app, argv, cwd)
        }))
        // 开机自启：macOS 走 LaunchAgent；--from-autostart 用于复刻 Electron 的 openAsHidden
        // 语义（插件本身没有「隐藏启动」开关，只能自己解析 argv）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--from-autostart"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // 原生对话框：供 shell 的「检查更新…」结果提示（updater 保持无 UI）
        .plugin(tauri_plugin_dialog::init())
        // ⚠️ 全应用**只能有一处** invoke_handler：tauri-2.12.1/src/app.rs:1727 是
        // `self.invoke_handler = Box::new(..)`（**覆盖式**）——shell 与 updater 各调一次，
        // 后一个会把前一批命令整批静默丢掉（面板只看到 Command not found）。因此在这里合并。
        .invoke_handler(tauri::generate_handler![
            // ⚠️ 必须写**命令定义所在的模块**路径（x::commands::y），不能写 re-export 路径（x::y）。
            // 依据：tauri-macros-2.7.1/src/command/handler.rs:163-171 会把路径最后一段换成
            // __cmd__<name>，而伴生宏定义在命令所在模块里。实测：定义处路径通过，re-export 报 E0433。
            shell::commands::shell_get_settings,
            shell::commands::shell_set_settings,
            shell::commands::shell_context_menu,
            updater::commands::shell_check_update,
            updater::commands::shell_download_update,
            updater::commands::shell_cancel_download,
            updater::commands::shell_install_update,
            updater::commands::shell_ignore_version,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // 开发期捷径：直接指向已有网关，不拉 sidecar。
            if let Ok(url) = std::env::var("IROUTER_PANEL_URL") {
                let parsed: tauri::Url = url
                    .parse()
                    .map_err(|e| format!("IROUTER_PANEL_URL 不是合法 URL（{url}）：{e}"))?;
                log::info!("跳过 sidecar，直接指向 {parsed}");
                // dev 捷径同样要加远端 capability，否则面板在 dev 下 IPC 全被拒
                if let Some(p) = parsed.port() {
                    add_remote_panel_capability(&handle, p)?;
                }
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                    .title("iRouter")
                    .inner_size(1360.0, 900.0)
                    .min_inner_size(900.0, 600.0)
                    // 面板桥：window.irouterShell（shell 与 updater 各注入一份，靠 Object.assign 合并）
                    .initialization_script(shell::shim_script())
                    .initialization_script(updater::shim_js())
                    .build()?;
                return Ok(());
            }

            // wave 2 的模块入口：都不得阻塞启动
            shell::init(&handle)?;
            updater::init(&handle)?;

            let panel_guard = PanelGuard::generate();
            let gw = gateway::spawn(&handle, &panel_guard)?;
            let port = gw.port;
            // 必须在窗口 build() 之前加：面板是远端 origin，权限按实际端口给
            add_remote_panel_capability(&handle, port)?;
            let pid = gw.pid();
            handle.manage(gw);
            log::info!("网关 pid={pid:?} port={port}");

            // 窗口先加载本地兜底页并隐藏：网关还没就绪时不会闪错误页。
            let ua_for_window = panel_guard.user_agent();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("iRouter")
                .inner_size(1360.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .visible(false)
                // 守卫令牌经 UA 覆盖该窗口的所有请求（导航、子资源、fetch）
                .user_agent(&ua_for_window)
                // 面板桥：与上面那条捷径**必须都挂**，漏一个「软件更新」整段就从 UI 消失
                .initialization_script(shell::shim_script())
                .initialization_script(updater::shim_js())
                .build()?;

            // 等就绪 → 导航到面板 → 显示。放在后台线程，别卡事件循环。
            let ua = panel_guard.user_agent();
            std::thread::spawn(move || {
                if gateway::wait_ready(port, &ua) {
                    let panel: tauri::Url = format!("http://127.0.0.1:{port}")
                        .parse()
                        .expect("panel url");
                    if let Err(e) = window.navigate(panel) {
                        log::error!("导航到面板失败：{e}");
                    }
                    // 开机自启时只驻留托盘，不弹窗（对齐 Electron 的 openAsHidden 语义）
                    if shell::opened_at_login() {
                        log::info!("开机自启：窗口保持隐藏，驻留托盘");
                    } else if let Err(e) = window.show() {
                        log::error!("显示窗口失败：{e}");
                    }
                } else {
                    // 就绪失败也要让用户看到东西，否则是「点了没反应」——比错误页更糟。
                    log::error!("网关未就绪，仍显示兜底页");
                    let _ = window.show();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 iRouter 失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(gw) = app.try_state::<Gateway>() {
                    gw.kill();
                }
            }
        });
}
