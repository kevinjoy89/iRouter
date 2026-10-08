//! 远端版本检查 —— `desktop/updater/checker.js` 的行为等价移植（设计 §2.4/§3）。
//!
//! ## 三条最容易被"顺手改好"的既有语义
//!   1. **`latest` 是"API 顺序第一个非 draft 非 prerelease"**，不是"版本最大"的那个
//!      （`checker.js:142`）。补发旧版本补丁会挑到旧版 → 不提示更新（D-8，照抄）。
//!   2. **检查失败永不 reject**：错误装在返回值的 `error` 字段里，`latest === current`。
//!      面板据此把 `state` 置为 `error`（`UpdateSettings.js:35-37`），**不发**
//!      `shell:update-error`（契约 §7.4 最容易漏的一条）。
//!   3. **`updateAvailable` 只由版本号决定，与是否匹配到产物无关**（D-1）。照抄：
//!      "提示有更新 → 点下载 → No update asset available for download"。
//!
//! 输入解析刻意走 `serde_json::Value` 而不是强类型 struct：JS 是鸭子类型
//! （`r.draft`、`name || tag_name`、`matchedAsset.size || 0`），强类型 struct 会在
//! 字段类型不符时**整条检查失败**，那是行为变更。

use std::future::Future;
use std::pin::Pin;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::asset::{select_asset, ReleaseAsset};
use super::clock;
use super::error::UpdaterError;
use super::http;
use super::jscompat::strip_one_leading_v;
use super::version::has_new_version;

pub const GITHUB_REPO: &str = "kevinjoy89/iRouter";
pub const RELEASES_API_URL: &str =
    "https://api.github.com/repos/kevinjoy89/iRouter/releases?per_page=10";
pub const DEFAULT_RELEASE_PAGE: &str = "https://github.com/kevinjoy89/iRouter/releases";

/// 4 小时静默限流缓存（`checker.js:17`）。比较时用毫秒整数，避免 Duration 往返误差。
pub const CACHE_INTERVAL_MS: i64 = 4 * 60 * 60 * 1000;

/// 检查结果。字段名 **camelCase 硬要求**（设计 §7.2）：面板直接读，
/// 且 `shell:update-available` / `lastCheckResult` 两处都用这个形状。
///
/// ⚠️ 三个 **URL 后缀必须显式 `rename`**：`rename_all = "camelCase"` 会把
/// `release_url` 变成 `releaseUrl`，而面板读的是 `res.releaseURL`
/// （`UpdateSettings.js:138-139`）、`res.downloadURL`、`res.checksumsURL`（`main.js:712`）。
/// 少了这一层，`downloadURL` 会是 `undefined` → 用户点下载永远报
/// `No update asset available for download`。**已由单测钉住。**
///
/// **不要**加 `skip_serializing_if`：所有键必须存在，`None` → `null`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckResult {
    pub current: Option<String>,
    pub latest: Option<String>,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    #[serde(rename = "releaseURL")]
    pub release_url: String,
    pub asset_name: String,
    #[serde(rename = "downloadURL")]
    pub download_url: String,
    pub asset_size: u64,
    #[serde(rename = "checksumsURL")]
    pub checksums_url: String,
    pub cached: bool,
    pub error: Option<String>,
}

impl Default for CheckResult {
    fn default() -> Self {
        Self {
            current: None,
            latest: None,
            update_available: false,
            release_name: String::new(),
            release_notes: String::new(),
            release_url: DEFAULT_RELEASE_PAGE.to_string(),
            asset_name: String::new(),
            download_url: String::new(),
            asset_size: 0,
            checksums_url: String::new(),
            cached: false,
            error: None,
        }
    }
}

impl CheckResult {
    /// JS `checker.js:101-114` 的初值：`latest` 初值 = `current`（所以"检查失败"时
    /// 面板看到的 `latest` 就是本地版本）。
    pub fn initial(current: Option<&str>) -> Self {
        Self {
            current: current.map(str::to_string),
            latest: current.map(str::to_string),
            ..Default::default()
        }
    }

