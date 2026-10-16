use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/**
 * 测速协议枚举
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpeedtestProtocol {
    /// OpenAI 兼容协议（/chat/completions）
    Openai,
    /// Anthropic 协议（/v1/messages）
    Anthropic,
    /// OpenAI Responses 协议（/v1/responses）
    Responses,
}

impl Default for SpeedtestProtocol {
    /**
     * 默认协议为 OpenAI 兼容协议
     *
     * @return 默认协议实例
     */
    fn default() -> Self {
        Self::Openai
    }
}

/**
 * 测速启动配置结构体
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestConfig {
    /// 前端生成的会话唯一标识符
    pub session_id: String,
    /// 目标服务接口完整 URL
    pub target_url: String,
    /// 调用的测速协议类型
    #[serde(default)]
    pub protocol: SpeedtestProtocol,
    /// 目标服务的鉴权密钥（仅在内存使用，绝不持久化）
    pub api_key: Option<String>,
    /// 调用的模型名称
    pub model: String,
    /// 测速使用的提示词
    pub prompt: String,
    /// 最大生成 Token 限制
    pub max_tokens: Option<u32>,
    /// 采样温度参数
    pub temperature: Option<f32>,
    /// 自定义附加请求头字典
    pub custom_headers: Option<HashMap<String, String>>,
    /// 全局超时时间（毫秒）
    pub timeout_ms: Option<u64>,
}

/**
 * 降采样速度曲线数据点
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurvePoint {
    /// 当前采样点对应的已生成 Token 数量
    pub token_index: usize,
    /// 从请求发起至今的流逝时间（毫秒）
    pub elapsed_ms: f64,
    /// 当前区间的瞬时吐词吞吐速度（tokens/s）
    pub speed: f64,
}

/**
 * 流式 Chunk 间隔统计与抖动指标
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMetrics {
    /// 相邻数据块到达时间差第 50 百分位数（中位数，毫秒）
    pub p50_ms: f64,
    /// 相邻数据块到达时间差第 95 百分位数（毫秒）
    pub p95_ms: f64,
    /// 相邻数据块到达时间差第 99 百分位数（毫秒）
    pub p99_ms: f64,
    /// 间隔离散比（P95 除以 P50），若 P50 为 0 则为 None
    pub jitter_ratio: Option<f64>,
}

/**
 * 实时流式测速进度通知事件负载
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestProgress {
    /// 会话唯一标识符
    pub session_id: String,
    /// 当前执行阶段状态
    pub step: String,
    /// 首包到达耗时（TTFT，毫秒）
    pub ttft_ms: Option<f64>,
    /// 当前累计流逝时间（毫秒）
    pub elapsed_ms: f64,
    /// 当前已累计接收的 Token 数量
    pub current_token_count: usize,
    /// 当前瞬时吞吐速度（tokens/s）
    pub current_speed: f64,
    /// 速度曲线最新采样点（若产生新采样）
    pub latest_curve_point: Option<CurvePoint>,
    /// 阶段性错误描述（如有）
    pub error: Option<String>,
}

/**
 * 测速终态指标结果结构体
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestResult {
    /// 会话唯一标识符
    pub session_id: String,
    /// 参测模型名称
    pub model: String,
    /// 测速执行是否成功完成
    pub success: bool,
    /// 首包延迟（TTFT，毫秒）
    pub ttft_ms: f64,
    /// 端到端总耗时（毫秒）
    pub total_duration_ms: f64,
    /// 纯生成阶段耗时（总耗时减去 TTFT，毫秒）
    pub generation_duration_ms: f64,
    /// 稳定吐词速度（tokens / 纯生成耗时，tokens/s）
    pub steady_speed: f64,
    /// 全程平均吞吐速度（tokens / 总耗时，tokens/s）
    pub avg_speed: f64,
    /// 实际统计或估算的输出 Token 数量
    pub output_tokens: usize,
    /// 输出 Token 是否由字符数估算得出
    pub tokens_estimated: bool,
    /// 数据块间隔分位数与抖动比指标
    pub chunk_metrics: ChunkMetrics,
    /// 降采样速度曲线点序列（最大 64 点）
    pub curve_points: Vec<CurvePoint>,
    /// 异常失败原因描述（如有）
    pub error_message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * 测试配置模型与序列化反序列化双向转换
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_speedtest_config_serde_roundtrip() {
        let config = SpeedtestConfig {
            session_id: "test-session-123".to_string(),
            target_url: "https://api.openai.com/v1/chat/completions".to_string(),
            protocol: SpeedtestProtocol::Openai,
            api_key: Some("sk-test12345".to_string()),
            model: "gpt-4o-mini".to_string(),
            prompt: "Hi".to_string(),
            max_tokens: Some(100),
            temperature: Some(0.7),
            custom_headers: None,
            timeout_ms: Some(15000),
        };

        let json = serde_json::to_string(&config).expect("序列化失败");
        let deserialized: SpeedtestConfig = serde_json::from_str(&json).expect("反序列化失败");

        assert_eq!(config.session_id, deserialized.session_id);
        assert_eq!(config.target_url, deserialized.target_url);
        assert_eq!(config.protocol, deserialized.protocol);
        assert_eq!(config.model, deserialized.model);
        assert_eq!(config.max_tokens, deserialized.max_tokens);
    }

    /**
     * 测试指标结果模型与序列化反序列化双向转换
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_speedtest_result_serde_roundtrip() {
        let result = SpeedtestResult {
            session_id: "test-session-123".to_string(),
            model: "claude-3-5-sonnet".to_string(),
            success: true,
            ttft_ms: 245.5,
            total_duration_ms: 3200.0,
            generation_duration_ms: 2954.5,
            steady_speed: 65.2,
            avg_speed: 60.1,
            output_tokens: 192,
            tokens_estimated: false,
            chunk_metrics: ChunkMetrics {
                p50_ms: 15.2,
                p95_ms: 38.6,
                p99_ms: 55.1,
                jitter_ratio: Some(2.54),
            },
            curve_points: vec![CurvePoint {
                token_index: 32,
                elapsed_ms: 500.0,
                speed: 64.0,
            }],
            error_message: None,
        };

        let json = serde_json::to_string(&result).expect("序列化失败");
        let deserialized: SpeedtestResult = serde_json::from_str(&json).expect("反序列化失败");

        assert_eq!(result.session_id, deserialized.session_id);
        assert_eq!(result.ttft_ms, deserialized.ttft_ms);
        assert_eq!(result.steady_speed, deserialized.steady_speed);
        assert_eq!(result.chunk_metrics.jitter_ratio, deserialized.chunk_metrics.jitter_ratio);
        assert_eq!(result.curve_points.len(), 1);
    }
}
