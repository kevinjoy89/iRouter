use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use super::metrics::{calculate_chunk_metrics, calculate_speeds, CurveDownsampler};
use super::protocols::get_handler;
use super::types::{SpeedtestConfig, SpeedtestProgress, SpeedtestResult};

/**
 * 全局活跃测速会话管理器
 *
 * @author iRouter
 * @since 2026-10-16
 */
pub struct SessionRegistry {
    /// 存放会话 ID 与中止信号标志的映射表
    sessions: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SessionRegistry {
    /**
     * 创建会话管理器新实例
     *
     * @return 会话管理器实例
     */
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /**
     * 注册新会话并获取其中止信号标志
     *
     * @param session_id 会话唯一标识符
     * @return 中止信号原子标志引用
     */
    pub fn register(&self, session_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut lock) = self.sessions.lock() {
            lock.insert(session_id.to_string(), Arc::clone(&flag));
        }
        flag
    }

    /**
     * 中止指定会话的测速执行
     *
     * @param session_id 待中止的会话标识符
     * @return 是否成功找到并触发中止
     */
    pub fn abort(&self, session_id: &str) -> bool {
        if let Ok(mut lock) = self.sessions.lock() {
            if let Some(flag) = lock.remove(session_id) {
                flag.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }

    /**
     * 注销已结束的会话
     *
     * @param session_id 待注销的会话标识符
     */
    pub fn unregister(&self, session_id: &str) {
        if let Ok(mut lock) = self.sessions.lock() {
            lock.remove(session_id);
        }
    }
}

/// 全局单例会话管理器
pub static REGISTRY: LazyLock<SessionRegistry> = LazyLock::new(SessionRegistry::new);

/**
 * 判定目标 URL 是否为本地回路或 RFC 1918 私网/局域网专线地址
 *
 * @param url 待检测的目标 URL 字符串
 * @return 若属于私网或本地回路则返回 true，公网返回 false
 * @author iRouter
 * @since 2026-10-19
 */
pub fn is_private_or_local_target(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };

    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".local") {
        return true;
    }

    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback() || v4.is_private() || v4.is_link_local()
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
            }
        }
    } else {
        false
    }
}

/**
 * 驱动单次测速任务执行的主引擎函数
 *
 * @param config 测速请求配置
 * @param abort_flag 中止控制标志引用
 * @param on_progress 进度事件通知回调
 * @return 测速结果或错误描述
 */
