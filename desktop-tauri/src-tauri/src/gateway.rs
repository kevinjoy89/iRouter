//! 网关 sidecar 生命周期：端口发现 → 拉起 Bun → 就绪探测 → 退出清理。
//!
//! ## 关于孤儿回收（这一版最重要的设计决定）
//!
//! 计划里原本写「用 Tauri ≥2.12.1 的 `register_sidecar` / `cleanup_before_exit` 做孤儿回收」。
//! 经**本地 crate 源码核实**（`~/.cargo/registry/src/.../`）：
//! - `Command::sidecar` / `spawn` / `CommandChild::{kill,pid}` / `current_dir` 都在
//!   `tauri-plugin-shell-2.4.0`；
//! - `cleanup_before_exit` 在 `tauri-2.12.1/src/app.rs`，但它是 `exit()` / `restart()` 的
//!   内部调用，**不是给插件注册清理钩子的公开面**；
//! - `register_sidecar` / `kill_process_tree` 在这三个 crate 里**都不存在**——它们属 CLI 侧
//!   （那条 PR 的标题即「CLI kills entire app tree」，用于 `tauri dev`），**不是运行期 API**。
//!
//! 结论：运行期孤儿回收必须自己管，与 Electron 版用 `.gateway.pid` 自管同构
//! （`desktop/main.js:197,226-285`）。本模块持有 `CommandChild`，并在 `RunEvent::Exit`
//! 与显式退出路径上 kill。**三条死亡路径必须实测**（正常退出 / 窗口关闭后托盘常驻 /
//! 安装器强杀），这条约束写在 `../README.md`。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::guard::PanelGuard;

/// 与 Electron 版一致：默认端口与扫描跨度（`desktop/main.js:31-32`）。
pub const DEFAULT_PORT: u16 = 20128;
pub const PORT_SCAN_SPAN: u16 = 50;

/// 就绪等待上限。Phase 0 门禁实测网关启动约 1.6 s，60 s 是留足余量的天花板。
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_INTERVAL: Duration = Duration::from_millis(250);

/// sidecar 可执行文件在 `bundle.externalBin` 里的逻辑名（打包侧见 task-2 的方案）。
const SIDECAR_NAME: &str = "bun";

/// 网关负载在资源目录里的相对路径（打包与 dev 两种形态的差异由 `resolve_server_entry` 吸收）。
const SERVER_ENTRY_REL: &str = "gateway/server/custom-server.js";

pub struct Gateway {
    pub port: u16,
    child: Mutex<Option<CommandChild>>,
}

