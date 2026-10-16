/**
 * 测速模块通用 TypeScript 类型与接口定义
 *
 * @author iRouter
 * @since 2026-10-16
 */

/**
 * 测速协议类型
 */
export type SpeedtestProtocol = "openai" | "anthropic" | "responses";

/**
 * 测速启动配置接口
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface SpeedtestConfig {
  sessionId?: string;
  targetUrl: string;
  protocol?: SpeedtestProtocol;
  apiKey?: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * 速度曲线采样点接口
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface CurvePoint {
  tokenIndex: number;
  elapsedMs: number;
  speed: number;
}

/**
 * 数据块间隔统计指标
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface ChunkMetrics {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  jitterRatio: number | null;
}

/**
 * 实时流式测速进度事件负载
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface SpeedtestProgress {
  sessionId: string;
  step: "connecting" | "streaming" | "calculating" | "completed" | "aborted" | "failed";
  ttftMs?: number | null;
  elapsedMs: number;
  currentTokenCount: number;
  currentSpeed: number;
  latestCurvePoint?: CurvePoint | null;
  error?: string | null;
  result?: SpeedtestResult | null;
}

/**
 * 终态测速评测结果接口
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface SpeedtestResult {
  sessionId: string;
  model: string;
  provider?: string | null;
  gatewayUrl?: string;
  protocol?: SpeedtestProtocol;
  success: boolean;
  ttftMs: number;
  totalDurationMs: number;
  generationDurationMs: number;
  steadySpeed: number;
  avgSpeed: number;
  outputTokens: number;
  tokensEstimated: boolean;
  chunkMetrics: ChunkMetrics;
  curvePoints: CurvePoint[];
  keyFingerprint?: string;
  isGateway?: boolean;
  errorMessage?: string | null;
  createdAt?: string;
}

/**
 * 待测条目队列元素
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface BatchSpeedtestItem {
  id: string;
  label: string;
  model: string;
  rawModel?: string;
  provider: string;
  targetUrl: string;
  protocol: SpeedtestProtocol;
  apiKey?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  isGateway: boolean;
  customHeaders?: Record<string, string>;
}

/**
 * 模型天梯榜汇总指标
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface SpeedtestStatsItem {
  model: string;
  gatewayUrl: string;
  runCount: number;
  avgTtft: number;
  minTtft: number;
  avgSteadySpeed: number;
  maxSteadySpeed: number;
  avgChunkP50?: number;
  avgJitterRatio?: number | null;
}
