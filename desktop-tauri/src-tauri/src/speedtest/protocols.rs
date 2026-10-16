use std::collections::HashMap;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use super::types::{SpeedtestConfig, SpeedtestProtocol};

/**
 * 流式 SSE 解析出的单步增量结果
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Clone, Default)]
pub struct StreamParsedChunk {
    /// 本次数据块中解析出的新增文本内容
    pub text_delta: Option<String>,
    /// 若数据块携带官方 Usage 统计，记录累计输出 Token 数量
    pub usage_tokens: Option<usize>,
    /// 是否收到流结束标志（如 [DONE] 或 message_stop）
    pub is_done: bool,
}

/**
 * 协议处理器 Trait，定义请求组装与流式状态机解析
 *
 * @author iRouter
 * @since 2026-10-16
 */
pub trait ProtocolHandler: Send + Sync {
    /**
     * 构建 HTTP 请求头集合
     *
     * @param config 测速配置
     * @return 构建好的 HeaderMap
     */
    fn build_headers(&self, config: &SpeedtestConfig) -> HeaderMap;

    /**
     * 构建 HTTP 请求体 JSON 载荷
     *
     * @param config 测速配置
     * @return JSON 对象值
     */
    fn build_payload(&self, config: &SpeedtestConfig) -> Value;

    /**
     * 解析单个 SSE 数据行或事件块
     *
     * @param event_type SSE 报文的 event 字段值
     * @param data_str SSE 报文的 data 负载字符串
     * @return 解析得出的单步增量结果
     */
    fn parse_event(&self, event_type: Option<&str>, data_str: &str) -> StreamParsedChunk;
}

/**
 * OpenAI 兼容协议处理器
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Default)]
pub struct OpenaiHandler;

impl ProtocolHandler for OpenaiHandler {
    /**
     * 构建 OpenAI 兼容协议请求头
     *
     * @param config 测速配置
     * @return HeaderMap
     */
    fn build_headers(&self, config: &SpeedtestConfig) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(ref key) = config.api_key {
            let auth_val = format!("Bearer {}", key.trim());
            if let Ok(val) = HeaderValue::from_str(&auth_val) {
                headers.insert(AUTHORIZATION, val);
            }
        }
        apply_custom_headers(&mut headers, &config.custom_headers);
        headers
    }

    /**
     * 构建 OpenAI 兼容协议 Payload
     *
     * @param config 测速配置
     * @return JSON 对象值
     */
    fn build_payload(&self, config: &SpeedtestConfig) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("model".to_string(), json!(config.model));
        map.insert(
            "messages".to_string(),
            json!([{"role": "user", "content": config.prompt}]),
        );
        map.insert("stream".to_string(), json!(true));
        map.insert(
            "stream_options".to_string(),
            json!({"include_usage": true}),
        );
        if let Some(tokens) = config.max_tokens {
            map.insert("max_tokens".to_string(), json!(tokens));
        }
        if let Some(temp) = config.temperature {
            map.insert("temperature".to_string(), json!(temp));
        }
        Value::Object(map)
    }

    /**
     * 解析 OpenAI 兼容协议的流式事件
     *
     * @param _event_type 未使用的事件类型
     * @param data_str 数据字符串
     * @return 解析结果
     */
    fn parse_event(&self, _event_type: Option<&str>, data_str: &str) -> StreamParsedChunk {
        let trimmed = data_str.trim();
        if trimmed == "[DONE]" {
            return StreamParsedChunk {
                is_done: true,
                ..Default::default()
            };
        }

        let mut chunk = StreamParsedChunk::default();
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            // 提取 choices[0].delta.content
            if let Some(content) = v.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
                if !content.is_empty() {
                    chunk.text_delta = Some(content.to_string());
                }
            }
            // 提取 usage.completion_tokens
            if let Some(tokens) = v.pointer("/usage/completion_tokens").and_then(|u| u.as_u64()) {
                chunk.usage_tokens = Some(tokens as usize);
            }
            // 检查 finish_reason 是否标志完成
            if let Some(finish) = v.pointer("/choices/0/finish_reason").and_then(|f| f.as_str()) {
                if !finish.is_empty() && finish != "null" {
                    chunk.is_done = true;
                }
            }
        }
        chunk
    }
}

/**
 * Anthropic Messages 协议处理器
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Default)]
pub struct AnthropicHandler;

impl ProtocolHandler for AnthropicHandler {
    /**
     * 构建 Anthropic 协议请求头
     *
     * @param config 测速配置
     * @return HeaderMap
     */
    fn build_headers(&self, config: &SpeedtestConfig) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static("2023-06-01"),
        );
        if let Some(ref key) = config.api_key {
            if let Ok(val) = HeaderValue::from_str(key.trim()) {
                headers.insert(HeaderName::from_static("x-api-key"), val);
            }
        }
        apply_custom_headers(&mut headers, &config.custom_headers);
        headers
    }

    /**
     * 构建 Anthropic 协议 Payload
     *
     * @param config 测速配置
     * @return JSON 对象值
     */
    fn build_payload(&self, config: &SpeedtestConfig) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("model".to_string(), json!(config.model));
        map.insert(
            "messages".to_string(),
            json!([{"role": "user", "content": config.prompt}]),
        );
        map.insert("stream".to_string(), json!(true));
        // Anthropic 要求必须指定 max_tokens，若无则默认 1024
        let max_tokens = config.max_tokens.unwrap_or(1024);
        map.insert("max_tokens".to_string(), json!(max_tokens));

        if let Some(temp) = config.temperature {
            map.insert("temperature".to_string(), json!(temp));
        }
        Value::Object(map)
    }

    /**
     * 解析 Anthropic 协议的流式事件
     *
     * @param event_type SSE 报文中的 event 字段
     * @param data_str 数据字符串
     * @return 解析结果
     */
    fn parse_event(&self, event_type: Option<&str>, data_str: &str) -> StreamParsedChunk {
        let mut chunk = StreamParsedChunk::default();
        let trimmed = data_str.trim();

        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            let ev_type = event_type
                .or_else(|| v.get("type").and_then(|t| t.as_str()))
                .unwrap_or("");

            match ev_type {
                "content_block_delta" => {
                    if let Some(text) = v.pointer("/delta/text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            chunk.text_delta = Some(text.to_string());
                        }
                    }
                }
                "message_delta" => {
                    if let Some(tokens) = v.pointer("/usage/output_tokens").and_then(|u| u.as_u64()) {
                        chunk.usage_tokens = Some(tokens as usize);
                    }
                }
                "message_stop" => {
                    chunk.is_done = true;
                }
                _ => {}
            }
        }
        chunk
    }
}

