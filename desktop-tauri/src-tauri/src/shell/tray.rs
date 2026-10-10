//! 系统托盘：图标 + 托盘菜单 + 点击事件。
//!
//! 对照 `desktop/main.js`：`createTray()` `:1502-1506`、`updateTrayMenu()` `:1483-1500`、
//! `trayIcon()` `:1452-1462`、`trayTooltip()` `:401-404`。
//!
//! 关键 API 事实（`docs/plans/2026-10-07-tauri-shell-api-notes.md` §2，均为已核实签名）：
//!   - `TrayIconBuilder::with_id/menu/icon/tooltip/icon_as_template/show_menu_on_left_click/
//!     on_tray_icon_event/build`（`tauri-2.12.1/src/tray/mod.rs:230-386`）；
//!   - `TrayIconEvent::DoubleClick` **文档明确标 Windows Only**（`tray/mod.rs:87`），
//!     所以 macOS/Linux 的双击要自己用两次 `Click` 的时间差判定。

use std::time::{Duration, Instant};

/// macOS 专用托盘模板图（纯黑 + alpha，44px @144dpi = 22pt @2x）。
/// 见下方 `create` 里关于「为什么不能用应用图标」的说明。
const TRAY_TEMPLATE_PNG: &[u8] = include_bytes!("../../assets/tray-template.png");

/// Windows / Linux 托盘图：与模板图**同一 alpha 掩膜**，RGB 统一为品牌橙 `#F14B0D`
/// （应用图标橙色像素的中位数）。
///
/// 为什么不能三平台都用模板图：`icon_as_template` 是 **macOS only**（`tray/mod.rs:295`
/// 文档原文），macOS 会按菜单栏明暗自动反色，所以纯黑掩膜在那边是对的；另两个平台
/// **原样绘制**，纯黑图形落在深色任务栏/面板上就等于隐形——用户实机截图：
/// Win11 深色模式基本看不到、MX Linux 的 Xfce 面板上是一团黑。
///
/// 品牌橙的 WCAG 对比度（黑图形同列在括号里）：白底 3.65（21.0）、Win11 深色任务栏
/// `#202020` 上 4.46（**1.29**）、Xfce 面板 `#2E3436` 上 3.46（1.66）——三种底都 ≥3:1，
/// 而黑色在两种深色底上都远低于 3:1。**统一的是形状**（与 macOS 同一轮廓）与品牌色。
///
/// 两个文件必须同形状：`tray_color_matches_template_silhouette` 逐像素比对 alpha，
/// 只重做其中一个会立刻红。
const TRAY_COLOR_PNG: &[u8] = include_bytes!("../../assets/tray-color.png");

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use super::i18n;
use super::{window, ShellState, TRAY_ID};

/// 托盘菜单项 id（与 `menus.rs` 的应用菜单共用一套全局菜单事件处理器）。
pub const ID_OPEN: &str = "tray:open-dashboard";
pub const ID_CHECK_UPDATE: &str = "menu:check-update";
pub const ID_SETTINGS: &str = "menu:settings";
pub const ID_QUIT: &str = "tray:quit";

/// macOS/Linux 双击判定窗口。500 ms 是各平台双击阈值的常见取值（**属实现选择**，
/// 不是 API 事实——Electron 版靠 OS 原生双击事件，没有这个常量）。
const DOUBLE_CLICK_WINDOW: Duration = Duration::from_millis(500);

