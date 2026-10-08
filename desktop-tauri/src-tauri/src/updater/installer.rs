//! 安装包调起 —— `desktop/updater/installer.js` 的移植（设计 §2.6/§10.4，含 **D-5 修正**）。
//!
//! ## 与现实现的**有意偏差**（D-5，设计建议直接修，Lead 已签字）
//! `installer.js:57-66` 的 `spawn(cmd, args)` 把 `resolve(true)` 放在 `try` 里同步执行，
//! 且**没有监听子进程的 `'error'` 事件**——Linux 上缺 `xdg-open` 时它照样 resolve(true)，
//! 随后 `main.js:793-795` 500ms 后退出应用：用户看到"应用消失、什么都没发生"。
//!
//! Rust 侧改用 `tauri_plugin_opener::open_path`（设计 §10.4）：
//!   - macOS：`/usr/bin/open` 且**等待其返回**（不会留僵尸）；
//!   - Windows：ShellExecute（避开 `cmd /c start` 的引号坑）；
//!   - Linux：`xdg-open → gio open → gnome-open → kde-open` 逐级回退（**严格优于**现状）；
//!   - `with == None` 时会先 `path.metadata()` → **文件不存在返回 Err**。
//!
//! 调用方（`commands.rs`）据此**决定是否退出应用**，并在失败时保持运行。

use std::path::Path;

use super::error::UpdaterError;
use super::jscompat::js_to_lowercase;

/// 等价于 JS `isArchivePackage`（`installer.js:17-23`）：`.zip` / `.tar.gz`，大小写不敏感。
///
/// 面板据此多显示一行 "Portable archive saved to Downloads folder"
/// （`UpdateSettings.js:293-297`）。**注意按钮文案不区分**：portable zip 也显示
/// "Install and Relaunch"（`:227-230`），点下去是"用系统默认程序打开 zip"。
pub fn is_archive_package(path: &Path) -> bool {
    let Some(s) = path.to_str() else {
        return false; // JS 对非字符串输入返回 false
    };
    if s.is_empty() {
        return false;
    }
    let lower = js_to_lowercase(s);
    lower.ends_with(".zip") || lower.ends_with(".tar.gz")
}

/// 用系统默认程序打开安装包。**不吞错**：拿不到"确实调起来了"就返回 `Err`。
pub async fn open_installer(path: &Path) -> Result<(), UpdaterError> {
    if path.as_os_str().is_empty() {
        return Err(UpdaterError::FilePathRequired);
    }
    let owned = path.to_path_buf();
    // `open_path` 会 spawn 子进程并（在 macOS 上）等 `/usr/bin/open` 返回，别占着 async 线程。
    let joined = tokio::task::spawn_blocking(move || {
        tauri_plugin_opener::open_path(&owned, None::<&str>)
    })
    .await;

    match joined {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(UpdaterError::LaunchFailed(e.to_string())),
        Err(e) => Err(UpdaterError::LaunchFailed(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn archive_detection_matches_js() {
        assert!(is_archive_package(Path::new("x.zip")));
        assert!(is_archive_package(Path::new("x.tar.gz")));
        assert!(is_archive_package(Path::new("X.ZIP")));
        assert!(is_archive_package(Path::new("X.TAR.GZ")));
        assert!(is_archive_package(Path::new("/a/b/iRouter-0.3.7-windows-amd64-portable.zip")));
        assert!(!is_archive_package(Path::new("x.dmg")));
        assert!(!is_archive_package(Path::new("x.exe")));
        assert!(!is_archive_package(Path::new("x.deb")));
        assert!(!is_archive_package(Path::new("")));
        assert!(!is_archive_package(Path::new("zip")));
        assert!(!is_archive_package(Path::new("x.zip.part")));
    }

    #[test]
    fn empty_path_is_rejected_before_touching_the_system() {
        let e = block_on(open_installer(Path::new(""))).unwrap_err();
        assert_eq!(e.message(), "File path is required");
    }

    #[test]
    fn missing_file_returns_err_instead_of_silently_succeeding() {
        // D-5 的核心断言：现状对不存在的路径也 resolve(true)，Rust 侧必须 Err
        let missing = std::env::temp_dir().join("irouter-updater-nonexistent-installer.dmg");
        let _ = std::fs::remove_file(&missing);
        let e = block_on(open_installer(&missing)).unwrap_err();
        assert!(
            e.message().starts_with("Failed to launch installer: "),
            "{}",
            e.message()
        );
    }
}
