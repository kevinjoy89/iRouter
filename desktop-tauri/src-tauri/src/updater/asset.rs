//! 发布产物匹配 —— `desktop/updater/asset.js` 的行为等价移植（设计 §2.2/§6）。
//!
//! **移植陷阱（设计 §6.4）**：产物名是**跨版本契约**。`selectAsset` 是精确字符串相等匹配，
//! 而 `updateAvailable` 只由版本号决定（与是否匹配到产物**解耦**）——改名不会让提示消失，
//! 而是变成"提示有更新 → 点下载 → 报 No update asset available for download"（D-1）。
//!
//! **不要"顺手修好"的两处**：
//!   1. `asset.js:23` 的 `normalizedArch` 是死代码（三个分支都没引用它）。删掉即可；
//!      补上它会让 Windows arm64 去找 CI 根本不产出的 `-windows-arm64-…`。
//!   2. Linux 的回退是"换一个 installSource **再生成一次名字**"，不是后缀/包含匹配。
//!      改成模糊匹配会改变选中目标。

use serde_json::Value;

use super::jscompat::{js_trim, strip_one_leading_v};

/// GitHub Release 里的一个 asset（只取被消费的 3 个字段，见设计 §3）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}

impl ReleaseAsset {
    /// 从任意 JSON 值取字段，**按 JS 的宽松语义**：
    ///   - `name` 非字符串 → `""`（JS 里 `a.name === expectedName` 恒为 false，等价）；
    ///   - `browser_download_url` 非字符串/缺失 → `""`（JS 留下 `undefined`，面板不读该字段）；
    ///   - `size` 缺失/非数 → `0`（JS `matchedAsset.size || 0`；负数与 NaN 也归 0）。
    pub fn from_value(v: &Value) -> Self {
        Self {
            name: v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            browser_download_url: v
                .get("browser_download_url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            size: v
                .get("size")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n > 0.0)
                .map(|n| n as u64)
                .unwrap_or(0),
        }
    }
}

/// 等价于 JS `getExpectedAssetName`（`asset.js:18-47`）。
///
/// `version` 先 `trim()`（JS 空白，含 BOM）再剥**一个**前导 `v`/`V`；空 → `""`。
/// `arch` **只**在 macOS 分支被用，且只有 `arch == "arm64"` 才产出 arm64，其余一律 amd64。
/// 非 darwin/win32/linux → `""`。
pub fn expected_asset_name(
    version: &str,
    platform: &str,
    arch: &str,
    install_source: Option<&str>,
) -> String {
    let clean = strip_one_leading_v(js_trim(version));
    if clean.is_empty() {
        return String::new();
    }

    if platform == "darwin" {
        let a = if arch == "arm64" { "arm64" } else { "amd64" };
        return format!("iRouter-{clean}-macos-{a}.dmg");
    }

    if platform == "win32" {
        if install_source == Some("portable") {
            return format!("iRouter-{clean}-windows-amd64-portable.zip");
        }
        return format!("iRouter-{clean}-windows-amd64-installer.exe");
    }

    if platform == "linux" {
        if install_source == Some("tarball") || install_source == Some("tar.gz") {
            return format!("iRouter-{clean}-linux-amd64.tar.gz");
        }
        return format!("iRouter-{clean}-linux-amd64.deb");
    }

    String::new()
}