/// 建托盘。由 `shell::init` 调用（setup 阶段，主线程；菜单构造走
/// `run_main_thread!`，在主线程上是**内联执行**，不会死锁——见
/// `tauri-runtime-wry-2.12.1/src/lib.rs:263-280` 的 `send_user_message`）。
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(tooltip(app))
        // 左键「唤出窗口」、右键弹菜单。刻意不用默认的 `true`（左键=弹菜单）：
        // 若左键被菜单接管，macOS 上 `Click` 事件根本不会送到回调，
        // 任务要求的「两次 Click 判时差」就成了死代码。
        // 差异明细见交付说明（Electron 版 macOS 左键=菜单，右击=菜单）。
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| on_tray_icon_event(tray.app_handle(), event));

    // 图标：**统一轮廓、按平台取色**——
    //   · macOS：模板图（纯黑 + alpha）+ `icon_as_template(true)`，菜单栏按明暗自动反色；
    //   · Windows / Linux：同一轮廓的品牌橙版本（这两个平台不反色，黑色在深色任务栏/
    //     面板上等于隐形，见 `TRAY_COLOR_PNG` 的说明）。
    //
    // ⚠️ **不要再回落到 `app.default_window_icon()`**——那正是实机验收发现的白板 bug：
    // 它是 `bundle.icon` 里的第一个 png（`icons/32x32.png`），也就是应用图标，
    // 而那个图 **95.6% 不透明**（只有四角透明）。配 `icon_as_template(true)` 后 macOS
    // **只用 alpha 通道当遮罩**，于是遮罩几乎是个实心方块 → 菜单栏里渲染成一整块空白。
    //
    // 模板图要求：RGB 必须纯黑，形状**全部由 alpha 表达**。本图从 `desktop/resources/icon.png`
    // 的橙色路由符号提取（橙色像素 R-B 远大于灰黑背景，用行/列像素剖面的断崖自适应定界，
    // 避开右下角那团橙色辉光），44px @144dpi 让 NSImage 解释为 22pt @2x。
    // 橙色版只把可见像素的 RGB 换成品牌橙，alpha 逐像素照抄（测试钉住）。
    let (icon_bytes, as_template) = if cfg!(target_os = "macos") {
        (TRAY_TEMPLATE_PNG, true)
    } else {
        (TRAY_COLOR_PNG, false)
    };
    let icon = match tauri::image::Image::from_bytes(icon_bytes) {
        Ok(img) => Some(img),
        Err(e) => {
            // 解码失败就建无图标托盘，而不是退回应用图标（那会重现白板）
            log::error!("托盘图解码失败，托盘将无图标：{e}");
            None
        }
    };
    if let Some(icon) = icon {
        builder = builder.icon(icon);
        // 文档原文 "Use the icon as a template. **macOS only**"（`tray/mod.rs:295`）。
        // 只对模板图开：橙色图在另外两个平台必须按本色绘制。
        if as_template {
            builder = builder.icon_as_template(true);
        }
    }

    builder.build(app)?;
    log::info!("托盘已创建（id={TRAY_ID}）");
    Ok(())
}

/// 重建托盘菜单（语言设置变化后刷新；对齐 `main.js:1446-1448, 692` 的 `updateTrayMenu()`）。
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        log::warn!("托盘不存在，刷新菜单跳过");
        return;
    };
    match build_menu(app) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log::warn!("设置托盘菜单失败：{e}");
            }
            let _ = tray.set_tooltip(Some(tooltip(app)));
        }
        Err(e) => log::warn!("构建托盘菜单失败：{e}"),
    }
}

/// 对齐 `desktop/main.js:1483-1499` 的 5 项菜单（macOS 少一项"设置"，因为它在应用菜单里）。
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let t = i18n::of(super::locale(app));

    // 2026-10-09 按用户要求移除两项：
    //   - 「网关地址」：不可点的信息行，地址在面板与设置里都能看到，托盘里占位不值当
    //   - 「检查更新…」：应用菜单（`menus.rs:75,145`）已有同一项且共用同一个 id，
    //     从托盘去掉**不失去能力**（cmd 事件处理器仍在 `menus.rs:177`）
    //
    // 顺序：设置… / 打开面板 / —— / 退出（设置排首位的原因见下面的 push 处）。
    let open = MenuItem::with_id(app, ID_OPEN, t.open_dashboard, true, None::<&str>)?;
    // macOS 已把「设置…」放进 App 菜单（Cmd+,），托盘不再重复（`main.js:1492-1495`）。
    let settings: Option<MenuItem<Wry>> = if cfg!(target_os = "macos") {
        None
    } else {
        Some(MenuItem::with_id(app, ID_SETTINGS, t.settings, true, None::<&str>)?)
    };
    let quit = MenuItem::with_id(app, ID_QUIT, t.quit_app, true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = Vec::new();
    // 「设置…」排第一位：Windows/Linux 上托盘左键事件**在 Linux 上根本不发**
    //（Tauri 上游限制，`show_menu_on_left_click` 同样不支持），用户只能右键找菜单。
    // 面板顶栏已另有齿轮入口，托盘这里是快捷方式——放首位把右键后的操作成本降到最低。
    if let Some(settings) = &settings {
        items.push(settings);
    }
    items.push(&open);
    items.push(&sep2);
    items.push(&quit);
    Menu::with_items(app, &items)
}

