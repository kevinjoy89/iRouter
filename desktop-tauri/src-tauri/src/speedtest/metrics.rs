use super::types::{ChunkMetrics, CurvePoint};

/**
 * 按线性插值法计算切片的分位数
 *
 * @param sorted_vals 升序排列的浮点数切片
 * @param pct 分位数值（0.0 至 1.0 之间）
 * @return 线性插值计算得出的分位数值
 */
pub fn calculate_percentile(sorted_vals: &[f64], pct: f64) -> f64 {
    if sorted_vals.is_empty() {
        return 0.0;
    }
    if sorted_vals.len() == 1 {
        return sorted_vals[0];
    }
    let rank = pct * (sorted_vals.len() - 1) as f64;
    let lower = rank.floor() as usize;
    let upper = std::cmp::min(lower + 1, sorted_vals.len() - 1);
    let weight = rank - lower as f64;
    sorted_vals[lower] * (1.0 - weight) + sorted_vals[upper] * weight
}

/**
 * 计算数据块时间间隔的 P50、P95、P99 与离散比
 *
 * @param intervals_ms 相邻 chunk 到达时间间隔（毫秒）序列
 * @return 统计度量结构体
 */
pub fn calculate_chunk_metrics(intervals_ms: &[f64]) -> ChunkMetrics {
    if intervals_ms.is_empty() {
        return ChunkMetrics {
            p50_ms: 0.0,
            p95_ms: 0.0,
            p99_ms: 0.0,
            jitter_ratio: None,
        };
    }

    let mut sorted = intervals_ms.to_vec();
    // 使用浮点数全排序比较
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let p50_ms = calculate_percentile(&sorted, 0.50);
    let p95_ms = calculate_percentile(&sorted, 0.95);
    let p99_ms = calculate_percentile(&sorted, 0.99);

    let jitter_ratio = if p50_ms > 0.000001 {
        Some(p95_ms / p50_ms)
    } else {
        None
    };

    ChunkMetrics {
        p50_ms,
        p95_ms,
        p99_ms,
        jitter_ratio,
    }
}

/**
 * 计算稳定吐词速度与全程平均速度
 *
 * @param total_duration_ms 全程总耗时（毫秒）
 * @param ttft_ms 首包延迟耗时（毫秒）
 * @param output_tokens 输出 Token 数量
 * @return 元组 (稳定吐词速度, 平均速度)，单位均为 tokens/s
 */
pub fn calculate_speeds(total_duration_ms: f64, ttft_ms: f64, output_tokens: usize) -> (f64, f64) {
    if output_tokens == 0 {
        return (0.0, 0.0);
    }

    let total_duration_sec = (total_duration_ms.max(1.0)) / 1000.0;
    let avg_speed = output_tokens as f64 / total_duration_sec;

    let generation_duration_ms = total_duration_ms - ttft_ms;

    // 若有效吐词时间过短（< 50ms）且 Token 数较多，属于上游网关缓冲或单包响应，此时稳定速度退化为全链路平均速度
    let steady_speed = if generation_duration_ms < 50.0 && output_tokens > 5 {
        avg_speed
    } else {
        let gen_sec = generation_duration_ms.max(10.0) / 1000.0;
        let raw_steady = output_tokens as f64 / gen_sec;
        // 理论物理合理上限防御（大模型推导吞吐通常不高于 5000 tokens/s）
        if raw_steady > 5000.0 {
            avg_speed
        } else {
            raw_steady
        }
    };

    (steady_speed, avg_speed)
}

/**
 * 速度曲线降采样与点生成器
 *
 * @author iRouter
 * @since 2026-10-16
 */
#[derive(Debug, Clone)]
pub struct CurveDownsampler {
    /// 目标最大采样点数
    max_points: usize,
    /// 最小采样 token 步长
    min_step: usize,
    /// 已记录的采样点集合
    points: Vec<CurvePoint>,
    /// 上一个采样点的 Token 索引
    last_sampled_tokens: usize,
    /// 上一个采样点的流逝时间（毫秒）
    last_sampled_elapsed_ms: f64,
}

impl CurveDownsampler {
    /**
     * 创建降采样器实例
     *
     * @param max_points 最大采样点数量（默认 64）
     * @return 降采样器实例
     */
    pub fn new(max_points: usize) -> Self {
        Self {
            max_points,
            min_step: 4,
            points: Vec::new(),
            last_sampled_tokens: 0,
            last_sampled_elapsed_ms: 0.0,
        }
    }