/// 等价于 JS `selectAsset`（`asset.js:59-83`）。
///
/// **精确字符串相等**匹配第一个命中的 asset；仅 Linux 有"对等形态"回退
/// （`installSource == "tarball"` → 试 deb，否则 → 试 tar.gz）。
pub fn select_asset<'a>(
    assets: &'a [ReleaseAsset],
    version: &str,
    platform: &str,
    arch: &str,
    install_source: Option<&str>,
) -> Option<&'a ReleaseAsset> {
    if assets.is_empty() {
        return None;
    }
    let expected = expected_asset_name(version, platform, arch, install_source);
    if expected.is_empty() {
        return None;
    }
    if let Some(found) = assets.iter().find(|a| a.name == expected) {
        return Some(found);
    }
    if platform == "linux" {
        let alt_source = if install_source == Some("tarball") {
            "deb"
        } else {
            "tarball"
        };
        let fallback_name = expected_asset_name(version, platform, arch, Some(alt_source));
        if let Some(found) = assets.iter().find(|a| a.name == fallback_name) {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 用例取自 tests/unit/updater-asset.test.js:16-67 与设计 §6.2/§12.3。
    #[test]
    fn macos_names() {
        assert_eq!(
            expected_asset_name("0.3.2", "darwin", "arm64", None),
            "iRouter-0.3.2-macos-arm64.dmg"
        );
        assert_eq!(
            expected_asset_name("v0.3.2", "darwin", "x64", None),
            "iRouter-0.3.2-macos-amd64.dmg"
        );
        // 只有 arm64 走 arm64，其余（含未知/空）一律 amd64
        for arch in ["x64", "amd64", "ia32", "", "ARM64"] {
            assert_eq!(
                expected_asset_name("0.3.2", "darwin", arch, None),
                "iRouter-0.3.2-macos-amd64.dmg",
                "arch={arch} 必须落到 amd64"
            );
        }
    }

    #[test]
    fn windows_names() {
        assert_eq!(
            expected_asset_name("0.3.2", "win32", "x64", Some("installer")),
            "iRouter-0.3.2-windows-amd64-installer.exe"
        );
        assert_eq!(
            expected_asset_name("0.3.2", "win32", "x64", Some("portable")),
            "iRouter-0.3.2-windows-amd64-portable.zip"
        );
        // 生产环境从不传 installSource（main.js:817-823）→ 永远 installer.exe
        assert_eq!(
            expected_asset_name("0.3.2", "win32", "x64", None),
            "iRouter-0.3.2-windows-amd64-installer.exe"
        );
        // Windows 不吃 arm64 归一：死代码删掉后 arm64 仍产出 amd64-installer
        assert_eq!(
            expected_asset_name("0.3.2", "win32", "arm64", None),
            "iRouter-0.3.2-windows-amd64-installer.exe"
        );
    }

    #[test]
    fn linux_names() {
        assert_eq!(
            expected_asset_name("0.3.2", "linux", "x64", Some("deb")),
            "iRouter-0.3.2-linux-amd64.deb"
        );
        assert_eq!(
            expected_asset_name("0.3.2", "linux", "x64", Some("tarball")),
            "iRouter-0.3.2-linux-amd64.tar.gz"
        );
        assert_eq!(
            expected_asset_name("0.3.2", "linux", "x64", Some("tar.gz")),
            "iRouter-0.3.2-linux-amd64.tar.gz"
        );
        // 缺省（生产形态）→ deb
        assert_eq!(
            expected_asset_name("0.3.2", "linux", "x64", None),
            "iRouter-0.3.2-linux-amd64.deb"
        );
    }

    #[test]
    fn unknown_platform_and_empty_version_yield_empty() {
        assert_eq!(expected_asset_name("0.3.2", "freebsd", "x64", None), "");
        assert_eq!(expected_asset_name("", "darwin", "arm64", None), "");
        assert_eq!(expected_asset_name("   ", "darwin", "arm64", None), "");
        assert_eq!(expected_asset_name("v", "darwin", "arm64", None), "");
        // trim + 剥 v
        assert_eq!(
            expected_asset_name("  V0.3.2 ", "darwin", "arm64", None),
            "iRouter-0.3.2-macos-arm64.dmg"
        );
    }

    fn mock_assets() -> Vec<ReleaseAsset> {
        // 与 tests/unit/updater-asset.test.js:42-50 同构
        [
            ("iRouter-0.3.2-macos-arm64.dmg", "https://example.com/mac-arm.dmg", 100),
            ("iRouter-0.3.2-macos-amd64.dmg", "https://example.com/mac-x64.dmg", 100),
            ("iRouter-0.3.2-windows-amd64-installer.exe", "https://example.com/win-setup.exe", 100),
            ("iRouter-0.3.2-windows-amd64-portable.zip", "https://example.com/win-port.zip", 100),
            ("iRouter-0.3.2-linux-amd64.deb", "https://example.com/linux.deb", 100),
            ("iRouter-0.3.2-linux-amd64.tar.gz", "https://example.com/linux.tar.gz", 100),
            ("checksums.txt", "https://example.com/checksums.txt", 600),
        ]
        .into_iter()
        .map(|(name, url, size)| ReleaseAsset {
            name: name.to_string(),
            browser_download_url: url.to_string(),
            size,
        })
        .collect()
    }

    #[test]
    fn selects_exact_asset_per_platform() {
        let assets = mock_assets();
        let mac = select_asset(&assets, "0.3.2", "darwin", "arm64", None).unwrap();
        assert_eq!(mac.name, "iRouter-0.3.2-macos-arm64.dmg");
        let win = select_asset(&assets, "0.3.2", "win32", "x64", Some("installer")).unwrap();
        assert_eq!(win.name, "iRouter-0.3.2-windows-amd64-installer.exe");
        let portable = select_asset(&assets, "0.3.2", "win32", "x64", Some("portable")).unwrap();
        assert_eq!(portable.name, "iRouter-0.3.2-windows-amd64-portable.zip");
        let deb = select_asset(&assets, "0.3.2", "linux", "x64", None).unwrap();
        assert_eq!(deb.name, "iRouter-0.3.2-linux-amd64.deb");
    }

    #[test]
    fn linux_fallback_switches_install_source_and_does_not_fuzzy_match() {
        let mut assets = mock_assets();
        // 主选 deb 缺失 → 回退 tar.gz（installSource 为 None，走 else 分支试 tarball）
        assets.retain(|a| a.name != "iRouter-0.3.2-linux-amd64.deb");
        let found = select_asset(&assets, "0.3.2", "linux", "x64", None).unwrap();
        assert_eq!(found.name, "iRouter-0.3.2-linux-amd64.tar.gz");

        // installSource == "tarball" 时主选 tar.gz 缺失 → 回退 deb
        let mut assets2 = mock_assets();
        assets2.retain(|a| a.name != "iRouter-0.3.2-linux-amd64.tar.gz");
        let found2 = select_asset(&assets2, "0.3.2", "linux", "x64", Some("tarball")).unwrap();
        assert_eq!(found2.name, "iRouter-0.3.2-linux-amd64.deb");

        // 「后缀匹配」会误命中：只有一个名字含 linux-amd64 的别家产物时，必须返回 None
        let only_odd = vec![ReleaseAsset {
            name: "iRouter-0.3.2-linux-amd64.AppImage".to_string(),
            browser_download_url: String::new(),
            size: 0,
        }];
        assert!(select_asset(&only_odd, "0.3.2", "linux", "x64", None).is_none());
    }

    #[test]
    fn macos_and_windows_do_not_use_the_fallback() {
        let mut assets = mock_assets();
        assets.retain(|a| a.name != "iRouter-0.3.2-macos-arm64.dmg");
        assert!(select_asset(&assets, "0.3.2", "darwin", "arm64", None).is_none());
        let mut assets2 = mock_assets();
        assets2.retain(|a| a.name != "iRouter-0.3.2-windows-amd64-installer.exe");
        assert!(select_asset(&assets2, "0.3.2", "win32", "x64", None).is_none());
    }

    #[test]
    fn empty_assets_and_unknown_platform_return_none() {
        let assets = mock_assets();
        assert!(select_asset(&[], "0.3.2", "darwin", "arm64", None).is_none());
        assert!(select_asset(&assets, "0.3.2", "unknown", "x64", None).is_none());
        // 版本为空 → expected 为空 → 直接 None（不会退化成"匹配空名字"）
        assert!(select_asset(&assets, "", "darwin", "arm64", None).is_none());
    }

    #[test]
    fn first_match_wins_and_js_field_coercion_is_lenient() {
        let raw = json!([
            {"name": "iRouter-0.3.2-macos-arm64.dmg", "browser_download_url": "https://a", "size": 10},
            {"name": "iRouter-0.3.2-macos-arm64.dmg", "browser_download_url": "https://b", "size": 20},
            null,
            {"name": 123},
        ]);
        let assets: Vec<ReleaseAsset> = raw
            .as_array()
            .unwrap()
            .iter()
            .map(ReleaseAsset::from_value)
            .collect();
        let found = select_asset(&assets, "0.3.2", "darwin", "arm64", None).unwrap();
        assert_eq!(found.browser_download_url, "https://a");
        // null / 数字 name → 空名 + size 0（不 panic，也不会误匹配）
        assert_eq!(assets[2].name, "");
        assert_eq!(assets[2].size, 0);
        assert_eq!(assets[3].name, "");
        // size 的 JS `|| 0` 语义
        assert_eq!(ReleaseAsset::from_value(&json!({"size": 0})).size, 0);
        assert_eq!(ReleaseAsset::from_value(&json!({"size": -5})).size, 0);
        assert_eq!(ReleaseAsset::from_value(&json!({"size": "9"})).size, 0);
        assert_eq!(ReleaseAsset::from_value(&json!({"size": 1.9})).size, 1);
    }
}