// 这里原先有 `gateway_addr_line()`（把网关地址渲染成不可点的一行，`main.js:1488`）。
// 2026-10-09 按用户要求从托盘移除该项，函数随之删除——**别照着 Electron 版再加回来**：
// 地址在面板与设置里都看得到，托盘里再占一行不值当。

/// 对齐 `desktop/main.js:401-404` 的 `trayTooltip()`：`iRouter 网关 :20128`。
fn tooltip(app: &AppHandle) -> String {
    let label = i18n::of(super::locale(app)).tray_tooltip;
    match app.try_state::<crate::gateway::Gateway>() {
        Some(gw) => format!("{label} :{}", gw.port),
        None => label.to_string(),
    }
}

/// 托盘点击事件。左键单击/双击都「唤出窗口」（Electron 版左键无处理器、双击唤出，
/// 我们额外让单击也唤出——这是与 Electron 的一处**有意差异**，见交付说明）。
pub fn on_tray_icon_event(app: &AppHandle, event: TrayIconEvent) {
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => {
            note_left_click_for_double_detect(app);
            window::show_window(app);
        }
        // **Windows only**（tray/mod.rs:87 文档原文）。其它平台的等价物是上面那条时间差判定。
        TrayIconEvent::DoubleClick { .. } => {
            log::info!("托盘双击（原生事件，Windows only）→ 唤出窗口");
            window::show_window(app);
        }
        _ => {}
    }
}

/// macOS/Linux：`DoubleClick` 不会来，用两次左键 `Click` 的时间差判定。
/// Windows 走原生 `DoubleClick`，这里就不重复判定（否则一次双击会被两个路径都记一次）。
#[cfg(target_os = "windows")]
fn note_left_click_for_double_detect(_app: &AppHandle) {}

