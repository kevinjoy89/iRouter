//! 文件流式下载 —— `desktop/updater/download.js` 的行为等价移植（设计 §2.5/§8）。
//!
//! ## 照抄要点
//!   - 下载目录 = `$HOME/Downloads`（**不读 XDG**、不看 `IROUTER_USER_DATA`，`download.js:20-22`）。
//!     只有 debug 构建才认 `IROUTER_UPDATE_DOWNLOAD_DIR`（设计 §12.2 的测试接缝）。
//!   - 写 `<dir>/<fileName>.part`，成功后 `rename` 去掉后缀；失败/取消**删掉 `.part`**。
//!   - `onProgress` **每个 chunk 一次**（节流在 `events.rs`，那是 emit 成本问题，不是下载语义）。
//!   - **不设总超时**：JS `downloadFile` 没有 timeout，139 MB 的 dmg 加总超时会掐死正常下载。
//!
//! ## 已登记的既有缺陷
//!   - **D-10**：进程被强杀时 `.part` 会留在用户可见的 Downloads 目录，且**没有**任何启动期
//!     清理逻辑（✅grep `desktop/**/*.js` 的 `.part` 只出现在下载流程内部）。照抄。
//!   - **D-3**：取消下载时命令会 reject 且 emit `shell:update-error`（面板可能落 error 态）。
//!     Lead 已签字「照抄」，理由见 `commands.rs` 的单点注释。

use std::path::{Path, PathBuf};

use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::Client;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

use super::error::UpdaterError;
use super::http;

/// UA 逐字对齐 `download.js:38` / `checker.js:38`（两处 JS 是同一个字面量）。
///
/// 用 re-export 而不是再写一份字面量：两处必须永远一致，重复定义就是将来分叉的入口。
pub use super::http::DEFAULT_USER_AGENT;

/// `{downloaded, total, percent}` —— `shell:update-progress` 的 payload（字段名 camelCase）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: u32,
}

impl DownloadProgress {
    /// `total > 0 ? min(100, round(downloaded/total*100)) : 0`（`download.js:179-181`）。
    pub fn new(downloaded: u64, total: u64) -> Self {
        let percent = if total > 0 {
            ((downloaded as f64 / total as f64) * 100.0).round().min(100.0) as u32
        } else {
            0
        };
        Self {
            downloaded,
            total,
            percent,
        }
    }
}

/// 取消句柄（`AbortController` 的对应物）。可重复取消。
pub struct DownloadHandle {
    tx: watch::Sender<bool>,
}

impl DownloadHandle {
    pub fn cancel(&self) {
        let _ = self.tx.send(true);
    }
}

/// 下载侧持有的取消信号（`AbortSignal` 的对应物）。
pub struct CancelSignal {
    rx: watch::Receiver<bool>,
}

impl CancelSignal {
    pub fn is_canceled(&self) -> bool {
        *self.rx.borrow()
    }

    /// 等到被取消（已取消则立即返回）。
    ///
    /// ⚠️ 细节：`watch` 的**发送端被 drop** 会让 `changed()` 返回 `Err`，而"清空
    /// controller"（`state.clear_download()` / `take_download()`）正是 drop 发送端。
    /// 若把 `Err` 当成取消，`finally` 清空句柄就会**把正在进行的下载掐死**——所以这里
    /// 只在值真的为 `true` 时才返回，发送端消失则永远 pending。
    async fn cancelled(&mut self) {
        loop {
            if *self.rx.borrow() {
                return;
            }
            match self.rx.changed().await {
                Ok(()) => continue,
                Err(_) => {
                    // 句柄被清空/丢弃 ≠ 用户取消
                    std::future::pending::<()>().await;
                    return;
                }
            }
        }
    }
}

/// 建一对取消句柄/信号。
pub fn cancel_channel() -> (DownloadHandle, CancelSignal) {
    let (tx, rx) = watch::channel(false);
    (DownloadHandle { tx }, CancelSignal { rx })
}

/// `path.join(os.homedir(), "Downloads")`（`download.js:20-22`）。
///
/// **不要**换成 `dirs::download_dir()`：那会读 XDG user-dirs，Linux 中文系统上会指向
/// `~/下载` 之类，是行为变更。
pub fn default_downloads_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(dir) = std::env::var_os("IROUTER_UPDATE_DOWNLOAD_DIR") {
            if !dir.is_empty() {
                return PathBuf::from(dir);
            }
        }
    }
    home_dir()
        .map(|h| h.join("Downloads"))
        .unwrap_or_else(|| PathBuf::from("Downloads"))
}

