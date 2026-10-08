//! 壳层菜单文案（托盘 / 应用菜单 / 右键菜单）。
//!
//! 策略**逐条照抄** `desktop/main.js:900-1313`，不做"顺手改良"：
//!   - 只维护 **en / zh-CN / zh-TW** 三种（`main.js:900-901` 的原文注释：其余语言的键是历史遗留）；
//!   - 其它语言**一律回退英文**（`getMenuI18n` 的合并兜底，`main.js:1305-1313`）；
//!   - 语言判定走 `normalizeMenuLocale`（`main.js:1280-1298`）的同一套前缀规则。
//!
//! 语言从哪来：Electron 版是渲染进程经 `console.log("__IROUTER_LOCALE__:…")` 上报
//! （`main.js:584-587`）。**Tauri 版没有这条通道**——核实过面板里根本没有发射
//! `__IROUTER_LOCALE__` 的代码（只有 `src/store/themeStore.js:54-55` 发主题），
//! 那段 handler 是死代码。所以启动时按系统 locale 环境变量判定，之后不再变。
//! 这是与 Electron 版的一处**已知差异**，已在交付说明里列出。

/// 归一化后的菜单语言（对应 `main.js` 字典的三个维护中的键）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
    En,
    ZhCn,
    ZhTw,
}

/// 对应 `normalizeMenuLocale`（`desktop/main.js:1280-1298`）。
pub fn normalize(raw: &str) -> Locale {
    if raw.trim().is_empty() {
        return Locale::En;
    }
    let s = raw.trim().to_lowercase();
    if s.starts_with("zh") {
        if s.contains("tw") || s.contains("hk") || s.contains("hant") {
            return Locale::ZhTw;
        }
        return Locale::ZhCn;
    }
    // 其余语言（ja/ko/es/fr/de/ru/pt/vi…）在 Electron 版里**一律回退英文**，
    // 因为 getMenuI18n 只维护三种语言；这里保持同一行为。
    Locale::En
}

/// 进程启动时的语言。没有跨平台的"系统 UI 语言"标准库 API，
/// 用惯例的 POSIX locale 环境变量（macOS/Linux 有效；Windows 上回落英文）。
pub fn system_locale() -> Locale {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                return normalize(&v);
            }
        }
    }
    Locale::En
}

/// 菜单文案。字段与 `MENU_TRANSLATIONS` 的键一一对应（驼峰转下划线）。
///
/// `allow(dead_code)`：这是**整张表**的忠实搬运（含暂时没有对应菜单项的键，如
/// `force_reload`——Force Reload 在 Tauri 下没有等价 API，见 `menus.rs` 的说明），
/// 少一个字段就等于把翻译丢掉。
#[allow(dead_code)]
pub struct Strings {
    pub view: &'static str,
    pub window: &'static str,
    pub about: &'static str,
    pub services: &'static str,
    pub hide: &'static str,
    pub hide_others: &'static str,
    pub unhide: &'static str,
    pub quit: &'static str,
    pub reload: &'static str,
    pub force_reload: &'static str,
    pub actual_size: &'static str,
    pub zoom_in: &'static str,
    pub zoom_out: &'static str,
    pub toggle_full_screen: &'static str,
    pub minimize: &'static str,
    pub zoom: &'static str,
    pub front: &'static str,
    pub close: &'static str,
    pub open_dashboard: &'static str,
    pub gateway_addr: &'static str,
    pub quit_app: &'static str,
    pub tray_tooltip: &'static str,
    pub settings: &'static str,
    pub help: &'static str,
    pub check_for_updates: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub cut: &'static str,
    pub select_all: &'static str,
}

