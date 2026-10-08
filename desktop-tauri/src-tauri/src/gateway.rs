//! 网关 sidecar 生命周期：端口发现 → 拉起 Bun → 就绪探测 → 退出清理 → 启动时回收孤儿。
//!
//! ## 关于孤儿回收（本模块最重要的设计决定）
//!
//! 计划里原本写「用 Tauri ≥2.12.1 的 `register_sidecar` / `cleanup_before_exit` 做孤儿回收」。
//! 经**本地 crate 源码核实**（见 `docs/plans/2026-10-07-tauri-shell-api-notes.md` §6.3）：
//! - `register_sidecar` / `kill_process_tree` 在 `tauri 2.12.1`、`tauri-plugin-shell 2.4.0`
//!   里**都不存在**；`Plugin::cleanup_before_exit` 只进了 `3.0.0-alpha.x`（PR #14443 的
//!   changeset 是 `minor:feat`，且实现里没有 PID 注册表）；
//! - 该 hook 自己的文档写明：**进程被杀、或直接调 `std::process::exit` 时不运行**；
//! - `tauri-plugin-shell` 在 v2 **没有任何退出钩子**。
//!
//! 还有一条更容易被忽略的：**`CommandChild::kill()` 只杀直接子进程**（底层 `shared_child`），
//! 而 Bun 跑 Next standalone 会派生孙进程。Electron 版正是为此用 `detached: true` 走进程组
//! （`desktop/main.js:226-285`）。
//!
//! 因此回收方案是「**PID 文件 + 退出钩子 + 启动时回收 + 按进程树杀**」，语义照抄 Electron 版：
//! `desktop/main.js:197`（`.gateway.pid`）、`:226-285`（先 SIGTERM 后 SIGKILL）、
//! `:328-345`（Windows 走 `taskkill /pid X /T /F`）。这不是退而求其次，而是唯一能覆盖全部
//! 死亡路径的做法（安装器强关、`std::process::exit` 都绕过事件循环）。

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
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
/// SIGTERM 后给子进程树的优雅退出窗口，超时再 SIGKILL（Electron 版同款两段式）。
const TERM_GRACE: Duration = Duration::from_millis(1500);

/// sidecar 逻辑名 = `bundle.externalBin` 的**基名**（去掉目标三元组）。
///
/// 刻意**不叫 `bun`**：Linux 的 deb 会把它装到 `/usr/bin/<基名>`，叫 `bun` 就会覆盖用户自己
/// 装的 Bun。见 `docs/plans/2026-10-07-tauri-bun-sidecar-packaging.md` §5/§6。
const SIDECAR_NAME: &str = "irouter-bun";

/// 打包形态下网关负载在资源目录里的相对路径。
const GATEWAY_DIR_IN_RESOURCES: &str = "gateway";
/// dev 形态的显式覆盖：`tauri dev` 不复制 resources，必须由 dev 脚本指路。
const GATEWAY_DIR_ENV: &str = "IROUTER_GATEWAY_DIR";

pub struct Gateway {
    pub port: u16,
    child: Mutex<Option<CommandChild>>,
    data_dir: PathBuf,
}

impl Gateway {
    /// 杀掉整棵进程树（先 SIGTERM 后 SIGKILL），并清掉 PID 文件。
    /// 可重复调用；`RunEvent::Exit` 与显式退出路径都会走它。
    pub fn kill(&self) {
        let taken = self.child.lock().expect("gateway lock poisoned").take();
        if let Some(child) = taken {
            let pid = child.pid();
            // 先杀树再杀直接子进程：父进程先死会让子孙被 reparent 到 init，之后就找不到了。
            kill_process_tree(pid);
            if let Err(e) = child.kill() {
                log::warn!("kill 子进程 pid={pid} 返回错误（树已处理）：{e}");
            }
            log::info!("已终止网关进程树 pid={pid}");
        }
        let _ = fs::remove_file(pid_file(&self.data_dir));
    }

    pub fn pid(&self) -> Option<u32> {
        self.child
            .lock()
            .expect("gateway lock poisoned")
            .as_ref()
            .map(|c| c.pid())
    }
}

