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
    // **不能只读环境变量**：macOS 的 GUI 进程没有 LANG/LC_ALL（Finder 启动与 tauri dev 都没有），
    // 系统语言存在 NSLocale 里。实测本机 AppleLocale=zh_CN 而 LANG=C.UTF-8 —— 只读环境变量会得到
    // 英文，而 Electron 版用的是 app.getLocale()（main.js:2081），在 macOS 上返回**系统语言**，
    // 于是同一台机器上 Electron 显示「复制」、Tauri 显示 Copy。这是实测发现的一致性回归。
    if let Some(raw) = sys_locale::get_locale() {
        if !raw.trim().is_empty() {
            return normalize(&raw);
        }
    }
    // 兜底：环境变量（sys-locale 在 Linux 本就读这些；这里防它返回 None）
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
    /// 以下 10 个键是「检查更新…」结果对话框的（`main.js:931-940, 975-983, 1018-1026`）。
    pub checking_for_updates: &'static str,
    pub up_to_date: &'static str,
    pub up_to_date_detail: &'static str,
    pub update_available: &'static str,
    pub update_available_detail: &'static str,
    pub open_update_settings: &'static str,
    pub later: &'static str,
    pub update_check_failed: &'static str,
    pub current_version: &'static str,
    pub latest_version: &'static str,
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
    checking_for_updates: "Checking for updates…",
    up_to_date: "iRouter is up to date",
    up_to_date_detail: "You are running the latest version.",
    update_available: "New Version Available",
    update_available_detail:
        "A new version of iRouter is available. Would you like to open Settings to download and install it?",
    open_update_settings: "Open Settings",
    later: "Later",
    update_check_failed: "Update Check Failed",
    current_version: "Current Version",
    latest_version: "Latest Version",
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
    checking_for_updates: "正在检查更新…",
    up_to_date: "当前已是最新版本",
    up_to_date_detail: "您正在使用最新版本的 iRouter。",
    update_available: "发现新版本",
    update_available_detail: "iRouter 已有新版本可用。是否立即打开设置面板进行更新？",
    open_update_settings: "打开更新面板",
    later: "稍后",
    update_check_failed: "检查更新失败",
    current_version: "当前版本",
    latest_version: "最新版本",
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
    checking_for_updates: "正在檢查更新…",
    up_to_date: "目前已是最新版本",
    up_to_date_detail: "您正在使用最新版本的 iRouter。",
    update_available: "發現新版本",
    update_available_detail: "iRouter 已有新版本可用。是否立即開啟設定面板進行更新？",
    open_update_settings: "開啟更新面板",
    later: "稍後",
    update_check_failed: "檢查更新失敗",
    current_version: "目前版本",
    latest_version: "最新版本",
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
impl Strings {
    /// 全部 39 个字段的 `(键名, 文案)`。**测试专用**（release 里不编译）。
    ///
    /// 为什么要它：这条表会随菜单增长，逐个字段手写断言必然漏；遍历能让"新增键忘翻译"
    /// 立刻红。键名与 `MENU_TRANSLATIONS` 的驼峰键一一对应，便于和 JS 侧对账。
    pub fn all(&self) -> [(&'static str, &'static str); 39] {
        [
            ("view", self.view),
            ("window", self.window),
            ("about", self.about),
            ("services", self.services),
            ("hide", self.hide),
            ("hideOthers", self.hide_others),
            ("unhide", self.unhide),
            ("quit", self.quit),
            ("reload", self.reload),
            ("forceReload", self.force_reload),
            ("actualSize", self.actual_size),
            ("zoomIn", self.zoom_in),
            ("zoomOut", self.zoom_out),
            ("toggleFullScreen", self.toggle_full_screen),
            ("minimize", self.minimize),
            ("zoom", self.zoom),
            ("front", self.front),
            ("close", self.close),
            ("openDashboard", self.open_dashboard),
            ("gatewayAddr", self.gateway_addr),
            ("quitApp", self.quit_app),
            ("trayTooltip", self.tray_tooltip),
            ("settings", self.settings),
            ("help", self.help),
            ("checkForUpdates", self.check_for_updates),
            ("checkingForUpdates", self.checking_for_updates),
            ("upToDate", self.up_to_date),
            ("upToDateDetail", self.up_to_date_detail),
            ("updateAvailable", self.update_available),
            ("updateAvailableDetail", self.update_available_detail),
            ("openUpdateSettings", self.open_update_settings),
            ("later", self.later),
            ("updateCheckFailed", self.update_check_failed),
            ("currentVersion", self.current_version),
            ("latestVersion", self.latest_version),
            ("copy", self.copy),
            ("paste", self.paste),
            ("cut", self.cut),
            ("selectAll", self.select_all),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `tests/unit/desktop-shell-i18n.test.js`（随 `desktop/` 处置）的对账见
    /// `docs/plans/2026-10-08-r1-coverage.md`。Rust 侧比 JS 侧**更强**：
    /// 三份字典是同一个 `Strings` 结构体的三个实例，**缺键/多余键都是编译错误**，
    /// 所以 JS 那条"每种语言不能有英文之外的意外多余键"在 Rust 里没有对应测试，也不需要。
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

    /// 遍历**全部 39 个字段**（不是抽样三个）：任何语言任何键为空即红。
    #[test]
    fn every_locale_has_non_empty_labels() {
        for l in [Locale::En, Locale::ZhCn, Locale::ZhTw] {
            for (key, value) in of(l).all() {
                assert!(!value.trim().is_empty(), "{l:?} 的 {key} 为空");
            }
        }
    }

    /// 取代 JS 侧那条 `zh-CN/zh-TW 的 settings 文案确实译成了中文`（原本只查一个键）：
    /// 中文两语言的**每一个**键都必须含中日韩统一表意文字，杜绝"把英文抄进中文槽"。
    #[test]
    fn chinese_locales_are_actually_translated() {
        for l in [Locale::ZhCn, Locale::ZhTw] {
            for (key, value) in of(l).all() {
                assert!(
                    value.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                    "{l:?} 的 {key} 不含中文（是不是把英文抄过来了？）：{value:?}"
                );
            }
        }
        // 逐字钉住 JS 用例点名的那条：不是照抄 "Settings…"
        assert_ne!(of(Locale::ZhCn).settings, "Settings…");
        assert_ne!(of(Locale::ZhTw).settings, "Settings…");
    }

    /// 反向守卫：英文槽里不该出现中文（把 zh 抄进 en 的镜像错误）。
    #[test]
    fn english_locale_has_no_cjk() {
        for (key, value) in of(Locale::En).all() {
            assert!(
                !value.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "en 的 {key} 含中文：{value:?}"
            );
        }
    }

    /// 三份字典的键集合必须完全一致——Rust 由类型系统保证，这条断言把它钉成**可执行证据**
    /// （将来若有人把 `Strings` 换成 HashMap 之类的动态结构，这里会立刻红）。
    #[test]
    fn all_locales_expose_the_same_key_set() {
        let keys = |l: Locale| of(l).all().map(|(k, _)| k).to_vec();
        assert_eq!(keys(Locale::En), keys(Locale::ZhCn));
        assert_eq!(keys(Locale::En), keys(Locale::ZhTw));
        assert_eq!(keys(Locale::En).len(), 39);
    }
}
