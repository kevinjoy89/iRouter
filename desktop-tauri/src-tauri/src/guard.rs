//! 面板守卫令牌。
//!
//! 为什么必须每次启动随机：`custom-server.js` 的守卫（`:23-41`）靠「客户端是否携带某个
//! 标识」来判断请求来自我们的窗口。Electron 版用的是固定头 `x-irouter-client: irouter-app`
//! ——那个值写在开源仓库里，任何本地进程都能伪造。换壳时把这一层升级为**每次启动随机生成
//! 的令牌**，经环境变量交给网关、经 webview UA 交给窗口，让「能加载该 origin」重新等于
//! 「就是我们的窗口」。
//!
//! 注入方式选 UA 而不是自定义请求头：UA 由 Tauri 的 `WebviewWindowBuilder::user_agent`
//! （`tauri-2.12.1/src/webview/webview_window.rs:1062`）一次性设定，覆盖该窗口的所有请求
//! （含导航、子资源、fetch），不需要拦截每个请求。

use std::fmt::Write as _;

/// 网关侧从 UA 里提取该前缀之后的部分，与 `IR_PANEL_GUARD_TOKEN` 环境变量比对。
pub const GUARD_UA_PREFIX: &str = "iRouterGuard/";

pub struct PanelGuard {
    token: String,
}

impl PanelGuard {
    /// 32 字节系统熵 → 64 位十六进制。
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        // 不引入 rand：getrandom 已是依赖树中的传递依赖，显式声明即可（见 Cargo.toml 注释）。
        getrandom::fill(&mut bytes).expect("系统熵源不可用，拒绝以低熵令牌启动");
        let mut token = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            let _ = write!(token, "{b:02x}");
        }
        Self { token }
    }

    /// 交给网关子进程环境变量 `IR_PANEL_GUARD_TOKEN`。
    pub fn token(&self) -> &str {
        &self.token
    }

    /// 交给 webview 的 UA。保留 iRouter 前缀便于网关与日志识别来源。
    pub fn user_agent(&self) -> String {
        format!(
            "iRouter/{} {}{}",
            env!("CARGO_PKG_VERSION"),
            GUARD_UA_PREFIX,
            self.token
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_64_hex_chars() {
        let g = PanelGuard::generate();
        assert_eq!(g.token().len(), 64);
        assert!(g.token().chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn two_guards_differ() {
        assert_ne!(PanelGuard::generate().token(), PanelGuard::generate().token());
    }

    #[test]
    fn user_agent_carries_the_token() {
        let g = PanelGuard::generate();
        let ua = g.user_agent();
        assert!(ua.starts_with("iRouter/"));
        assert!(ua.contains(GUARD_UA_PREFIX));
        assert!(ua.ends_with(g.token()));
    }
}
