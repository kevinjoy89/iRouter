//! 更新器的进程内存态（设计 §8）。
//!
//! 三个状态都**只活在进程里**，重启即失——这是照抄的既有语义（`main.js:45-47`）：
//! `download-update` / `install-update` 在重启后分别以
//! `No update asset available for download` / `No downloaded package found` 失败。
//! **不要**把它们做成"从磁盘恢复"——那会引入新的失败面。
//!
//! 并发语义（照抄 `main.js`）：
//!   - `latestCheckedUpdate` / `downloadedPackagePath` 无锁（后完成者覆盖）；
//!   - `download`：第二次 `download-update` 会 **abort 掉第一次**（`:715-717`）；
//!   - 清空 controller **不等于**取消（`finally` 只是置 null），所以 `take_download()`
//!     只交出句柄、不触发取消。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use reqwest::Client;

use super::checker::CheckResult;
use super::download::DownloadHandle;
use super::http;

pub struct UpdaterState {
    latest_checked: Mutex<Option<CheckResult>>,
    downloaded_path: Mutex<Option<PathBuf>>,
    download: Mutex<Option<DownloadHandle>>,
    client: Option<Client>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdaterState {
    /// HTTP 客户端在装载时建一次（失败只记日志：更新通道坏掉不该拖垮启动）。
    pub fn new() -> Self {
        let client = match http::build_client() {
            Ok(c) => Some(c),
            Err(e) => {
                log::error!("更新器 HTTP 客户端初始化失败：{e}");
                None
            }
        };
        Self {
            latest_checked: Mutex::new(None),
            downloaded_path: Mutex::new(None),
            download: Mutex::new(None),
            client,
        }
    }

    /// 共享的 HTTP 客户端（`Client` 内部是 Arc，clone 很便宜）。
    ///
    /// 装载时建失败才会走到兜底分支——那是 TLS 后端整体不可用的场景，
    /// 此时退化成 `Client::new()` 的默认策略（10 跳重定向）。
    pub fn client(&self) -> Client {
        if let Some(c) = self.client.as_ref() {
            return c.clone();
        }
        http::build_client().unwrap_or_else(|_| Client::new())
    }

    // ---- latestCheckedUpdate ----
    pub fn latest(&self) -> Option<CheckResult> {
        lock(&self.latest_checked).clone()
    }

    pub fn set_latest(&self, result: CheckResult) {
        *lock(&self.latest_checked) = Some(result);
    }

    // ---- downloadedPackagePath ----
    pub fn downloaded(&self) -> Option<PathBuf> {
        lock(&self.downloaded_path).clone()
    }

    pub fn set_downloaded(&self, path: PathBuf) {
        *lock(&self.downloaded_path) = Some(path);
    }

    // ---- 下载句柄（AbortController 的对应物）----
    /// 取出当前句柄（**不取消**，调用方决定）。
    pub fn take_download(&self) -> Option<DownloadHandle> {
        lock(&self.download).take()
    }

    pub fn put_download(&self, handle: DownloadHandle) {
        *lock(&self.download) = Some(handle);
    }

    /// `finally { currentDownloadAbortController = null }`（`main.js:771-773`）。
    /// 无条件清空 —— 两个并发下载时，先结束的那个会把后一个的句柄也清掉，这是现实现
    /// 的既有行为（`cancel-download` 会因此返回 false），照抄。
    pub fn clear_download(&self) {
        *lock(&self.download) = None;
    }
}

/// 锁中毒（某个下载任务 panic）不应该让整个更新通道永久失效：取回内部值继续用。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_and_downloaded_are_process_memory_only() {
        let s = UpdaterState::new();
        assert!(s.latest().is_none());
        assert!(s.downloaded().is_none());

        s.set_latest(CheckResult::initial(Some("0.3.1")));
        assert_eq!(s.latest().unwrap().latest.as_deref(), Some("0.3.1"));

        s.set_downloaded(PathBuf::from("/tmp/x.dmg"));
        assert_eq!(s.downloaded(), Some(PathBuf::from("/tmp/x.dmg")));
    }

    #[test]
    fn taking_the_download_handle_does_not_cancel_and_clearing_is_idempotent() {
        let s = UpdaterState::new();
        let (handle, signal) = super::super::download::cancel_channel();
        s.put_download(handle);
        let taken = s.take_download().expect("handle");
        assert!(!signal.is_canceled(), "取出句柄不等于取消");
        assert!(s.take_download().is_none());
        s.clear_download(); // 幂等
        taken.cancel();
        assert!(signal.is_canceled(), "显式 cancel 才置位");
    }

    #[test]
    fn poisoned_lock_still_yields_state() {
        let s = std::sync::Arc::new(UpdaterState::new());
        let s2 = s.clone();
        let _ = std::thread::spawn(move || {
            let _guard = s2.latest_checked.lock().unwrap();
            panic!("boom");
        })
        .join();
        // 中毒后仍可读写（否则一次 panic 就永久断更）
        s.set_latest(CheckResult::initial(Some("0.3.2")));
        assert_eq!(s.latest().unwrap().latest.as_deref(), Some("0.3.2"));
    }
}