/// Node `os.homedir()` 的等价物：POSIX 用 `$HOME`，Windows 用 `USERPROFILE`
/// （再退 `HOMEDRIVE`+`HOMEPATH`）。
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(p) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(p));
        }
        let drive = std::env::var_os("HOMEDRIVE")?;
        let path = std::env::var_os("HOMEPATH")?;
        let mut joined = PathBuf::from(drive);
        joined.push(path);
        return Some(joined);
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }
}

/// `download.js:32-68`：只用于取 `checksums.txt`，UA `iRouter-Desktop`，超时 15s。
pub async fn fetch_text(client: &Client, url: &str) -> Result<String, UpdaterError> {
    http::fetch_text(client, url, DEFAULT_USER_AGENT).await
}

/// `downloadFile({...})` 的入参。
pub struct DownloadOptions<'a> {
    pub url: &'a str,
    /// 缺省 = `$HOME/Downloads`
    pub destination_dir: Option<&'a Path>,
    pub file_name: &'a str,
    /// 服务端没给 `Content-Length` 时的后备（`main.js:725` 传 `assetSize`）
    pub size_hint: u64,
    pub cancel: Option<CancelSignal>,
}

/// 流式下载；返回**最终绝对路径**。
///
/// 行为顺序严格照抄 `download.js:83-226`：
/// 参数校验 → 入口取消检查 → mkdir → 请求（手动跟随重定向）→ 状态检查 →
/// 写 `.part` 并逐 chunk 回调 → flush/close → 收尾取消检查 → rename。
pub async fn download_file<F>(
    client: &Client,
    opts: DownloadOptions<'_>,
    mut on_progress: F,
) -> Result<PathBuf, UpdaterError>
where
    F: FnMut(DownloadProgress) + Send,
{
    if opts.url.is_empty() || opts.file_name.is_empty() {
        return Err(UpdaterError::MissingArgs);
    }
    let mut cancel = opts.cancel;
    if cancel.as_ref().map(CancelSignal::is_canceled).unwrap_or(false) {
        return Err(UpdaterError::Aborted);
    }

    let dir: PathBuf = match opts.destination_dir {
        Some(d) => d.to_path_buf(),
        None => default_downloads_dir(),
    };
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| UpdaterError::CreateDir(e.to_string()))?;

    let part_path = dir.join(format!("{}.part", opts.file_name));
    let final_path = dir.join(opts.file_name);

    // Drop guard 要在 file 之前声明：作用域退出时 file 先 drop、再删 .part
    // （Windows 上删除仍被打开的文件会失败）。
    let mut part = PartGuard::new(part_path.clone());

    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(v) = reqwest::header::HeaderValue::from_str(DEFAULT_USER_AGENT) {
        headers.insert(USER_AGENT, v);
    }
    if let Ok(v) = reqwest::header::HeaderValue::from_str("*/*") {
        headers.insert(ACCEPT, v);
    }

    // 不设超时：见文件头注释
    let (resp, _final_url) = http::get_following_redirects(
        client,
        opts.url,
        &headers,
        None,
        || UpdaterError::RequestTimeout,
    )
    .await?;

    let status = resp.status();
    if status != reqwest::StatusCode::OK {
        // JS 在这里就 cleanup + reject（`download.js:165-169`）
        return Err(UpdaterError::DownloadHttp(status.as_u16()));
    }

    // `parseInt(content-length) || sizeHint || 0`
    let total = resp.content_length().unwrap_or(0);
    let total = if total > 0 { total } else { opts.size_hint };

    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(UpdaterError::from)?;
    let mut resp = resp;
    let mut downloaded: u64 = 0;

    loop {
        let chunk = {
            let wait_cancel = cancelled(&mut cancel);
            tokio::pin!(wait_cancel);
            tokio::select! {
                _ = &mut wait_cancel => {
                    // `handleAbort`：destroy + cleanup + "Download canceled by user"
                    let _ = file.flush().await;
                    drop(file);
                    return Err(UpdaterError::Canceled);
                }
                chunk = resp.chunk() => chunk,
            }
        };

        match chunk {
            Ok(None) => break,
            Ok(Some(bytes)) => {
                if let Err(e) = file.write_all(&bytes).await {
                    drop(file);
                    return Err(UpdaterError::from(e));
                }
                downloaded += bytes.len() as u64;
                on_progress(DownloadProgress::new(downloaded, total));
            }
            Err(e) => {
                drop(file);
                return Err(UpdaterError::from(e));
            }
        }
    }

    if let Err(e) = file.flush().await {
        drop(file);
        return Err(UpdaterError::from(e));
    }
    drop(file);

    // `finish` 之后才发现已 abort → "Download canceled"（注意文案**不带** by user）
    if cancel.as_ref().map(CancelSignal::is_canceled).unwrap_or(false) {
        return Err(UpdaterError::CanceledAtFinalize);
    }

    match tokio::fs::rename(&part_path, &final_path).await {
        Ok(()) => {
            part.disarm();
            Ok(final_path)
        }
        Err(first_err) => {
            // 设计 §2.5 陷阱 3：Windows 上目标存在/被占用时 std::fs::rename 与 Node 不一定一致。
            // 稳妥路径：删掉目标再试一次；仍失败才报 Finalize。
            if tokio::fs::remove_file(&final_path).await.is_ok() {
                match tokio::fs::rename(&part_path, &final_path).await {
                    Ok(()) => {
                        part.disarm();
                        return Ok(final_path);
                    }
                    Err(second) => return Err(UpdaterError::Finalize(second.to_string())),
                }
            }
            Err(UpdaterError::Finalize(first_err.to_string()))
        }
    }
}

