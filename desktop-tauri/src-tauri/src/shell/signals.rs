//! SIGINT / SIGTERM 钩子：对齐 `desktop/main.js:2156-2157` 的
//! `process.on("SIGINT", quit)` / `process.on("SIGTERM", quit)`。
//!
//! ## 为什么必须有
//!
//! 没有它时 `kill -TERM <壳 pid>`（以及系统注销、Activity Monitor 强退）会**直接终止进程**，
//! `RunEvent::Exit` 不跑 → Bun 网关被留成孤儿，继续占着 20128。实测复现过（task-7 自测的收尾动作）。
//! Electron 版这条路径是通的，所以这是一处**一致性缺口**，不是可选优化。
//!
//! ## 安全模式：处理器里只置一个原子量
//!
//! 信号处理器运行在**异步信号上下文**里，能安全调用的只有异步信号安全函数：
//! 不能分配、不能加锁、不能调 Tauri（`AppHandle::exit` 会取锁并向事件循环投递消息）。
//! 所以：
//!   1. 处理器里**只做一次 lock-free 原子写**（`AtomicI32::store`，无分配无锁）；
//!   2. 一个普通线程每 50 ms 轮询，看到标记后调用**既有的退出路径** `window::quit()`。
//!
//! 走 `window::quit()` 而不是另写一套：它就是托盘/菜单「退出」用的那一个实现
//! （置 `quitting` → `gateway::kill()` 杀进程树 → `AppHandle::exit(0)`），
//! 与 `main.rs` 的 `RunEvent::Exit` 回收**幂等**（`Gateway::kill` 取走 child 后第二次是空操作），
//! 因此这里**没有第二份回收逻辑**。
//!
//! ## Windows
//!
//! Windows 没有 SIGTERM/SIGINT 这套语义，且 `libc` 在本 crate 里是 **unix-only** 依赖
//! （`Cargo.toml` 的 `[target.'cfg(unix)'.dependencies]`），所以本模块在 Windows 上是**空实现**。
//! Windows 上真正需要覆盖的三条路径与现状：
//!   - `taskkill <pid>`（无 `/F`）：向窗口投 `WM_CLOSE` → 走我们的 `CloseRequested` 拦截
//!     （默认 `closeAction=dock` → 隐藏到托盘，应用不退）——与 Electron 同款行为；
//!   - `taskkill /F` / 任务管理器「结束任务」：强杀，**任何钩子都跑不到**（Electron 同样跑不到），
//!     只能靠下次启动的 `gateway::reap_stale_gateway()` 回收；
//!   - 控制台 Ctrl+C：需要 `SetConsoleCtrlHandler`，那要引入 `windows-sys`（新 crate）。
//!     当前不做——GUI 进程通常没有控制台，收益极低；若将来要做，先由 Lead 批准依赖。

#[cfg(unix)]
pub fn install(app: &tauri::AppHandle) {
    imp::install(app);
}

#[cfg(not(unix))]
pub fn install(app: &tauri::AppHandle) {
    // Windows（见模块头注释）：SIGTERM/SIGINT 语义不存在、libc 也不可用 → 空实现。
    let _ = app;
    log::info!("信号钩子：当前平台不支持 SIGINT/SIGTERM，跳过（强杀路径靠启动时回收，见 gateway.rs）");
}

#[cfg(unix)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
    use std::time::Duration;

    use tauri::AppHandle;

    /// 监视线程轮询间隔。50 ms 对"用户按了 Ctrl+C"来说无感，代价可忽略。
    const POLL_INTERVAL: Duration = Duration::from_millis(50);

    /// 收到的信号编号；0 = 没有。处理器里**只**写这个。
    static PENDING_SIGNAL: AtomicI32 = AtomicI32::new(0);
    /// 是否已安装（幂等，防重复 `init`）。
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    /// 信号处理器。**只能做异步信号安全的事**：这里就是一次无锁原子写。
    extern "C" fn on_signal(signum: libc::c_int) {
        PENDING_SIGNAL.store(signum, Ordering::SeqCst);
    }

    pub fn install(app: &AppHandle) {
        if INSTALLED.swap(true, Ordering::SeqCst) {
            return;
        }
        for signum in [libc::SIGTERM, libc::SIGINT] {
            // SAFETY: `on_signal` 只做一次原子写；`libc::signal` 是进程级的、在 setup（主线程）
            // 调用一次，不存在并发安装。返回值（旧处理器）不需要恢复。
            unsafe {
                libc::signal(signum, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
            }
        }
        log::info!("已安装 SIGTERM/SIGINT 钩子（对齐 main.js:2156-2157）");

        // 监视线程：**不在信号上下文里**做事，所以可以安全调用 Tauri。
        let handle = app.clone();
        let spawned = std::thread::Builder::new()
            .name("irouter-signal-watch".to_string())
            .spawn(move || loop {
                std::thread::sleep(POLL_INTERVAL);
                let signum = PENDING_SIGNAL.swap(0, Ordering::SeqCst);
                if signum == 0 {
                    continue;
                }
                let name = match signum {
                    libc::SIGTERM => "SIGTERM",
                    libc::SIGINT => "SIGINT",
                    _ => "未知信号",
                };
                log::info!("收到 {name}（{signum}）→ 走正常退出路径（回收网关后再退出）");
                // 恢复默认处置：若退出流程意外卡住，**再按一次 Ctrl+C / 再 kill 一次**就能立刻
                // 终止进程（此时可能留下孤儿网关，由下次启动的 `gateway::reap_stale_gateway` 回收）。
                // 在普通线程里调整处置是安全的；这行**不能**放进信号处理器。
                for sig in [libc::SIGTERM, libc::SIGINT] {
                    // SAFETY: 仅把处置恢复为默认，参数合法。
                    unsafe { libc::signal(sig, libc::SIG_DFL); }
                }
                // 复用唯一的退出实现：置 quitting → kill 网关进程树 → AppHandle::exit(0)
                // → RunEvent::Exit（main.rs 的回收与这里幂等）。
                crate::shell::window::quit(&handle);
                return;
            });
        if let Err(e) = spawned {
            log::error!("启动信号监视线程失败，SIGTERM/SIGINT 将不会触发回收：{e}");
            INSTALLED.store(false, Ordering::SeqCst);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 处理器只做一次原子写：这里直接调它，验证状态机（不需要真发信号）。
        #[test]
        fn handler_only_records_the_signal_number() {
            PENDING_SIGNAL.store(0, Ordering::SeqCst);
            on_signal(libc::SIGTERM);
            assert_eq!(PENDING_SIGNAL.load(Ordering::SeqCst), libc::SIGTERM);
            // 轮询线程的取值语义：swap 之后归零，避免重复触发
            assert_eq!(PENDING_SIGNAL.swap(0, Ordering::SeqCst), libc::SIGTERM);
            assert_eq!(PENDING_SIGNAL.load(Ordering::SeqCst), 0);
            on_signal(libc::SIGINT);
            assert_eq!(PENDING_SIGNAL.swap(0, Ordering::SeqCst), libc::SIGINT);
        }
    }
}
