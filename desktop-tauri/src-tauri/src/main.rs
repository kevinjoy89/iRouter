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

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use gateway::Gateway;
use guard::PanelGuard;

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
        .setup(|app| {
            let handle = app.handle().clone();

            // 开发期捷径：直接指向已有网关，不拉 sidecar。
            if let Ok(url) = std::env::var("IROUTER_PANEL_URL") {
                let parsed: tauri::Url = url
                    .parse()
                    .map_err(|e| format!("IROUTER_PANEL_URL 不是合法 URL（{url}）：{e}"))?;
                log::info!("跳过 sidecar，直接指向 {parsed}");
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                    .title("iRouter")
                    .inner_size(1360.0, 900.0)
                    .min_inner_size(900.0, 600.0)
                    .build()?;
                return Ok(());
            }

            // wave 2 的模块入口：都不得阻塞启动
            shell::init(&handle)?;
            updater::init(&handle)?;

            let panel_guard = PanelGuard::generate();
            let gw = gateway::spawn(&handle, &panel_guard)?;
            let port = gw.port;
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
                    if let Err(e) = window.show() {
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