impl Gateway {
    /// 杀掉网关子进程。可重复调用；`RunEvent::Exit` 与显式退出路径都会走它。
    pub fn kill(&self) {
        if let Some(child) = self.child.lock().expect("gateway lock poisoned").take() {
            let pid = child.pid();
            match child.kill() {
                Ok(()) => log::info!("已终止网关子进程 pid={pid}"),
                Err(e) => log::warn!("终止网关子进程 pid={pid} 失败：{e}"),
            }
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.lock().expect("gateway lock poisoned").as_ref().map(|c| c.pid())
    }
}

/// 网关数据目录：与 Electron 版一致用 `~/.irouter`（**不是**上游默认的 `~/.9router`）。
///
/// 注意它与「应用数据目录」（`app_data_dir()`，装 webview 缓存）是两个地方——见 CONTEXT.md
/// 的「网关数据目录 / 应用数据目录」两条术语。
pub fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("DATA_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("拿不到 home 目录：{e}"))?;
    Ok(home.join(".irouter"))
}

/// 定位网关入口。dev 形态从仓库取，打包形态从资源目录取。
fn resolve_server_entry(app: &AppHandle) -> Result<PathBuf, String> {
    // 打包形态：<resource_dir>/gateway/server/custom-server.js
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join(SERVER_ENTRY_REL);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    // dev 形态：仓库里 desktop 构建出来的负载（复用既有 build-server.mjs 产出，不重复造）
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("desktop")
        .join("build")
        .join("gateway")
        .join("server")
        .join("custom-server.js");
    if dev.is_file() {
        return Ok(dev.canonicalize().unwrap_or(dev));
    }
    Err(format!(
        "找不到网关入口（既不在资源目录 {SERVER_ENTRY_REL}，也不在仓库 desktop/build/gateway/server）。\
         先跑 `npm --prefix desktop run build-server`。"
    ))
}

/// 端口发现：与 Electron 版同构——能 bind 成功即视为空闲（`desktop/main.js:128-158` 用
/// 「能否连上」判定占用，这里用 bind 更直接；取到后立即释放，交给 bun 去 bind）。
pub fn find_free_port() -> Option<u16> {
    for offset in 0..PORT_SCAN_SPAN {
        let port = DEFAULT_PORT + offset;
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// 就绪探测：裸 TCP 发一个 HTTP/1.1 GET 打 `/login`，看首行是否为 200。
///
/// 故意不带 reqwest——只为一次探针引入 tokio + TLS 不划算，而产物体积是本次迁移的硬指标。
/// 请求头里带上与 webview 相同的 UA（含守卫令牌），因此这一探针**同时验证了守卫链路**：
/// 若令牌没被网关接受，网关会按 `custom-server.js:161-166` 直接切断连接，探测就会失败。
fn probe_once(port: u16, user_agent: &str) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut sock) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else {
        return false;
    };
    let _ = sock.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!(
        "GET /login HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: {user_agent}\r\nAccept: text/html\r\nConnection: close\r\n\r\n"
    );
    if sock.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    match sock.read(&mut buf) {
        Ok(n) if n >= 12 => buf.starts_with(b"HTTP/1.1 200") || buf.starts_with(b"HTTP/1.0 200"),
        _ => false,
    }
}

/// 阻塞等待就绪。调用方负责放到后台线程，别卡住事件循环。
pub fn wait_ready(port: u16, user_agent: &str) -> bool {
    let start = Instant::now();
    while start.elapsed() < READY_TIMEOUT {
        if probe_once(port, user_agent) {
            log::info!("网关就绪（{} ms）", start.elapsed().as_millis());
            return true;
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
    log::error!("网关在 {} s 内未就绪", READY_TIMEOUT.as_secs());
    false
}

/// 拉起 Bun sidecar，返回持有子进程句柄的 `Gateway`。
pub fn spawn(app: &AppHandle, guard: &PanelGuard) -> Result<Gateway, String> {
    let entry = resolve_server_entry(app)?;
    let server_dir = entry
        .parent()
        .ok_or_else(|| "网关入口没有父目录".to_string())?
        .to_path_buf();
    let data_dir = resolve_data_dir(app)?;
    let port = find_free_port().ok_or_else(|| {
        format!(
            "{DEFAULT_PORT}–{} 全部被占用，无法为网关找端口",
            DEFAULT_PORT + PORT_SCAN_SPAN - 1
        )
    })?;

    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;

    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("找不到 sidecar `{SIDECAR_NAME}`（externalBin 未配置或未就位）：{e}"))?
        .args([entry.to_string_lossy().to_string(), "--port".into(), port.to_string()])
        // cwd 必须是负载目录：引擎按 cwd 相对路径探测 open-sse/dlp/dlp_rules.yaml
        .current_dir(server_dir)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("DATA_DIR", data_dir.to_string_lossy().to_string())
        // 面板守卫：开关 + 本次启动的随机令牌（见 guard.rs）
        .env("IR_PANEL_GUARD", "1")
        .env("IR_PANEL_GUARD_TOKEN", guard.token());

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("拉起网关 sidecar 失败：{e}"))?;

    // 转发 sidecar 输出到壳层日志。刻意只 log 不解析——就绪判定走 HTTP 探针，比匹配日志文本稳。
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => log::info!("[gateway] {}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Stderr(line) => log::warn!("[gateway] {}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Error(err) => log::error!("[gateway] {err}"),
                CommandEvent::Terminated(payload) => {
                    log::warn!("[gateway] 进程结束：{payload:?}");
                }
                _ => {}
            }
        }
    });

    log::info!("网关已拉起：pid={} port={port} entry={}", child.pid(), entry.display());
    Ok(Gateway {
        port,
        child: Mutex::new(Some(child)),
    })
}
