//! 错误类型与**文案稳定性**。
//!
//! 面板直接把错误文案渲染给用户（`main.js:749,768` → `UpdateSettings.js:53-56,303-305`），
//! 所以 §2 各函数"错误"列里带引号的字符串**必须逐字复刻**（设计 §14.2）。
//!
//! ## 已知的可接受偏差（必须写进验收记录，不要试图"修好"）
//!
//! 1. **Node 原始 fs / 网络错误的 `.message` 无法逐字复刻**。JS 会把
//!    `EACCES: permission denied, open '/x/y'`、`getaddrinfo ENOTFOUND api.github.com`
//!    这类原文一路透传到面板；Rust 的 `io::Error` / `reqwest::Error` Display 必然是另一种
//!    措辞（如 `Permission denied (os error 13)`、`error sending request for url (...)`）。
//!    设计 §2.3 明确把这条记为可接受偏差。
//! 2. `Invalid JSON response: <msg>` 的 `<msg>` 来自各自的 JSON 解析器，措辞不同。

/// 更新器错误。`Display` 的输出就是发给面板的文案。
#[derive(Debug, thiserror::Error)]
pub enum UpdaterError {
    // ---- 逐字复刻（设计 §2 / §14.2）----
    #[error("No update asset available for download")]
    NoAssetAvailable,
    #[error("No downloaded package found")]
    NoDownloadedPackage,
    #[error("Checksum for {0} not found in checksums.txt")]
    ChecksumMissing(String),
    #[error("SHA-256 verification failed")]
    ChecksumMismatch,
    #[error("Update check timed out")]
    CheckTimeout,
    #[error("GitHub API HTTP {0}")]
    HttpStatus(u16),
    #[error("Invalid JSON response: {0}")]
    InvalidJson(String),
    #[error("Download failed with HTTP {0}")]
    DownloadHttp(u16),
    #[error("Download canceled by user")]
    Canceled,
    /// `download.js:196` 的收尾竞态分支（`finish` 之后才发现已 abort）
    #[error("Download canceled")]
    CanceledAtFinalize,
    #[error("Download aborted")]
    Aborted,
    #[error("URL and fileName are required for download")]
    MissingArgs,
    #[error("Failed to create directory: {0}")]
    CreateDir(String),
    #[error("Failed to finalize file: {0}")]
    Finalize(String),
    #[error("HTTP {status} fetching {url}")]
    FetchTextHttp { status: u16, url: String },
    #[error("Request timed out")]
    RequestTimeout,
    #[error("File path is required")]
    FilePathRequired,

    // ---- 无法逐字复刻 / 新增（可接受偏差，见文件头）----
    /// `checker.js:186` 的兜底：`err.message || "Failed to check for updates"`
    #[error("Failed to check for updates")]
    CheckFailed,
    /// 调起系统安装器失败（D-5：设计 §10.4 让这里**返回 Err**，由调用方决定是否退出）
    #[error("Failed to launch installer: {0}")]
    LaunchFailed(String),
    /// Node fs 错误文案与 Rust 不同（可接受偏差 ①）
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// 网络层原始错误透传（可接受偏差 ①）
    #[error("{0}")]
    Http(#[from] reqwest::Error),
}

impl UpdaterError {
    /// 发给面板的字符串（面板只认字符串，见 `contract` 第 2 条）。
    pub fn message(&self) -> String {
        self.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 逐字锁定：这几条文案面板会直接渲染，改动等于改 UI。
    #[test]
    fn messages_are_verbatim_from_the_js_implementation() {
        assert_eq!(
            UpdaterError::NoAssetAvailable.to_string(),
            "No update asset available for download"
        );
        assert_eq!(
            UpdaterError::NoDownloadedPackage.to_string(),
            "No downloaded package found"
        );
        assert_eq!(
            UpdaterError::ChecksumMissing("a.dmg".into()).to_string(),
            "Checksum for a.dmg not found in checksums.txt"
        );
        assert_eq!(
            UpdaterError::ChecksumMismatch.to_string(),
            "SHA-256 verification failed"
        );
        assert_eq!(
            UpdaterError::CheckTimeout.to_string(),
            "Update check timed out"
        );
        assert_eq!(UpdaterError::HttpStatus(404).to_string(), "GitHub API HTTP 404");
        assert_eq!(
            UpdaterError::DownloadHttp(500).to_string(),
            "Download failed with HTTP 500"
        );
        assert_eq!(
            UpdaterError::Canceled.to_string(),
            "Download canceled by user"
        );
        assert_eq!(UpdaterError::CanceledAtFinalize.to_string(), "Download canceled");
        assert_eq!(UpdaterError::Aborted.to_string(), "Download aborted");
        assert_eq!(
            UpdaterError::MissingArgs.to_string(),
            "URL and fileName are required for download"
        );
        assert_eq!(
            UpdaterError::CreateDir("boom".into()).to_string(),
            "Failed to create directory: boom"
        );
        assert_eq!(
            UpdaterError::Finalize("boom".into()).to_string(),
            "Failed to finalize file: boom"
        );
        assert_eq!(
            UpdaterError::FetchTextHttp {
                status: 404,
                url: "https://x/y".into()
            }
            .to_string(),
            "HTTP 404 fetching https://x/y"
        );
        assert_eq!(
            UpdaterError::RequestTimeout.to_string(),
            "Request timed out"
        );
        assert_eq!(
            UpdaterError::FilePathRequired.to_string(),
            "File path is required"
        );
        assert_eq!(
            UpdaterError::CheckFailed.to_string(),
            "Failed to check for updates"
        );
    }

    #[test]
    fn io_errors_pass_their_display_through() {
        let e = UpdaterError::from(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "EACCES: permission denied, open '/x/y'",
        ));
        assert!(e.message().contains("EACCES: permission denied"));
    }
}