    /// `latestCheckResult` 里存的资产名（`main.js:720` 的 `fileName`）。
    pub fn effective_asset_name(&self) -> String {
        if self.asset_name.is_empty() {
            // JS: `assetName || \`iRouter-${latest}\``；latest 为 undefined 时字面量就是
            // "iRouter-undefined"（模板字符串不认 undefined），这里照抄。
            format!(
                "iRouter-{}",
                self.latest.as_deref().unwrap_or("undefined")
            )
        } else {
            self.asset_name.clone()
        }
    }
}

/// `checkForUpdates({...})` 的入参。字段与 `settings` 解耦，方便单测直接构造。
#[derive(Debug, Clone, Default)]
pub struct CheckOptions<'a> {
    pub current_version: Option<&'a str>,
    pub platform: &'a str,
    pub arch: &'a str,
    /// **生产恒为 `None`**（`main.js:817-823` 没传）→ Windows 永远 installer.exe、
    /// Linux 永远主选 deb（设计 §6.3）。
    pub install_source: Option<&'a str>,
    pub force: bool,
    /// `settings.lastCheckAt`
    pub last_check_at: Option<&'a str>,
    /// `settings.lastCheckResult`（原样 JSON）
    pub last_check_result: Option<&'a Value>,
    /// `settings.ignoredVersion`
    pub ignored_version: Option<&'a str>,
}

/// 可注入的 JSON fetch（对齐 JS 的 `fetchFn` 测试接缝）。
pub type FetchFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, UpdaterError>> + Send + 'a>>;

pub trait Fetcher: Send + Sync {
    fn fetch_json<'a>(&'a self, url: &'a str, user_agent: &'a str) -> FetchFuture<'a>;
}

/// 生产实现：真实 HTTPS。
pub struct HttpFetcher {
    client: Client,
}

impl HttpFetcher {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

impl Fetcher for HttpFetcher {
    fn fetch_json<'a>(&'a self, url: &'a str, user_agent: &'a str) -> FetchFuture<'a> {
        let headers = http::json_headers(user_agent);
        Box::pin(async move { http::fetch_json(&self.client, url, &headers).await })
    }
}

/// `RELEASES_API_URL`；若设了 `IROUTER_UPDATE_API_BASE`（设计 §12.2 的自动化接缝）则
/// 用 override 拼出同样的路径。
///
/// **安全约束（设计 §12.2 的风险提示）**：能改 API base 就能让应用下载任意 URL 的"更新包"。
/// 因此 debug 构建任意、**release 构建只接受回环地址**（`127.0.0.1` / `localhost` / `[::1]`）。
pub fn releases_api_url() -> String {
    match api_base_override() {
        Some(base) => format!("{base}/repos/{GITHUB_REPO}/releases?per_page=10"),
        None => RELEASES_API_URL.to_string(),
    }
}

fn api_base_override() -> Option<String> {
    let raw = std::env::var("IROUTER_UPDATE_API_BASE").ok()?;
    let base = raw.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return None;
    }
    if cfg!(debug_assertions) {
        return Some(base);
    }
    if is_loopback_base(&base) {
        return Some(base);
    }
    log::warn!("IROUTER_UPDATE_API_BASE 在 release 构建里只接受回环地址，已忽略：{base}");
    None
}

fn is_loopback_base(base: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(base) else {
        return false;
    };
    match u.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1") => true,
        _ => false,
    }
}

