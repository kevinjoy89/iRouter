//! HTTP 客户端与重定向跟随（`checker.js:28-77` + `download.js:32-68` 的公共管道）。
//!
//! ## 三条与 JS 对齐的语义
//!   1. **重定向手动跟随**：JS 递归跟随 3xx + `location`，**没有次数上限**。
//!      `reqwest` 的默认策略是 10 跳，直接用它就是行为变更；这里 `Policy::none()` +
//!      手写循环，上限取 20（GitHub→S3 只有 1-2 跳），超过上限则把最后一次的 3xx 原样
//!      返回，调用方按"非 200"报错 —— 见 §2.4 陷阱。
//!   2. **超时只在 `fetchJson` / `fetchText` 上**（15000ms）。**下载不设超时**：
//!      `downloadFile` 的 JS 实现没有 timeout，给 139 MB 的 dmg 加总超时会把正常下载掐死。
//!   3. **错误文案**：`GitHub API HTTP <code>` / `HTTP <code> fetching <url>` 逐字复刻；
//!      两个"超时"文案不同（`Update check timed out` vs `Request timed out`），
//!      所以超时错误由调用方构造传入。

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, LOCATION, USER_AGENT};
use reqwest::{Client, Response, StatusCode};
use serde_json::Value;

use super::error::UpdaterError;

/// 默认 UA（`checker.js:38` / `download.js:38`）。
pub const DEFAULT_USER_AGENT: &str = "iRouter-Desktop";
/// GitHub API 的 Accept（`checker.js:39`）；覆盖前可被调用方替换。
pub const GITHUB_ACCEPT: &str = "application/vnd.github.v3+json";
/// `fetchJson` / `fetchText` 的默认超时（`timeoutMs = 15000`）。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// 重定向上限。JS 无上限；真实跳数 1-2，20 是"不可能拦住正常请求"的安全阀。
const MAX_REDIRECTS: usize = 20;

/// 构造更新器用的 HTTP 客户端：**不自动跟随重定向**（我们手动跟随，语义与 JS 一致）。
pub fn build_client() -> Result<Client, UpdaterError> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(UpdaterError::from)
}

/// 发一个 GET 并手动跟随重定向，返回 `(最终响应, 最终 URL)`。
///
/// `location` 用 `Url::join` 解析：绝对 URL 与相对路径都支持。JS 侧 `new URL(location)`
/// 只接受绝对 URL、相对值会抛（未捕获）——**这里更宽**，属可接受偏差（只会让原本崩的
/// 情况正常跟随）。
pub(crate) async fn get_following_redirects(
    client: &Client,
    url: &str,
    headers: &HeaderMap,
    timeout: Option<Duration>,
    timeout_err: fn() -> UpdaterError,
) -> Result<(Response, String), UpdaterError> {
    let mut current = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let mut req = client.get(&current).headers(headers.clone());
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        let resp = req.send().await.map_err(|e| map_send_err(e, timeout_err))?;
        let status = resp.status();
        let location = resp
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);

        if status.as_u16() >= 300 && status.as_u16() < 400 {
            if let Some(loc) = location {
                let next = match reqwest::Url::parse(&current).and_then(|base| base.join(&loc)) {
                    Ok(u) => u.to_string(),
                    Err(_) => loc, // JS 里相对 Location 会抛；退化成"直接当 URL 用"
                };
                current = next;
                continue;
            }
        }
        return Ok((resp, current));
    }
    // 超过上限：再发一次，把最后的 3xx 原样交回调用方（它会按非 200 报错，与 JS 的
    // "无上限"只在环路/恶意响应上有差异）
    let req = client.get(&current).headers(headers.clone());
    let resp = req.send().await.map_err(|e| map_send_err(e, timeout_err))?;
    Ok((resp, current))
}

fn map_send_err(e: reqwest::Error, timeout_err: fn() -> UpdaterError) -> UpdaterError {
    if e.is_timeout() {
        timeout_err()
    } else {
        UpdaterError::Http(e)
    }
}

/// `checker.js:28-77` 的等价物：`Accept: application/vnd.github.v3+json` +
/// `User-Agent: <user_agent>`（调用方传 `iRouter-Desktop/<version>`，会覆盖默认 UA）。
pub async fn fetch_json(
    client: &Client,
    url: &str,
    headers: &HeaderMap,
) -> Result<Value, UpdaterError> {
    let (resp, _final_url) = get_following_redirects(
        client,
        url,
        headers,
        Some(DEFAULT_TIMEOUT),
        || UpdaterError::CheckTimeout,
    )
    .await?;

    let status = resp.status();
    if status != StatusCode::OK {
        // JS `res.resume()` 排空后 reject —— drop 响应体即可（连接交给连接池处理）
        return Err(UpdaterError::HttpStatus(status.as_u16()));
    }

    let text = resp.text().await.map_err(UpdaterError::from)?;
    serde_json::from_str::<Value>(&text).map_err(|e| UpdaterError::InvalidJson(e.to_string()))
}