/// 取消信号 → future；没有信号时永不完成（`select!` 的占位）。
async fn cancelled(signal: &mut Option<CancelSignal>) {
    match signal {
        Some(s) => s.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

/// 失败/取消时删除 `.part`（`cleanup`，`download.js:117-134`）。Drop 里用同步 fs，
/// 且**忽略错误**（照抄"忽略删除错误"）。
struct PartGuard {
    path: PathBuf,
    armed: bool,
}

impl PartGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PartGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::testserver::{spawn, Reply};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("irouter-updater-download-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn client() -> Client {
        http::build_client().unwrap()
    }

    #[test]
    fn percent_formula_matches_js() {
        assert_eq!(DownloadProgress::new(0, 0).percent, 0);
        assert_eq!(DownloadProgress::new(50, 0).percent, 0, "total=0 → 恒 0");
        assert_eq!(DownloadProgress::new(1, 3).percent, 33);
        assert_eq!(DownloadProgress::new(2, 3).percent, 67);
        assert_eq!(DownloadProgress::new(1, 8).percent, 13, "Math.round(12.5)=13");
        assert_eq!(DownloadProgress::new(10, 1).percent, 100, "钳到 100");
        assert_eq!(DownloadProgress::new(157_000_000, 157_000_000).percent, 100);
    }

    #[test]
    fn downloads_to_final_path_and_removes_part() {
        let dir = tmp_dir("ok");
        let body = vec![7u8; 4096];
        let port = spawn(move |_, _| Reply::text(200, body.clone()));
        let seen: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();

        let path = block_on(download_file(
            &client(),
            DownloadOptions {
                url: &format!("http://127.0.0.1:{port}/file.dmg"),
                destination_dir: Some(&dir),
                file_name: "iRouter-0.3.7-macos-arm64.dmg",
                size_hint: 0,
                cancel: None,
            },
            move |p| seen2.lock().unwrap().push(p.downloaded),
        ))
        .unwrap();

        assert_eq!(path, dir.join("iRouter-0.3.7-macos-arm64.dmg"));
        assert_eq!(std::fs::read(&path).unwrap().len(), 4096);
        assert!(!dir.join("iRouter-0.3.7-macos-arm64.dmg.part").exists());
        let progress = seen.lock().unwrap();
        assert!(!progress.is_empty(), "每个 chunk 都要回调");
        assert_eq!(*progress.last().unwrap(), 4096);
    }

    #[test]
    fn follows_redirects_before_writing() {
        let dir = tmp_dir("redirect");
        let port = spawn(|path, _| match path {
            "/start" => Reply::redirect("/real"),
            _ => Reply::text(200, "payload"),
        });
        let path = block_on(download_file(
            &client(),
            DownloadOptions {
                url: &format!("http://127.0.0.1:{port}/start"),
                destination_dir: Some(&dir),
                file_name: "a.bin",
                size_hint: 0,
                cancel: None,
            },
            |_| {},
        ))
        .unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "payload");
    }

    #[test]
    fn falls_back_to_size_hint_without_content_length() {
        let dir = tmp_dir("nolen");
        let port = spawn(|_, _| Reply::no_content_length("0123456789"));
        let total_seen = Arc::new(AtomicU64::new(u64::MAX));
        let total_seen2 = total_seen.clone();
        let path = block_on(download_file(
            &client(),
            DownloadOptions {
                url: &format!("http://127.0.0.1:{port}/x"),
                destination_dir: Some(&dir),
                file_name: "b.bin",
                size_hint: 4,
                cancel: None,
            },
            move |p| {
                total_seen2.store(p.total, Ordering::SeqCst);
            },
        ))
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "0123456789");
        assert_eq!(total_seen.load(Ordering::SeqCst), 4, "无 content-length → sizeHint");
    }

    #[test]
    fn http_error_removes_part_and_reports_verbatim() {
        let dir = tmp_dir("404");
        let port = spawn(|_, _| Reply::text(404, "nope"));
        let e = block_on(download_file(
            &client(),
            DownloadOptions {
                url: &format!("http://127.0.0.1:{port}/gone.dmg"),
                destination_dir: Some(&dir),
                file_name: "gone.dmg",
                size_hint: 0,
                cancel: None,
            },
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(e.message(), "Download failed with HTTP 404");
        assert!(!dir.join("gone.dmg.part").exists());
    }

    #[test]
    fn cancel_during_transfer_removes_part_and_says_canceled_by_user() {
        let dir = tmp_dir("cancel");
        let chunks: Vec<Vec<u8>> = (0..40).map(|_| vec![1u8; 1024]).collect();
        let port = spawn(move |_, _| {
            Reply::drip(chunks.clone(), Duration::from_millis(20))
        });
        let (handle, signal) = cancel_channel();
        let progress = Arc::new(AtomicU64::new(0));
        let progress2 = progress.clone();

        let canceller = std::thread::spawn(move || {
            // 等到至少收到一次进度再取消
            while progress2.load(Ordering::SeqCst) == 0 {
                std::thread::sleep(Duration::from_millis(5));
            }
            handle.cancel();
        });

        let e = block_on(download_file(
            &client(),
            DownloadOptions {
                url: &format!("http://127.0.0.1:{port}/big.dmg"),
                destination_dir: Some(&dir),
                file_name: "big.dmg",
                size_hint: 0,
                cancel: Some(signal),
            },
            |p| {
                progress.store(p.downloaded, Ordering::SeqCst);
            },
        ))
        .unwrap_err();

        canceller.join().unwrap();
        assert_eq!(e.message(), "Download canceled by user");
        assert!(!dir.join("big.dmg.part").exists(), "取消必须删 .part");
        assert!(!dir.join("big.dmg").exists(), "取消不得产生最终文件");
    }

    #[test]
    fn cancel_before_start_is_aborted() {
        let dir = tmp_dir("precancel");
        let (handle, signal) = cancel_channel();
        handle.cancel();
        let e = block_on(download_file(
            &client(),
            DownloadOptions {
                url: "http://127.0.0.1:1/never",
                destination_dir: Some(&dir),
                file_name: "x.bin",
                size_hint: 0,
                cancel: Some(signal),
            },
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(e.message(), "Download aborted");
    }

    #[test]
    fn missing_url_or_filename_is_rejected_before_any_io() {
        let dir = tmp_dir("missing");
        let e = block_on(download_file(
            &client(),
            DownloadOptions {
                url: "",
                destination_dir: Some(&dir),
                file_name: "x.bin",
                size_hint: 0,
                cancel: None,
            },
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(e.message(), "URL and fileName are required for download");

        let e2 = block_on(download_file(
            &client(),
            DownloadOptions {
                url: "http://127.0.0.1:1/x",
                destination_dir: Some(&dir),
                file_name: "",
                size_hint: 0,
                cancel: None,
            },
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(e2.message(), "URL and fileName are required for download");
    }

    #[test]
    fn directory_creation_failure_is_reported() {
        let dir = tmp_dir("mkdirfail");
        let blocker = dir.join("blocked");
        std::fs::write(&blocker, b"i am a file").unwrap();
        let e = block_on(download_file(
            &client(),
            DownloadOptions {
                url: "http://127.0.0.1:1/x",
                destination_dir: Some(&blocker),
                file_name: "x.bin",
                size_hint: 0,
                cancel: None,
            },
            |_| {},
        ))
        .unwrap_err();
        assert!(
            e.message().starts_with("Failed to create directory: "),
            "{}",
            e.message()
        );
    }

    #[test]
    fn overwrites_an_existing_final_file() {
        let dir = tmp_dir("overwrite");
        let target = dir.join("dup.bin");
        std::fs::write(&target, b"old").unwrap();
        let port = spawn(|_, _| Reply::text(200, "new"));
        let path = block_on(download_file(
            &client(),
            DownloadOptions {
                url: &format!("http://127.0.0.1:{port}/dup.bin"),
                destination_dir: Some(&dir),
                file_name: "dup.bin",
                size_hint: 0,
                cancel: None,
            },
            |_| {},
        ))
        .unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "new");
    }

    #[test]
    fn default_downloads_dir_is_home_downloads() {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        // 测试进程可能设了 IROUTER_UPDATE_DOWNLOAD_DIR，这里只断言"以 Downloads 结尾"
        // 且不读 XDG（XDG_DOWNLOAD_DIR / user-dirs.dirs 在本函数里没有任何引用）
        let dir = default_downloads_dir();
        assert!(dir.to_string_lossy().ends_with("Downloads"));
        if let Some(home) = home {
            if std::env::var_os("IROUTER_UPDATE_DOWNLOAD_DIR").is_none() {
                assert_eq!(dir, home.join("Downloads"));
            }
        }
    }
}
