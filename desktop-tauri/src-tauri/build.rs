//! 构建脚本。
//!
//! **为什么需要 app_manifest**：面板（= 远端 origin `http://127.0.0.1:<port>`）要通过 IPC 调
//! 自定义命令，而 `tauri-2.12.1/src/webview/mod.rs` 的注释写明：
//!
//! > Check ACL on plugin commands, when the app defined its ACL manifest,
//! > or when the request comes from a non-local (remote) origin. This ensures remote
//! > content can never reach custom commands unless an explicit `remote` capability
//! > has been configured for them.
//!
//! 也就是说：来自远端 origin 的 IPC 请求**一律走 ACL 检查**。而 `allow-$command` 这样的权限名
//! 只有在 `AppManifest::commands()` 里声明过（`tauri-build-2.7.1/src/acl.rs:104`：权限名 =
//! `allow-$command`，`$command` 为 snake_case）才会被生成——漏声明 = 命令永远调不通，
//! 且**静默**（面板只会看到拒绝，不会报错到 UI）。

fn main() {
    let _ = tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                // 更新器（updater 模块）
                "shell_check_update",
                "shell_download_update",
                "shell_cancel_download",
                "shell_install_update",
                "shell_ignore_version",
                // 设置读写（shell 模块）——命令名以 shell 模块最终实现为准，缺了在这里补
                "shell_get_settings",
                "shell_set_settings",
            ]),
        ),
    );
}