/// `download.js:32-68` 的等价物（只用于下载 `checksums.txt`）。
/// 错误文案带**当前** URL（跟随重定向后的那个，与 JS 递归一致）。
pub async fn fetch_text(client: &Client, url: &str, user_agent: &str) -> Result<String, UpdaterError> {
    let headers = text_headers(user_agent);
    let (resp, final_url) = get_following_redirects(
        client,
        url,
        &headers,
        Some(DEFAULT_TIMEOUT),
        || UpdaterError::RequestTimeout,
    )
    .await?;

    let status = resp.status();
    if status != StatusCode::OK {
        return Err(UpdaterError::FetchTextHttp {
            status: status.as_u16(),
            url: final_url,
        });
    }
    resp.text().await.map_err(UpdaterError::from)
}

/// `{"User-Agent": ua, "Accept": "application/vnd.github.v3+json"}`。
pub fn json_headers(user_agent: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    insert(&mut h, USER_AGENT, user_agent);
    insert(&mut h, ACCEPT, GITHUB_ACCEPT);
    h
}

/// `{"User-Agent": ua}`（`fetchText` 只发 UA）。
pub fn text_headers(user_agent: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    insert(&mut h, USER_AGENT, user_agent);
    h
}

fn insert(h: &mut HeaderMap, name: reqwest::header::HeaderName, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        h.insert(name, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::testserver::{spawn, Reply};

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn client_builds_without_following_redirects() {
        assert!(build_client().is_ok());
    }

    #[test]
    fn fetch_json_follows_redirects_and_parses() {
        let port = spawn(|path, _| match path {
            "/start" => Reply::redirect("/final"),
            "/final" => Reply::json(200, r#"{"ok":true}"#),
            _ => Reply::text(404, "nope"),
        });
        let client = build_client().unwrap();
        let v = block_on(fetch_json(
            &client,
            &format!("http://127.0.0.1:{port}/start"),
            &json_headers("iRouter-Desktop/0.3.7"),
        ))
        .unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
    }

    #[test]
    fn fetch_json_maps_status_and_json_errors_verbatim() {
        let port = spawn(|path, _| match path {
            "/500" => Reply::text(500, "boom"),
            "/bad" => Reply::text(200, "{not json"),
            "/missing" => Reply::text(302, ""),
            _ => Reply::text(200, "{}"),
        });
        let client = build_client().unwrap();

        let e = block_on(fetch_json(
            &client,
            &format!("http://127.0.0.1:{port}/500"),
            &json_headers("ua"),
        ))
        .unwrap_err();
        assert_eq!(e.message(), "GitHub API HTTP 500");

        let e = block_on(fetch_json(
            &client,
            &format!("http://127.0.0.1:{port}/bad"),
            &json_headers("ua"),
        ))
        .unwrap_err();
        assert!(e.message().starts_with("Invalid JSON response: "), "{}", e.message());

        // 3xx 但没有 location → 不是重定向跟随，落到"非 200"
        let e = block_on(fetch_json(
            &client,
            &format!("http://127.0.0.1:{port}/missing"),
            &json_headers("ua"),
        ))
        .unwrap_err();
        assert_eq!(e.message(), "GitHub API HTTP 302");
    }

    #[test]
    fn fetch_text_reports_the_final_url_like_the_js_recursion() {
        let port = spawn(|path, _| match path {
            "/moved" => Reply::redirect("/gone"),
            _ => Reply::text(404, ""),
        });
        let client = build_client().unwrap();
        let e = block_on(fetch_text(
            &client,
            &format!("http://127.0.0.1:{port}/moved"),
            DEFAULT_USER_AGENT,
        ))
        .unwrap_err();
        assert_eq!(
            e.message(),
            format!("HTTP 404 fetching http://127.0.0.1:{port}/gone")
        );
    }

    #[test]
    fn fetch_text_reads_body() {
        let port = spawn(|_, _| Reply::text(200, "abc  file.bin\n"));
        let client = build_client().unwrap();
        let s = block_on(fetch_text(
            &client,
            &format!("http://127.0.0.1:{port}/checksums.txt"),
            DEFAULT_USER_AGENT,
        ))
        .unwrap();
        assert_eq!(s, "abc  file.bin\n");
    }

    #[test]
    fn timeout_is_mapped_by_the_caller() {
        // 服务端故意不回响应 → 请求超时
        let port = spawn(|_, _| Reply::hang());
        let client = build_client().unwrap();
        let e = block_on(get_following_redirects(
            &client,
            &format!("http://127.0.0.1:{port}/slow"),
            &json_headers("ua"),
            Some(Duration::from_millis(120)),
            || UpdaterError::CheckTimeout,
        ))
        .unwrap_err();
        assert_eq!(e.message(), "Update check timed out");
    }
}