#[cfg(not(target_os = "windows"))]
fn note_left_click_for_double_detect(app: &AppHandle) {
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let now = Instant::now();
    let is_double = {
        let mut last = state.last_tray_left_click.lock().expect("tray click lock poisoned");
        let is_double = last
            .map(|prev| now.duration_since(prev) < DOUBLE_CLICK_WINDOW)
            .unwrap_or(false);
        // 判到双击就清空，避免"三连击"被判成两次双击
        *last = if is_double { None } else { Some(now) };
        is_double
    };
    if is_double {
        log::info!("托盘双击（两次 Click 判时差 <{}ms）", DOUBLE_CLICK_WINDOW.as_millis());
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// **模板图必须是「形状由 alpha 表达」的图，不能是实心块。**
    ///
    /// 这条断言直接编码了实机验收发现的那个 bug：原来用应用图标（95.6% 不透明，
    /// 只有四角透明）配 `icon_as_template(true)`，而 macOS **只用 alpha 当遮罩** →
    /// 菜单栏里渲染成一整块空白。当时 CI、单测、编译全绿，只有真人看菜单栏才发现。
    ///
    /// 阈值取 60%：真正的符号图远低于它（当前 21%），实心方块接近 100%。
    #[test]
    fn tray_template_is_a_glyph_not_a_solid_block() {
        let img = tauri::image::Image::from_bytes(TRAY_TEMPLATE_PNG)
            .expect("托盘模板图应能解码（image-png 已启用）");
        assert_eq!((img.width(), img.height()), (44, 44), "应为 22pt @2x");

        let rgba = img.rgba();
        let total = (img.width() * img.height()) as f64;
        let opaque = rgba.chunks(4).filter(|p| p[3] > 128).count() as f64;
        let ratio = opaque / total;

        assert!(
            ratio > 0.02,
            "不透明占比 {:.1}%（{} 个像素）太低——形状可能丢了（全透明图在菜单栏里同样不可见）",
            ratio * 100.0,
            opaque as u64
        );
        assert!(
            ratio < 0.60,
            "不透明占比 {:.1}%（{} 个像素）过高——作为模板图它会被渲染成实心方块（就是那个白板 bug）",
            ratio * 100.0,
            opaque as u64
        );

        // 模板图不应有背景：四角必须完全透明
        let alpha_at = |x: u32, y: u32| rgba[((y * img.width() + x) * 4 + 3) as usize];
        for (x, y) in [(0u32, 0u32), (43, 0), (0, 43), (43, 43)] {
            assert_eq!(alpha_at(x, y), 0, "角 ({x},{y}) 应完全透明（模板图不该带背景）");
        }
    }

    /// WCAG 相对亮度（sRGB 线性化）。
    fn rel_luminance(rgb: [u8; 3]) -> f64 {
        let ch = |v: u8| {
            let v = v as f64 / 255.0;
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2])
    }

    /// WCAG 对比度 `(L_light + 0.05) / (L_dark + 0.05)`。
    fn contrast_ratio(a: [u8; 3], b: [u8; 3]) -> f64 {
        let (la, lb) = (rel_luminance(a), rel_luminance(b));
        let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
        (hi + 0.05) / (lo + 0.05)
    }

    /// Windows/Linux 的橙色图必须与 macOS 模板**同一轮廓**：尺寸一致、alpha 逐像素相等。
    /// 形状只有一个真源——只重做其中一个文件（改了形状忘了另一个）立刻红。
    #[test]
    fn tray_color_matches_template_silhouette() {
        let tpl = tauri::image::Image::from_bytes(TRAY_TEMPLATE_PNG).expect("模板图应能解码");
        let color = tauri::image::Image::from_bytes(TRAY_COLOR_PNG).expect("橙色图应能解码");
        assert_eq!(
            (color.width(), color.height()),
            (tpl.width(), tpl.height()),
            "两张图尺寸必须一致"
        );

        let tpl_alpha: Vec<u8> = tpl.rgba().chunks(4).map(|p| p[3]).collect();
        let color_alpha: Vec<u8> = color.rgba().chunks(4).map(|p| p[3]).collect();
        let drift = tpl_alpha
            .iter()
            .zip(&color_alpha)
            .position(|(a, b)| a != b);
        assert!(
            drift.is_none(),
            "橙色图与模板图的 alpha 在第 {drift:?} 个像素起不一致——形状漂移了，\
             两个文件必须严格同轮廓（橙色版=模板 alpha + 品牌橙 RGB）"
        );
    }

    /// **托盘图必须在浅色与深色底上都看得见**——这条直接编码用户实机报的那个 bug：
    /// `icon_as_template` 是 macOS only，另两个平台原样绘制，纯黑图形落在 Win11 深色任务栏
    /// 上对比度只有 **1.29:1**（等于隐形）、Xfce 面板上 1.66:1。阈值取 WCAG 非文本对比度
    /// 下限 3:1。
    #[test]
    fn tray_color_is_visible_on_light_and_dark_backgrounds() {
        let img = tauri::image::Image::from_bytes(TRAY_COLOR_PNG).expect("橙色图应能解码");
        let visible: Vec<[u8; 3]> = img
            .rgba()
            .chunks(4)
            .filter(|p| p[3] > 128)
            .map(|p| [p[0], p[1], p[2]])
            .collect();
        assert!(!visible.is_empty(), "橙色图里没有可见像素");

        // 品牌色是单一色值（取色，不是重画）：所有可见像素必须同色
        let brand = visible[0];
        assert!(
            visible.iter().all(|p| *p == brand),
            "橙色图应为单色（透明像素除外），实测有 {brand:?} 以外的颜色"
        );

        for (label, bg) in [
            ("浅色任务栏 #F3F3F3", [0xF3u8, 0xF3, 0xF3]),
            ("Win11 深色任务栏 #202020", [0x20, 0x20, 0x20]),
            ("Xfce 面板 #2E3436", [0x2E, 0x34, 0x36]),
        ] {
            let ratio = contrast_ratio(brand, bg);
            assert!(
                ratio >= 3.0,
                "{label} 上的对比度只有 {ratio:.2}:1（要求 ≥3:1）——托盘图形会看不清；\
                 纯黑图形在 #202020 上就是 1.29:1，正是用户截图里「基本看不到」的情况"
            );
        }
    }
}