static EN: Strings = Strings {
    view: "View",
    window: "Window",
    about: "About iRouter",
    services: "Services",
    hide: "Hide iRouter",
    hide_others: "Hide Others",
    unhide: "Show All",
    quit: "Quit iRouter",
    reload: "Reload",
    force_reload: "Force Reload",
    actual_size: "Actual Size",
    zoom_in: "Zoom In",
    zoom_out: "Zoom Out",
    toggle_full_screen: "Toggle Full Screen",
    minimize: "Minimize",
    zoom: "Zoom",
    front: "Bring All to Front",
    close: "Close Window",
    open_dashboard: "Open Dashboard",
    gateway_addr: "Gateway Address",
    quit_app: "Quit iRouter",
    tray_tooltip: "iRouter Gateway",
    settings: "Settings…",
    help: "Help",
    check_for_updates: "Check for Updates…",
    copy: "Copy",
    paste: "Paste",
    cut: "Cut",
    select_all: "Select All",
};

static ZH_CN: Strings = Strings {
    view: "视图",
    window: "窗口",
    about: "关于 iRouter",
    services: "服务",
    hide: "隐藏 iRouter",
    hide_others: "隐藏其他",
    unhide: "全部显示",
    quit: "退出 iRouter",
    reload: "重新加载",
    force_reload: "强制重新加载",
    actual_size: "实际大小",
    zoom_in: "放大",
    zoom_out: "缩小",
    toggle_full_screen: "切换全屏",
    minimize: "最小化",
    zoom: "缩放",
    front: "前置全部窗口",
    close: "关闭窗口",
    open_dashboard: "打开面板",
    gateway_addr: "网关地址",
    quit_app: "退出 iRouter",
    tray_tooltip: "iRouter 网关",
    settings: "设置…",
    help: "帮助",
    check_for_updates: "检查更新…",
    copy: "复制",
    paste: "粘贴",
    cut: "剪切",
    select_all: "全选",
};

static ZH_TW: Strings = Strings {
    view: "檢視",
    window: "視窗",
    about: "關於 iRouter",
    services: "服務",
    hide: "隱藏 iRouter",
    hide_others: "隱藏其他",
    unhide: "全部顯示",
    quit: "結束 iRouter",
    reload: "重新載入",
    force_reload: "強制重新載入",
    actual_size: "實際大小",
    zoom_in: "放大",
    zoom_out: "縮小",
    toggle_full_screen: "切換全螢幕",
    minimize: "最小化",
    zoom: "縮放",
    front: "將全部視窗移至最前",
    close: "關閉視窗",
    open_dashboard: "開啟控制台",
    gateway_addr: "閘道位址",
    quit_app: "結束 iRouter",
    tray_tooltip: "iRouter 閘道",
    settings: "設定…",
    help: "說明",
    check_for_updates: "檢查更新…",
    copy: "複製",
    paste: "貼上",
    cut: "剪下",
    select_all: "全選",
};

pub fn of(locale: Locale) -> &'static Strings {
    match locale {
        Locale::En => &EN,
        Locale::ZhCn => &ZH_CN,
        Locale::ZhTw => &ZH_TW,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_matches_electron_rules() {
        assert_eq!(normalize("zh-CN"), Locale::ZhCn);
        assert_eq!(normalize("zh-Hans"), Locale::ZhCn);
        assert_eq!(normalize("zh-TW"), Locale::ZhTw);
        assert_eq!(normalize("zh-HK"), Locale::ZhTw);
        assert_eq!(normalize("zh-Hant"), Locale::ZhTw);
        // 其余语言回退英文（与 getMenuI18n 的合并兜底一致）
        assert_eq!(normalize("ja"), Locale::En);
        assert_eq!(normalize("de-DE"), Locale::En);
        assert_eq!(normalize(""), Locale::En);
    }

    #[test]
    fn every_locale_has_non_empty_labels() {
        for l in [Locale::En, Locale::ZhCn, Locale::ZhTw] {
            let s = of(l);
            assert!(!s.settings.is_empty());
            assert!(!s.select_all.is_empty());
            assert!(!s.tray_tooltip.is_empty());
        }
    }
}