/// 检查更新。**永不返回 `Err`**（与 JS 一致）：错误进 `result.error`。
pub async fn check_for_updates<F: Fetcher + ?Sized>(
    fetcher: &F,
    opts: &CheckOptions<'_>,
    now_ms: i64,
) -> CheckResult {
    let mut result = CheckResult::initial(opts.current_version);

    let current = opts.current_version.unwrap_or("");
    let is_dev = current.is_empty() || current == "dev" || current == "local";

    // 短路 1：源码/开发构建在**静默**检查时不打扰（force 时照常联网）
    if is_dev && !opts.force {
        return result;
    }

    // 短路 2：4h 缓存（命中缓存也**不**在这里写回 lastCheckAt —— 那在 commands 侧，
    // 且现实现不区分 cached，见设计 §2.8 的滑动窗口）
    if !opts.force {
        if let (Some(at), Some(stored)) = (opts.last_check_at, opts.last_check_result) {
            // JS: `new Date(lastCheckAt).getTime()`；非法日期 → NaN → 比较为 false → 联网
            if let Some(then) = clock::parse_iso8601_ms(at) {
                if now_ms - then < CACHE_INTERVAL_MS {
                    return cached_from(stored);
                }
            }
        }
    }

    let url = releases_api_url();
    let user_agent = format!("iRouter-Desktop/{current}");
    let releases = match fetcher.fetch_json(&url, &user_agent).await {
        Ok(v) => v,
        Err(e) => {
            // 唯一被 catch 的路径（`checker.js:185-188`）：其余字段停在初值
            result.error = Some(non_empty_message(&e));
            return result;
        }
    };

    let Some(list) = releases.as_array() else {
        return result;
    };
    if list.is_empty() {
        return result;
    }

    // `releases.find(r => r && !r.draft && !r.prerelease)`：API 顺序第一个正式版
    let Some(release) = list.iter().find(|r| {
        js_truthy(Some(r))
            && !js_truthy(r.get("draft"))
            && !js_truthy(r.get("prerelease"))
    }) else {
        return result;
    };

    // `(tag_name || "").replace(/^v/i, "")` —— **不 trim**（面板显示的是这个原样字符串）
    let tag = release.get("tag_name").and_then(Value::as_str).unwrap_or("");
    let latest = strip_one_leading_v(tag);
    result.latest = Some(latest.to_string());
    result.release_name = js_str_or(release.get("name"), release.get("tag_name"));
    result.release_notes = release
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    result.release_url = non_empty_str(release.get("html_url"))
        .unwrap_or_else(|| DEFAULT_RELEASE_PAGE.to_string());

    // `latestRelease.assets || []`
    let empty: Vec<Value> = Vec::new();
    let raw_assets = release
        .get("assets")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let assets: Vec<ReleaseAsset> = raw_assets.iter().map(ReleaseAsset::from_value).collect();

    if let Some(matched) = select_asset(
        &assets,
        latest,
        opts.platform,
        opts.arch,
        opts.install_source,
    ) {
        result.asset_name = matched.name.clone();
        result.download_url = matched.browser_download_url.clone();
        result.asset_size = matched.size;
    }

    if let Some(checksums) = assets.iter().find(|a| a.name == "checksums.txt") {
        result.checksums_url = checksums.browser_download_url.clone();
    }

    // 忽略版本：**只影响非强制检查**（手动 Check now 照常提示）
    let is_new = has_new_version(opts.current_version, Some(latest));
    result.update_available = if is_new && !opts.force && opts.ignored_version == Some(latest) {
        false
    } else {
        is_new
    };

    result
}

fn cached_from(stored: &Value) -> CheckResult {
    // JS `{...lastCheckResult, cached: true}`：非对象 spread 出空对象
    let mut r = serde_json::from_value::<CheckResult>(stored.clone())
        .unwrap_or_else(|_| CheckResult::default());
    r.cached = true;
    r
}

fn non_empty_message(e: &UpdaterError) -> String {
    let m = e.message();
    if m.is_empty() {
        // JS `err.message || "Failed to check for updates"`
        UpdaterError::CheckFailed.message()
    } else {
        m
    }
}