    /**
     * 流式检查并追加采样点
     *
     * @param current_tokens 当前累计输出 Token 数量
     * @param elapsed_ms 当前累计流逝时间（毫秒）
     * @param expected_total 预期总 Token 数量（用于自适应调整步长）
     * @return 若产生新采样点则返回 Some，否则返回 None
     */
    pub fn maybe_sample(
        &mut self,
        current_tokens: usize,
        elapsed_ms: f64,
        expected_total: usize,
    ) -> Option<CurvePoint> {
        if current_tokens <= self.last_sampled_tokens {
            return None;
        }

        // 自适应步长：至少保证不会打满超过 max_points
        let adaptive_step = if expected_total > 0 {
            std::cmp::max(self.min_step, expected_total / self.max_points)
        } else {
            self.min_step
        };

        let diff_tokens = current_tokens - self.last_sampled_tokens;
        if diff_tokens >= adaptive_step && self.points.len() < self.max_points {
            let diff_time_sec = (elapsed_ms - self.last_sampled_elapsed_ms).max(1.0) / 1000.0;
            let speed = diff_tokens as f64 / diff_time_sec;

            let point = CurvePoint {
                token_index: current_tokens,
                elapsed_ms,
                speed,
            };

            self.points.push(point.clone());
            self.last_sampled_tokens = current_tokens;
            self.last_sampled_elapsed_ms = elapsed_ms;

            Some(point)
        } else {
            None
        }
    }

    /**
     * 结束测速并产出最终曲线序列（确保终点准确）
     *
     * @param final_tokens 最终总 Token 数量
     * @param final_elapsed_ms 最终总耗时（毫秒）
     * @param overall_speed 全程平均吞吐速度（tokens/s）
     * @return 最终的采样点列表
     */
    pub fn finish(
        mut self,
        final_tokens: usize,
        final_elapsed_ms: f64,
        overall_speed: f64,
    ) -> Vec<CurvePoint> {
        if final_tokens > 0 {
            let needs_endpoint = match self.points.last() {
                Some(last) => last.token_index != final_tokens,
                None => true,
            };

            if needs_endpoint {
                if self.points.len() >= self.max_points {
                    // 若已达到上限，将最后一个点更新为终点
                    self.points.pop();
                }
                self.points.push(CurvePoint {
                    token_index: final_tokens,
                    elapsed_ms: final_elapsed_ms,
                    speed: overall_speed,
                });
            }
        }
        self.points
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * 测试百分位数计算插值精度
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_calculate_percentile() {
        let vals = vec![10.0, 20.0, 30.0, 40.0, 50.0];
        // 5 个元素，index 0..4。P50 rank = 0.5 * 4 = 2 -> 30.0
        assert_eq!(calculate_percentile(&vals, 0.5), 30.0);
        // P0 rank = 0 -> 10.0
        assert_eq!(calculate_percentile(&vals, 0.0), 10.0);
        // P100 rank = 4 -> 50.0
        assert_eq!(calculate_percentile(&vals, 1.0), 50.0);
        // P95 rank = 0.95 * 4 = 3.8 -> 40.0 * 0.2 + 50.0 * 0.8 = 48.0
        assert_eq!(calculate_percentile(&vals, 0.95), 48.0);
    }

    /**
     * 测试 Chunk 度量指标与抖动比计算
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_calculate_chunk_metrics() {
        let intervals = vec![10.0, 10.0, 10.0, 20.0, 50.0];
        let metrics = calculate_chunk_metrics(&intervals);
        assert_eq!(metrics.p50_ms, 10.0);
        assert!(metrics.p95_ms > 20.0);
        assert!(metrics.jitter_ratio.is_some());
        assert!(metrics.jitter_ratio.unwrap() > 1.0);
    }

    /**
     * 测试吞吐速度计算
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_calculate_speeds() {
        // 总耗时 2500ms，TTFT 500ms，净生成 2000ms（2 秒），生成 100 个 token
        let (steady, avg) = calculate_speeds(2500.0, 500.0, 100);
        assert_eq!(steady, 50.0);
        assert_eq!(avg, 40.0);

        // 测试上游网关缓冲突发单包场景（TTFT 与总耗时极度接近）
        let (steady_buffered, avg_buffered) = calculate_speeds(18240.0, 18239.0, 2048);
        assert_eq!(steady_buffered, avg_buffered);
        assert!(steady_buffered < 500.0);
    }

    /**
     * 测试降采样器点数限制与终点闭合
     *
     * @return 单元测试断言结果
     */
    #[test]
    fn test_downsampler_limits_and_finish() {
        let mut downsampler = CurveDownsampler::new(10);
        for i in 1..=100 {
            downsampler.maybe_sample(i, i as f64 * 20.0, 100);
        }
        let points = downsampler.finish(100, 2000.0, 50.0);
        assert!(points.len() <= 10);
        assert_eq!(points.last().unwrap().token_index, 100);
    }
}