fn pid_file(data_dir: &Path) -> PathBuf {
    data_dir.join(".gateway.pid")
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

/// 定位网关负载目录（含 `custom-server.js`）。三级回退，来源显式可查：
///   1. `IROUTER_GATEWAY_DIR`（dev 显式指路）
///   2. `<resource_dir>/gateway`（打包形态）
///   3. 仓库 `desktop/build/gateway/server`（同机 dev 且已跑过 build-server）
fn resolve_gateway_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var(GATEWAY_DIR_ENV) {
        let p = PathBuf::from(&dir);
        if p.join("custom-server.js").is_file() {
            return Ok(p);
        }
        return Err(format!("{GATEWAY_DIR_ENV}={dir} 下没有 custom-server.js"));
    }
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(GATEWAY_DIR_IN_RESOURCES);
        if p.join("custom-server.js").is_file() {
            return Ok(p);
        }
    }
    // 仓库回退：Phase 6 Step 1 把负载产出从 `desktop/build/` 搬到了仓库根 `build/`
    // （`tauri.conf.json` 的 resources 与 dev.mjs / 各 verify 脚本同步改过）。
    // ⚠️ 这条回退**只在没有 IROUTER_GATEWAY_DIR 时生效**（dev.mjs 会显式设它），
    // 所以路径写错不会立刻暴露——而旧位置若还残留着一份陈旧负载，就会**静默加载旧代码**。
    // 搬迁时旧目录已删除，避免这种"能用但用的是旧东西"的假绿。
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("build")
        .join("gateway")
        .join("server");
    if dev.join("custom-server.js").is_file() {
        return Ok(dev.canonicalize().unwrap_or(dev));
    }
    Err(format!(
        "找不到网关负载。已尝试：{GATEWAY_DIR_ENV} 环境变量、<resource_dir>/{GATEWAY_DIR_IN_RESOURCES}、\
         仓库 build/gateway/server。先跑 `npm --prefix desktop-tauri run gateway:build`。"
    ))
}

/// 端口发现：与 Electron 版同构（`desktop/main.js:128-158`）。bind 成功即视为空闲，
/// 取到后立即释放，交给 bun 去 bind。
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
/// 若令牌没被网关接受，网关会按 `custom-server.js:161-166` 直接切断连接，探测即失败。
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

/// 启动前回收上一次留下的网关孤儿。
///
/// 为什么必须有这一步：安装器强关、崩溃、`std::process::exit` 都**绕过** `RunEvent::Exit`，
/// 那些情况下 `.gateway.pid` 会留下来，而端口 20128 被一个看不见的进程占着——用户会看到
/// 「新启动的应用连不上网关」。Electron 版同款处理见 `desktop/main.js:226-285`。
pub fn reap_stale_gateway(data_dir: &Path) {
    let file = pid_file(data_dir);
    let Ok(text) = fs::read_to_string(&file) else {
        return;
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        log::warn!("{} 内容无法解析，删除", file.display());
        let _ = fs::remove_file(&file);
        return;
    };
    if pid == std::process::id() {
        let _ = fs::remove_file(&file);
        return;
    }
    log::warn!("发现上次残留的网关进程 pid={pid}，按进程树回收");
    kill_process_tree(pid);
    let _ = fs::remove_file(&file);
}

/// 杀掉一棵进程树。
///
/// Unix：**先枚举后代再杀**——若先杀父进程，子孙会被 reparent 到 init，之后就找不到它们了。
/// Windows：交给 `taskkill /T /F`（与 `desktop/main.js:328-345` 同款）。
pub fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
        match out {
            Ok(o) if o.status.success() => log::info!("taskkill 已终止进程树 pid={pid}"),
            Ok(o) => log::warn!(
                "taskkill pid={pid} 退出码 {:?}：{}",
                o.status.code(),
                String::from_utf8_lossy(&o.stderr).trim()
            ),
            Err(e) => log::warn!("调用 taskkill 失败：{e}"),
        }
    }

    #[cfg(unix)]
    {
        let mut victims = Vec::new();
        collect_descendants(pid, &mut victims);
        victims.push(pid);
        for p in &victims {
            unsafe { libc::kill(*p as i32, libc::SIGTERM) };
        }
        std::thread::sleep(TERM_GRACE);
        for p in &victims {
            unsafe { libc::kill(*p as i32, libc::SIGKILL) };
        }
        log::info!("已向 {} 个进程发送 SIGTERM/SIGKILL（根 pid={pid}）", victims.len());
    }
}

/// 用 `ps -eo pid=,ppid=` 建树，广度优先收集 pid 的全部后代。
#[cfg(unix)]
fn collect_descendants(pid: u32, out: &mut Vec<u32>) {
    let Ok(o) = std::process::Command::new("ps").args(["-eo", "pid=,ppid="]).output() else {
        return;
    };
    let text = String::from_utf8_lossy(&o.stdout);
    let pairs: Vec<(u32, u32)> = text
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .collect();
    let mut queue = vec![pid];
    while let Some(cur) = queue.pop() {
        for (child, parent) in &pairs {
            if *parent == cur && !out.contains(child) {
                out.push(*child);
                queue.push(*child);
            }
        }
    }
}