pub async fn execute_speedtest<F>(
    config: SpeedtestConfig,
    abort_flag: Arc<AtomicBool>,
    on_progress: F,
) -> Result<SpeedtestResult, String>
where
    F: Fn(SpeedtestProgress) + Send + Sync + 'static,
{
    let session_id = config.session_id.clone();
    let model_name = config.model.clone();
    let handler = get_handler(config.protocol);

    // 初始通知：正在建立连接
    on_progress(SpeedtestProgress {
        session_id: session_id.clone(),
        step: "connecting".to_string(),
        ttft_ms: None,
        elapsed_ms: 0.0,
        current_token_count: 0,
        current_speed: 0.0,
        latest_curve_point: None,
        error: None,
    });

    let mut client_builder = reqwest::Client::builder();

    // 针对本地回路与私网/专线端点，坚决禁用系统代理，避免被本地代理软件（如 Clash/Surge）拦截产生 502
    if is_private_or_local_target(&config.target_url) {
        client_builder = client_builder.no_proxy();
    }

    // 设置请求超时时间（默认 60 秒）
    let timeout_ms = config.timeout_ms.unwrap_or(60_000);
    client_builder = client_builder.timeout(std::time::Duration::from_millis(timeout_ms));

    let client = client_builder
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    let headers = handler.build_headers(&config);
    let payload = handler.build_payload(&config);

    log::info!(
        "[speedtest] 发起测速请求: sid={}, url={}, model={}",
        session_id, config.target_url, config.model
    );

    let start_instant = Instant::now();

    let request_builder = client
        .post(&config.target_url)
        .headers(headers)
        .json(&payload);

    let mut response = match request_builder.send().await {
        Ok(resp) => resp,
        Err(err) => {
            let err_msg = format!("HTTP 网络请求异常: {err}");
            log::warn!("[speedtest] HTTP 请求异常: sid={}, err={}", session_id, err_msg);
            on_progress(SpeedtestProgress {
                session_id: session_id.clone(),
                step: "failed".to_string(),
                ttft_ms: None,
                elapsed_ms: start_instant.elapsed().as_secs_f64() * 1000.0,
                current_token_count: 0,
                current_speed: 0.0,
                latest_curve_point: None,
                error: Some(err_msg.clone()),
            });
            return Err(err_msg);
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let err_msg = format!("上游返回 HTTP 错误状态码 {status}: {body}");
        log::warn!("[speedtest] 上游状态异常: sid={}, err={}", session_id, err_msg);
        on_progress(SpeedtestProgress {
            session_id: session_id.clone(),
            step: "failed".to_string(),
            ttft_ms: None,
            elapsed_ms: start_instant.elapsed().as_secs_f64() * 1000.0,
            current_token_count: 0,
            current_speed: 0.0,
            latest_curve_point: None,
            error: Some(err_msg.clone()),
        });
        return Err(err_msg);
    }

    // 状态统计变量
    let mut ttft_instant: Option<Instant> = None;
    let mut last_chunk_instant: Option<Instant> = None;
    let mut intervals_ms: Vec<f64> = Vec::new();
    let mut accumulated_chars: usize = 0;
    let mut official_usage_tokens: Option<usize> = None;
    let mut downsampler = CurveDownsampler::new(64);

    let mut buffer = String::new();
    let mut current_event: Option<String> = None;

    // 流式读取循环
    loop {
        if abort_flag.load(Ordering::SeqCst) {
            on_progress(SpeedtestProgress {
                session_id: session_id.clone(),
                step: "aborted".to_string(),
                ttft_ms: ttft_instant.map(|t| (t - start_instant).as_secs_f64() * 1000.0),
                elapsed_ms: start_instant.elapsed().as_secs_f64() * 1000.0,
                current_token_count: accumulated_chars / 4,
                current_speed: 0.0,
                latest_curve_point: None,
                error: Some("测速已被主动中止".to_string()),
            });
            return Err("测速已被主动中止".to_string());
        }

        let chunk = match response.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let err_msg = format!("读取流式数据块异常: {e}");
                return Err(err_msg);
            }
        };

        let now = Instant::now();
        if let Some(prev) = last_chunk_instant {
            intervals_ms.push((now - prev).as_secs_f64() * 1000.0);
        }
        last_chunk_instant = Some(now);

        let chunk_str = String::from_utf8_lossy(&chunk);
        buffer.push_str(&chunk_str);

        // 按行解析 SSE
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                current_event = None;
                continue;
            }

            if let Some(event_name) = line.strip_prefix("event:") {
                current_event = Some(event_name.trim().to_string());
            } else if let Some(data_str) = line.strip_prefix("data:") {
                let parsed = handler.parse_event(current_event.as_deref(), data_str.trim());

                if let Some(ref text) = parsed.text_delta {
                    if ttft_instant.is_none() {
                        ttft_instant = Some(now);
                    }
                    accumulated_chars += text.chars().count();

                    let current_tokens = official_usage_tokens.unwrap_or(accumulated_chars / 4);
                    let elapsed_ms = start_instant.elapsed().as_secs_f64() * 1000.0;
                    let latest_point = downsampler.maybe_sample(current_tokens, elapsed_ms, 1000);

                    let (steady_spd, _) = calculate_speeds(
                        elapsed_ms,
                        ttft_instant.map(|t| (t - start_instant).as_secs_f64() * 1000.0).unwrap_or(0.0),
                        current_tokens,
                    );

                    on_progress(SpeedtestProgress {
                        session_id: session_id.clone(),
                        step: "streaming".to_string(),
                        ttft_ms: ttft_instant.map(|t| (t - start_instant).as_secs_f64() * 1000.0),
                        elapsed_ms,
                        current_token_count: current_tokens,
                        current_speed: steady_spd,
                        latest_curve_point: latest_point,
                        error: None,
                    });
                }

                if let Some(usage) = parsed.usage_tokens {
                    official_usage_tokens = Some(usage);
                }

                if parsed.is_done {
                    break;
                }
            }
        }
    }

    let end_instant = Instant::now();
    let total_duration_ms = (end_instant - start_instant).as_secs_f64() * 1000.0;
    let ttft_ms = ttft_instant
        .map(|t| (t - start_instant).as_secs_f64() * 1000.0)
        .unwrap_or(total_duration_ms);

    let generation_duration_ms = (total_duration_ms - ttft_ms).max(0.0);

    let (output_tokens, tokens_estimated) = match official_usage_tokens {
        Some(tokens) => (tokens, false),
        None => (std::cmp::max(1, accumulated_chars / 4), true),
    };

    let (steady_speed, avg_speed) = calculate_speeds(total_duration_ms, ttft_ms, output_tokens);
    let chunk_metrics = calculate_chunk_metrics(&intervals_ms);
    let curve_points = downsampler.finish(output_tokens, total_duration_ms, avg_speed);

    let final_result = SpeedtestResult {
        session_id: session_id.clone(),
        model: model_name,
        success: true,
        ttft_ms,
        total_duration_ms,
        generation_duration_ms,
        steady_speed,
        avg_speed,
        output_tokens,
        tokens_estimated,
        chunk_metrics: chunk_metrics.clone(),
        curve_points: curve_points.clone(),
        error_message: None,
    };

    // 发送最终完成通知
    on_progress(SpeedtestProgress {
        session_id,
        step: "completed".to_string(),
        ttft_ms: Some(ttft_ms),
        elapsed_ms: total_duration_ms,
        current_token_count: output_tokens,
        current_speed: steady_speed,
        latest_curve_point: curve_points.last().cloned(),
        error: None,
    });

    Ok(final_result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * 测试会话注册与主动中止信令触发
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_session_registry_abort() {
        let registry = SessionRegistry::new();
        let sid = "test-session-abort";
        let flag = registry.register(sid);

        assert_eq!(flag.load(Ordering::SeqCst), false);
        let aborted = registry.abort(sid);
        assert_eq!(aborted, true);
        assert_eq!(flag.load(Ordering::SeqCst), true);
    }

    /**
     * 测试本地回路与私网专线端点的识别判定
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_is_private_or_local_target() {
        assert!(is_private_or_local_target("http://127.0.0.1:20128/v1/chat/completions"));
        assert!(is_private_or_local_target("http://localhost:5500/v1"));
        assert!(is_private_or_local_target("http://172.17.10.25:5500/v1/chat/completions"));
        assert!(is_private_or_local_target("http://192.168.1.1:8080"));
        assert!(is_private_or_local_target("http://10.0.0.8:9000"));
        assert!(is_private_or_local_target("http://test.local/v1"));
        assert!(!is_private_or_local_target("https://api.openai.com/v1/chat/completions"));
        assert!(!is_private_or_local_target("https://api.deepseek.com/chat/completions"));
    }
}