/**
 * OpenAI Responses 协议处理器
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Default)]
pub struct ResponsesHandler;

impl ProtocolHandler for ResponsesHandler {
    /**
     * 构建 OpenAI Responses 协议请求头
     *
     * @param config 测速配置
     * @return HeaderMap
     */
    fn build_headers(&self, config: &SpeedtestConfig) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(ref key) = config.api_key {
            let auth_val = format!("Bearer {}", key.trim());
            if let Ok(val) = HeaderValue::from_str(&auth_val) {
                headers.insert(AUTHORIZATION, val);
            }
        }
        apply_custom_headers(&mut headers, &config.custom_headers);
        headers
    }

    /**
     * 构建 OpenAI Responses 协议 Payload
     *
     * @param config 测速配置
     * @return JSON 对象值
     */
    fn build_payload(&self, config: &SpeedtestConfig) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("model".to_string(), json!(config.model));
        map.insert("input".to_string(), json!(config.prompt));
        map.insert("stream".to_string(), json!(true));
        if let Some(temp) = config.temperature {
            map.insert("temperature".to_string(), json!(temp));
        }
        Value::Object(map)
    }

    /**
     * 解析 OpenAI Responses 协议流式事件
     *
     * @param event_type SSE 报文中的 event 字段
     * @param data_str 数据字符串
     * @return 解析结果
     */
    fn parse_event(&self, event_type: Option<&str>, data_str: &str) -> StreamParsedChunk {
        let mut chunk = StreamParsedChunk::default();
        let trimmed = data_str.trim();

        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            let ev_type = event_type
                .or_else(|| v.get("type").and_then(|t| t.as_str()))
                .unwrap_or("");

            if ev_type.contains("text.delta") || ev_type.contains("output_item.delta") {
                if let Some(delta) = v.get("delta").and_then(|d| d.as_str()) {
                    chunk.text_delta = Some(delta.to_string());
                }
            } else if ev_type.contains("completed") {
                if let Some(tokens) = v.pointer("/response/usage/output_tokens").and_then(|u| u.as_u64()) {
                    chunk.usage_tokens = Some(tokens as usize);
                }
                chunk.is_done = true;
            }
        }
        chunk
    }
}

/**
 * 根据协议枚举获取对应的处理器实现
 *
 * @param protocol 测速协议枚举
 * @return 动态分发的 ProtocolHandler 引用
 */
pub fn get_handler(protocol: SpeedtestProtocol) -> Box<dyn ProtocolHandler> {
    match protocol {
        SpeedtestProtocol::Openai => Box::new(OpenaiHandler),
        SpeedtestProtocol::Anthropic => Box::new(AnthropicHandler),
        SpeedtestProtocol::Responses => Box::new(ResponsesHandler),
    }
}

/**
 * 将用户自定义请求头附加至目标 HeaderMap
 *
 * @param headers 目标 HeaderMap
 * @param custom_headers 自定义请求头字典引用
 */
fn apply_custom_headers(headers: &mut HeaderMap, custom_headers: &Option<HashMap<String, String>>) {
    if let Some(ref map) = custom_headers {
        for (k, v) in map {
            if let (Ok(name), Ok(val)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                headers.insert(name, val);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * 测试 OpenAI 流式数据块解析
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_openai_stream_parsing() {
        let handler = OpenaiHandler;
        let data = r#"{"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"}}]}"#;
        let chunk = handler.parse_event(None, data);
        assert_eq!(chunk.text_delta.as_deref(), Some("Hello"));
        assert_eq!(chunk.is_done, false);

        let done_data = "[DONE]";
        let chunk_done = handler.parse_event(None, done_data);
        assert_eq!(chunk_done.is_done, true);
    }

    /**
     * 测试 Anthropic 流式事件解析
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_anthropic_stream_parsing() {
        let handler = AnthropicHandler;
        let delta_data = r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"World"}}"#;
        let chunk = handler.parse_event(Some("content_block_delta"), delta_data);
        assert_eq!(chunk.text_delta.as_deref(), Some("World"));

        let usage_data = r#"{"type":"message_delta","usage":{"output_tokens":42}}"#;
        let chunk_usage = handler.parse_event(Some("message_delta"), usage_data);
        assert_eq!(chunk_usage.usage_tokens, Some(42));
    }
}