/// 拉起 Bun sidecar，返回持有子进程句柄的 `Gateway`。
pub fn spawn(app: &AppHandle, guard: &PanelGuard) -> Result<Gateway, String> {
    let gateway_dir = resolve_gateway_dir(app)?;
    let entry = gateway_dir.join("custom-server.js");
    let data_dir = resolve_data_dir(app)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;

    // 先回收上一次的孤儿，再找端口——否则「端口被看不见的进程占着」会让新实例退到 20129，
    // 而用户以为还在用 20128。
    reap_stale_gateway(&data_dir);

    let port = find_free_port().ok_or_else(|| {
        format!(
            "{DEFAULT_PORT}–{} 全部被占用，无法为网关找端口",
            DEFAULT_PORT + PORT_SCAN_SPAN - 1
        )
    })?;

    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("找不到 sidecar `{SIDECAR_NAME}`（externalBin 未配置或未就位）：{e}"))?
        .args([entry.to_string_lossy().to_string(), "--port".into(), port.to_string()])
        // cwd 必须是负载目录：引擎按 cwd 相对路径探测 open-sse/dlp/dlp_rules.yaml
        .current_dir(&gateway_dir)
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

    let pid = child.pid();
    if let Err(e) = fs::write(pid_file(&data_dir), pid.to_string()) {
        // 写不了 PID 文件不致命（本次运行的退出钩子仍在），但下次启动就回收不了孤儿，必须留痕
        log::warn!("写 PID 文件失败（下次启动将无法回收孤儿）：{e}");
    }

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

    log::info!("网关已拉起：pid={pid} port={port} dir={}", gateway_dir.display());
    Ok(Gateway {
        port,
        child: Mutex::new(Some(child)),
        data_dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_file_lives_in_data_dir() {
        assert!(pid_file(Path::new("/tmp/x")).ends_with(".gateway.pid"));
    }

    #[test]
    fn free_port_is_within_scan_span() {
        let p = find_free_port().expect("本机应至少有一个空闲端口");
        assert!((DEFAULT_PORT..DEFAULT_PORT + PORT_SCAN_SPAN).contains(&p));
    }

    #[test]
    fn reap_is_noop_without_pid_file() {
        let dir = std::env::temp_dir().join("irouter-reap-test-empty");
        let _ = fs::create_dir_all(&dir);
        let _ = fs::remove_file(pid_file(&dir));
        reap_stale_gateway(&dir); // 不应 panic
    }

    /// 真起一棵三层进程树并验证「先枚举后代再杀」确实全部回收。
    /// 这是 Phase 3 那条硬约束（三条死亡路径必须实测）在单元层面的最小证据。
    #[cfg(unix)]
    #[test]
    fn kills_grandchildren_not_just_the_direct_child() {
        use std::process::Command;
        // sh 里再套一层 sh：root → child → grandchild
        let mut root = Command::new("sh")
            .arg("-c")
            .arg("sh -c 'sleep 30' & echo $!; sleep 30")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn root");
        let root_pid = root.id();
        std::thread::sleep(Duration::from_millis(400));

        let mut victims = Vec::new();
        collect_descendants(root_pid, &mut victims);
        assert!(
            victims.len() >= 2,
            "应至少收集到 child 与 grandchild 两层，实际 {victims:?}"
        );

        kill_process_tree(root_pid);
        std::thread::sleep(Duration::from_millis(500));

        // 注意：**不能**用 kill(pid, 0) 判存活——僵尸进程仍占 PID，它照样返回 0。
        // 必须看 ps 的 stat（Z = 已死待回收）。第一版测试就栽在这个假阳性上。
        let alive = |p: u32| -> bool {
            if let Ok(o) = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &p.to_string()])
                .output()
            {
                let st = String::from_utf8_lossy(&o.stdout);
                let st = st.trim();
                if st.is_empty() {
                    return false;
                }
                return !st.starts_with('Z');
            }
            unsafe { libc::kill(p as i32, 0) == 0 }
        };
        for p in victims.iter().chain(std::iter::once(&root_pid)) {
            assert!(!alive(*p), "pid={p} 仍存活，树杀未覆盖");
        }
        let _ = root.wait();
    }
}