/// JS 真值语义（`!r.draft`）：`null`/`false`/`0`/`NaN`/`""` 为假，`[]`/`{}` 为**真**。
pub(crate) fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `a || b` 后取字符串（非字符串真值 → 空串；GitHub 数据不可达，登记为微偏差）。
fn js_str_or(a: Option<&Value>, b: Option<&Value>) -> String {
    let picked = if js_truthy(a) { a } else { b };
    picked.and_then(Value::as_str).unwrap_or("").to_string()
}

/// `v || DEFAULT` 里的"非空字符串"判定。
fn non_empty_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// 可注入的假 fetch（对齐 JS 的 `fetchFn`）。
    struct MockFetcher {
        payload: Result<Value, ()>,
        calls: AtomicUsize,
        last_url: Mutex<String>,
        last_ua: Mutex<String>,
    }

    impl MockFetcher {
        fn ok(v: Value) -> Arc<Self> {
            Arc::new(Self {
                payload: Ok(v),
                calls: AtomicUsize::new(0),
                last_url: Mutex::new(String::new()),
                last_ua: Mutex::new(String::new()),
            })
        }
        fn err() -> Arc<Self> {
            Arc::new(Self {
                payload: Err(()),
                calls: AtomicUsize::new(0),
                last_url: Mutex::new(String::new()),
                last_ua: Mutex::new(String::new()),
            })
        }
        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl Fetcher for MockFetcher {
        fn fetch_json<'a>(&'a self, url: &'a str, user_agent: &'a str) -> FetchFuture<'a> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.last_url.lock().unwrap() = url.to_string();
            *self.last_ua.lock().unwrap() = user_agent.to_string();
            let payload = match &self.payload {
                Ok(v) => Ok(v.clone()),
                Err(()) => Err(UpdaterError::HttpStatus(500)),
            };
            Box::pin(async move { payload })
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    /// 与 tests/unit/updater-checker.test.js:13-48 同一份夹具。
    fn mock_releases() -> Value {
        serde_json::json!([
            {"tag_name": "v0.3.3-pre", "name": "Pre Release", "prerelease": true, "draft": false, "assets": []},
            {
                "tag_name": "v0.3.2", "name": "v0.3.2 Release", "prerelease": false, "draft": false,
                "html_url": "https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.2",
                "body": "Release Notes for 0.3.2",
                "assets": [
                    {"name": "iRouter-0.3.2-macos-arm64.dmg", "browser_download_url": "https://example.com/iRouter-0.3.2-macos-arm64.dmg", "size": 157000000},
                    {"name": "checksums.txt", "browser_download_url": "https://example.com/checksums.txt", "size": 602}
                ]
            },
            {"tag_name": "v0.3.1", "name": "v0.3.1 Release", "prerelease": false, "draft": false, "assets": []}
        ])
    }

    fn opts<'a>(current: &'a str, force: bool) -> CheckOptions<'a> {
        CheckOptions {
            current_version: Some(current),
            platform: "darwin",
            arch: "arm64",
            install_source: None,
            force,
            ..Default::default()
        }
    }

    const NOW: i64 = 1_791_425_664_000;

    #[test]
    fn detects_update_and_matches_asset() {
        let f = MockFetcher::ok(mock_releases());
        let r = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        assert!(r.update_available);
        assert_eq!(r.latest.as_deref(), Some("0.3.2"));
        assert_eq!(r.asset_name, "iRouter-0.3.2-macos-arm64.dmg");
        assert_eq!(
            r.download_url,
            "https://example.com/iRouter-0.3.2-macos-arm64.dmg"
        );
        assert_eq!(r.checksums_url, "https://example.com/checksums.txt");
        assert_eq!(r.asset_size, 157_000_000);
        assert_eq!(r.release_name, "v0.3.2 Release");
        assert_eq!(r.release_notes, "Release Notes for 0.3.2");
        assert_eq!(
            r.release_url,
            "https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.2"
        );
        assert!(!r.cached);
        assert!(r.error.is_none());
        // 跳过了 prerelease，用了 API 顺序的第一个正式版
        assert_eq!(f.call_count(), 1);
        assert_eq!(*f.last_url.lock().unwrap(), RELEASES_API_URL);
        assert_eq!(*f.last_ua.lock().unwrap(), "iRouter-Desktop/0.3.1");
    }

    #[test]
    fn no_update_when_current_is_latest_or_newer() {
        let f = MockFetcher::ok(mock_releases());
        let r = block_on(check_for_updates(&*f, &opts("0.3.2", true), NOW));
        assert!(!r.update_available);
        assert_eq!(r.latest.as_deref(), Some("0.3.2"));

        let r2 = block_on(check_for_updates(&*f, &opts("9.9.9", true), NOW));
        assert!(!r2.update_available);
    }

    #[test]
    fn cache_hit_returns_stored_result_with_cached_true() {
        let stored = serde_json::json!({
            "current": "0.3.1", "latest": "0.3.2", "updateAvailable": true
        });
        let at = clock::iso8601_from_unix_ms(NOW - 30 * 60 * 1000);
        let f = MockFetcher::ok(mock_releases());
        let mut o = opts("0.3.1", false);
        o.last_check_at = Some(&at);
        o.last_check_result = Some(&stored);
        let r = block_on(check_for_updates(&*f, &o, NOW));
        assert_eq!(f.call_count(), 0, "命中缓存不得联网");
        assert!(r.cached);
        assert_eq!(r.latest.as_deref(), Some("0.3.2"));
        assert!(r.update_available);
        // 缺失字段回落到默认值（JS 里是 undefined）
        assert_eq!(r.asset_name, "");
        assert_eq!(r.release_url, DEFAULT_RELEASE_PAGE);
    }

    #[test]
    fn cached_partial_result_still_carries_all_twelve_keys() {
        // 差分测试发现的第 2 处偏差族（7 个字段），**是有意为之**：
        //   JS  `{...lastCheckResult, cached:true}` 对残缺对象会**丢掉**缺失键（值 undefined）；
        //   Rust 用 `#[serde(default)]` 补默认值 → 12 个键永远齐全（设计 §7.2 的硬要求：
        //   面板是独立构建，"少发一个字段 = 给未来埋一个静默失败"）。
        // 面板真正读的字段里只有 2 个落在差异面上，且行为等价：
        //   assetSize  : JS undefined → `Number.isFinite(undefined)` 假 → 不显示大小；
        //                Rust 0 → `0 > 0` 假 → 同样不显示（`UpdateSettings.js:249-253`）
        //   releaseURL : JS undefined → `result?.releaseURL || DEFAULT_RELEASE_PAGE` 回落到默认页；
        //                Rust 直接就是同一个默认页（`UpdateSettings.js:136-140`）
        // 触发条件：`lastCheckResult` 是手改/残缺对象。我们自己写盘的永远是全量 12 字段，
        // 所以这条差异在正常工作流里不可达。
        let stored = serde_json::json!({"current": "0.3.1", "latest": "0.3.2", "updateAvailable": true});
        let at = clock::iso8601_from_unix_ms(NOW - 60 * 1000);
        let f = MockFetcher::ok(mock_releases());
        let mut o = opts("0.3.1", false);
        o.last_check_at = Some(&at);
        o.last_check_result = Some(&stored);
        let r = block_on(check_for_updates(&*f, &o, NOW));

        let v = serde_json::to_value(&r).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 12, "残缺的缓存对象也必须补全 12 个键");
        for key in [
            "current",
            "latest",
            "updateAvailable",
            "releaseName",
            "releaseNotes",
            "releaseURL",
            "assetName",
            "downloadURL",
            "assetSize",
            "checksumsURL",
            "cached",
            "error",
        ] {
            assert!(obj.contains_key(key), "缺字段 {key}");
        }
        assert_eq!(obj["assetSize"], serde_json::json!(0));
        assert_eq!(obj["releaseURL"], serde_json::json!(DEFAULT_RELEASE_PAGE));
        assert_eq!(obj["cached"], serde_json::json!(true));
    }

    #[test]
    fn expired_or_invalid_cache_goes_to_the_network() {
        let stored = serde_json::json!({"latest": "0.3.2", "updateAvailable": true});
        let f = MockFetcher::ok(mock_releases());

        let at = clock::iso8601_from_unix_ms(NOW - 5 * 60 * 60 * 1000);
        let mut o = opts("0.3.1", false);
        o.last_check_at = Some(&at);
        o.last_check_result = Some(&stored);
        let r = block_on(check_for_updates(&*f, &o, NOW));
        assert_eq!(f.call_count(), 1, "超过 4h 必须联网");
        assert!(!r.cached);

        // 非法日期 → NaN → 同样联网
        let f2 = MockFetcher::ok(mock_releases());
        let mut o2 = opts("0.3.1", false);
        o2.last_check_at = Some("garbage");
        o2.last_check_result = Some(&stored);
        let _ = block_on(check_for_updates(&*f2, &o2, NOW));
        assert_eq!(f2.call_count(), 1);
    }

    #[test]
    fn force_bypasses_cache_and_ignored_version() {
        let stored = serde_json::json!({"latest": "0.3.2", "updateAvailable": true});
        let at = clock::iso8601_from_unix_ms(NOW - 60 * 1000);
        let f = MockFetcher::ok(mock_releases());
        let mut o = opts("0.3.1", true);
        o.last_check_at = Some(&at);
        o.last_check_result = Some(&stored);
        o.ignored_version = Some("0.3.2");
        let r = block_on(check_for_updates(&*f, &o, NOW));
        assert_eq!(f.call_count(), 1, "force 必须绕过 4h 缓存");
        assert!(!r.cached);
        assert!(r.update_available, "force 必须无视 ignoredVersion");
    }

    #[test]
    fn ignored_version_silences_auto_check_only() {
        let f = MockFetcher::ok(mock_releases());
        let mut auto = opts("0.3.1", false);
        auto.ignored_version = Some("0.3.2");
        assert!(!block_on(check_for_updates(&*f, &auto, NOW)).update_available);

        let mut manual = opts("0.3.1", true);
        manual.ignored_version = Some("0.3.2");
        assert!(block_on(check_for_updates(&*f, &manual, NOW)).update_available);

        // 忽略的是别的版本 → 照常提示
        let mut other = opts("0.3.1", false);
        other.ignored_version = Some("0.3.0");
        assert!(block_on(check_for_updates(&*f, &other, NOW)).update_available);

        // 字符串全等：大小写/前缀敏感
        let mut prefixed = opts("0.3.1", false);
        prefixed.ignored_version = Some("v0.3.2");
        assert!(block_on(check_for_updates(&*f, &prefixed, NOW)).update_available);
    }

    #[test]
    fn dev_build_short_circuits_only_when_not_forced() {
        let f = MockFetcher::ok(mock_releases());
        let r = block_on(check_for_updates(&*f, &opts("dev", false), NOW));
        assert_eq!(f.call_count(), 0);
        assert_eq!(r.latest.as_deref(), Some("dev"));
        assert!(!r.update_available);
        assert!(r.error.is_none());

        let r2 = block_on(check_for_updates(&*f, &opts("dev", true), NOW));
        assert_eq!(f.call_count(), 1, "force 时 dev 也要联网");
        assert_eq!(r2.latest.as_deref(), Some("0.3.2"));
    }

    #[test]
    fn empty_or_unmatched_release_list_returns_initial_values() {
        let f = MockFetcher::ok(serde_json::json!([]));
        let r = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        assert_eq!(r.latest.as_deref(), Some("0.3.1"));
        assert!(!r.update_available);
        assert_eq!(r.release_url, DEFAULT_RELEASE_PAGE);

        // 只有 draft / prerelease
        let f2 = MockFetcher::ok(serde_json::json!([
            {"tag_name": "v9.9.9", "draft": true, "prerelease": false},
            {"tag_name": "v9.9.8", "draft": false, "prerelease": true}
        ]));
        let r2 = block_on(check_for_updates(&*f2, &opts("0.3.1", true), NOW));
        assert_eq!(r2.latest.as_deref(), Some("0.3.1"));
        assert!(!r2.update_available);

        // 非数组（GitHub 出错时会返回对象）
        let f3 = MockFetcher::ok(serde_json::json!({"message": "Not Found"}));
        let r3 = block_on(check_for_updates(&*f3, &opts("0.3.1", true), NOW));
        assert_eq!(r3.latest.as_deref(), Some("0.3.1"));
        assert!(r3.error.is_none(), "非数组不算错误（JS 同样静默返回初值）");
    }

    #[test]
    fn fetch_failure_is_caught_into_the_error_field() {
        let f = MockFetcher::err();
        let r = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        assert_eq!(r.error.as_deref(), Some("GitHub API HTTP 500"));
        assert_eq!(r.latest.as_deref(), Some("0.3.1"), "失败时 latest === current");
        assert_eq!(r.current.as_deref(), Some("0.3.1"));
        assert!(!r.update_available);
        assert_eq!(r.asset_name, "");
        assert_eq!(r.asset_size, 0);
        assert!(!r.cached);
        assert_eq!(r.release_url, DEFAULT_RELEASE_PAGE);
    }

    #[test]
    fn missing_tag_name_yields_empty_latest_and_no_update() {
        let f = MockFetcher::ok(serde_json::json!([
            {"name": "No tag here", "draft": false, "prerelease": false, "assets": []}
        ]));
        let r = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        assert_eq!(r.latest.as_deref(), Some(""));
        assert_eq!(r.release_name, "No tag here");
        assert!(!r.update_available, "\"\" 不可解析 → compare=0 → 不提示");
    }

    #[test]
    fn d1_version_new_but_no_matching_asset_still_says_update_available() {
        // D-1 照抄：版本新、产物没匹配上 → updateAvailable 仍为 true，downloadURL 为空
        let f = MockFetcher::ok(serde_json::json!([
            {"tag_name": "v0.3.2", "name": "x", "draft": false, "prerelease": false,
             "assets": [{"name": "iRouter-0.3.2-macos-x64.dmg", "browser_download_url": "https://e/x", "size": 5}]}
        ]));
        let r = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        assert!(r.update_available);
        assert_eq!(r.latest.as_deref(), Some("0.3.2"));
        assert_eq!(r.asset_name, "");
        assert_eq!(r.download_url, "");
        assert_eq!(r.checksums_url, "");
        assert_eq!(r.effective_asset_name(), "iRouter-0.3.2");
    }

    #[test]
    fn effective_asset_name_matches_the_js_template_literal() {
        let mut r = CheckResult::initial(Some("0.3.1"));
        r.latest = None;
        assert_eq!(r.effective_asset_name(), "iRouter-undefined");
        r.asset_name = "explicit.dmg".into();
        assert_eq!(r.effective_asset_name(), "explicit.dmg");
    }

    #[test]
    fn tag_name_is_not_trimmed_but_v_is_stripped_once() {
        let f = MockFetcher::ok(serde_json::json!([
            {"tag_name": "vv0.3.2", "draft": false, "prerelease": false, "assets": []}
        ]));
        let r = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        // `replace(/^v/i,"")` 只剥一个 v
        assert_eq!(r.latest.as_deref(), Some("v0.3.2"));

        // 前导空格让 `^v` 不匹配 → 原样保留（**不 trim**，面板显示的就是这个串）。
        // "vv0.3.2" 剥一个 v 后剩 "v0.3.2"，parseVersion 正则不认 → 判不出更新（与 JS 一致）
        let f2 = MockFetcher::ok(serde_json::json!([
            {"tag_name": " vv0.3.2 ", "draft": false, "prerelease": false, "assets": []}
        ]));
        let r2 = block_on(check_for_updates(&*f2, &opts("0.3.1", true), NOW));
        assert_eq!(r2.latest.as_deref(), Some(" vv0.3.2 "));
        assert!(!r2.update_available, "双 v 在 JS 里同样解析失败");

        // 单个前导 v + 两端空白：latest 保留空白，但 parseVersion 内部 trim 后能比较
        let f3 = MockFetcher::ok(serde_json::json!([
            {"tag_name": " v0.3.2 ", "draft": false, "prerelease": false, "assets": []}
        ]));
        let r3 = block_on(check_for_updates(&*f3, &opts("0.3.1", true), NOW));
        assert_eq!(r3.latest.as_deref(), Some(" v0.3.2 "));
        assert!(r3.update_available);
    }

    #[test]
    fn release_name_url_and_notes_follow_js_fallbacks() {
        let f = MockFetcher::ok(serde_json::json!([
            {"tag_name": "v0.3.2", "draft": false, "prerelease": false, "assets": [],
             "html_url": "", "body": ""}
        ]));
        let r = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        assert_eq!(r.release_name, "v0.3.2", "name 缺失 → 回落 tag_name");
        assert_eq!(r.release_notes, "");
        assert_eq!(r.release_url, DEFAULT_RELEASE_PAGE);
    }

    #[test]
    fn js_truthiness_of_draft_and_prerelease() {
        // "false"（非空字符串）在 JS 里是真值 → 该 release 会被过滤掉
        let f = MockFetcher::ok(serde_json::json!([
            {"tag_name": "v1.0.0", "draft": "false", "prerelease": false},
            {"tag_name": "v0.3.2", "draft": 0, "prerelease": null}
        ]));
        let r = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        assert_eq!(r.latest.as_deref(), Some("0.3.2"));
    }

    #[test]
    fn result_serializes_with_camel_case_keys_and_null_error() {
        let r = CheckResult::initial(Some("0.3.1"));
        let v = serde_json::to_value(&r).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "current",
            "latest",
            "updateAvailable",
            "releaseName",
            "releaseNotes",
            "releaseURL",
            "assetName",
            "downloadURL",
            "assetSize",
            "checksumsURL",
            "cached",
            "error",
        ] {
            assert!(obj.contains_key(key), "缺字段 {key}");
        }
        assert!(obj["error"].is_null(), "error 必须是 null 而不是缺键");
        assert_eq!(obj["releaseURL"], DEFAULT_RELEASE_PAGE);
        assert_eq!(obj.len(), 12, "多一个字段都是给面板埋坑");
    }

    #[test]
    fn cache_result_roundtrips_through_the_settings_file_shape() {
        // commands 侧把 CheckResult 序列化进 lastCheckResult，下次读回来必须还原
        let f = MockFetcher::ok(mock_releases());
        let original = block_on(check_for_updates(&*f, &opts("0.3.1", true), NOW));
        let stored = serde_json::to_value(&original).unwrap();

        let at = clock::iso8601_from_unix_ms(NOW - 1000);
        let f2 = MockFetcher::ok(mock_releases());
        let mut o = opts("0.3.1", false);
        o.last_check_at = Some(&at);
        o.last_check_result = Some(&stored);
        let cached = block_on(check_for_updates(&*f2, &o, NOW));
        assert_eq!(f2.call_count(), 0);
        assert_eq!(cached.latest, original.latest);
        assert_eq!(cached.asset_name, original.asset_name);
        assert_eq!(cached.asset_size, original.asset_size);
        assert!(cached.cached && !original.cached);
    }
}
