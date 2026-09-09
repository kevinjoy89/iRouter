// 自动重试（auto-retry，自维护特性 ADR 0003）：
// 请求级（整条回退链穷尽后等待、整组重来）与成员级（成员限流原地等待重试）共享
// 的策略计算与等待原语。语义对齐参考实现 llm-retry-proxy：状态码白名单 + 文本规则、
// Retry-After 优先（封顶可配）、指数退避 + ±20% 抖动、仅在首字节前重试（调用方保证）、
// 客户端断开立即停止、累计等待预算防呆。
// 刻意简化：间隔基数只有 intervalSeconds 一个，不区分 429/非429 双基数（自用场景）。

// settings.autoRetry 的完整形态与默认值（UI 与运行时共用）
export const DEFAULT_AUTO_RETRY = {
  enabled: true,
  statusCodes: [429, 500, 502, 503, 504, 529],
  maxRetries: 20,            // 请求级整体重试上限；0 = 无限
  memberRetries: 0,          // 成员级等待重试次数；0 = 关（保持换下家语义）
  intervalSeconds: 5,        // 基础间隔
  backoff: true,             // 指数退避（base * 2^attempt，封顶 backoffMaxSeconds）
  backoffMaxSeconds: 60,
  retryAfterMaxSeconds: 120, // 上游 Retry-After 封顶；0 = 不封顶
  totalWaitBudgetSeconds: 600, // 单请求累计等待预算；0 = 不限
};

const NUMERIC_KEYS = ["maxRetries", "memberRetries", "intervalSeconds", "backoffMaxSeconds", "retryAfterMaxSeconds", "totalWaitBudgetSeconds"];

// 归一化 settings.autoRetry：缺省补默认、类型纠偏（用户手编 JSON / 旧数据兜底）
export function resolveAutoRetry(settings) {
  const raw = settings?.autoRetry && typeof settings.autoRetry === "object" ? settings.autoRetry : {};
  const cfg = { ...DEFAULT_AUTO_RETRY, ...raw };
  cfg.enabled = cfg.enabled !== false;
  cfg.statusCodes = Array.isArray(cfg.statusCodes) && cfg.statusCodes.length > 0
    ? cfg.statusCodes.map(Number).filter(Number.isFinite)
    : [...DEFAULT_AUTO_RETRY.statusCodes];
  for (const k of NUMERIC_KEYS) {
    const n = Number(cfg[k]);
    cfg[k] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_AUTO_RETRY[k];
  }
  cfg.intervalSeconds = cfg.intervalSeconds || DEFAULT_AUTO_RETRY.intervalSeconds;
  cfg.backoff = cfg.backoff !== false;
  return cfg;
}

// 文本规则（固定启用，不可配）：与上游 ERROR_RULES 同源语义，只放宽不误伤——
// 调用方保证仅对 >=400 的状态调用。
export function isRetryableErrorText(text) {
  return /rate limit|too many requests|capacity|overloaded/i.test(String(text ?? ""));
}

export function isRetryable(status, errorText, cfg) {
  if (!cfg?.enabled) return false;
  if (!Number.isFinite(status) || status < 400) return false;
  return cfg.statusCodes.includes(status) || isRetryableErrorText(errorText);
}

// 等待时长：max(Retry-After 封顶值, 指数退避值) × ±20% 抖动。
// `jitter` 可注入（测试），取值 [0,1)。
export function computeWaitMs(cfg, attempt, retryAfterMs = null, jitter = Math.random) {
  const backoffMs = cfg.backoff
    ? Math.min(cfg.intervalSeconds * 1000 * 2 ** Math.max(attempt, 0), cfg.backoffMaxSeconds * 1000)
    : cfg.intervalSeconds * 1000;
  const capMs = cfg.retryAfterMaxSeconds > 0 ? cfg.retryAfterMaxSeconds * 1000 : Infinity;
  const raMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, capMs) : 0;
  return Math.round(Math.max(raMs, backoffMs) * (0.8 + 0.4 * jitter()));
}

// HTTP Retry-After 头（秒数或 HTTP 日期）→ 毫秒；无法解析返回 null
export function parseRetryAfterHeader(value, now = Date.now()) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(t - now, 0) : null;
}

// 可中断睡眠：正常睡满返回 true；signal 中止提前返回 false
export function sleepWithAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener?.("abort", onAbort);
  });
}

// 等待前置检查 + 睡眠：预算超限或客户端断开 → false（调用方放弃重试）。
// retryState.waitedMs 累计实际等待（跨请求级/成员级共享同一对象）。
export async function waitBeforeRetry({ cfg, attempt, retryAfterMs = null, retryState, signal, log, label = "RETRY" }) {
  const waitMs = computeWaitMs(cfg, attempt, retryAfterMs);
  const budgetMs = cfg.totalWaitBudgetSeconds > 0 ? cfg.totalWaitBudgetSeconds * 1000 : Infinity;
  const spent = retryState?.waitedMs || 0;
  if (spent + waitMs > budgetMs) {
    log?.warn?.(label, `wait ${Math.round(waitMs / 1000)}s exceeds total wait budget (${Math.round(spent / 1000)}s spent), giving up`);
    return false;
  }
  log?.info?.(label, `waiting ${(waitMs / 1000).toFixed(1)}s before retry (attempt ${attempt + 1})`);
  const completed = await sleepWithAbort(waitMs, signal);
  if (!completed) {
    log?.info?.(label, "client disconnected during retry wait, stopping");
    return false;
  }
  if (retryState) retryState.waitedMs += waitMs;
  return true;
}

// 请求级整体重试循环：fn 返回 Response；可重试错误 → 等待 → 重跑 fn。
// res 原样返回（耗尽/不可重试/断开时），不做任何包装——429 + Retry-After 原样透传，
// 让具备自动重试能力的客户端（如 Claude Code 对 429）接手第二道防线。
export async function withAutoRetry(fn, cfg, { signal, retryState, log, label = "RETRY" } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fn();
    if (!res || res.status < 400) return res;

    // 状态码命中白名单时无需读 body；未命中才窥探文本规则（clone 不动原响应）
    let errorText = "";
    if (!cfg.statusCodes.includes(res.status)) {
      try {
        const peek = await res.clone().json();
        errorText = peek?.error?.message || peek?.error || peek?.message || "";
      } catch { /* 非 JSON body → 无文本规则可 match */ }
    }
    const retryAfterMs = parseRetryAfterHeader(res.headers?.get?.("retry-after"));
    if (!isRetryable(res.status, errorText, cfg)) return res;
    if (cfg.maxRetries > 0 && attempt >= cfg.maxRetries) {
      log?.warn?.(label, `maxRetries=${cfg.maxRetries} exhausted on status ${res.status}, returning to client`);
      return res;
    }
    const proceed = await waitBeforeRetry({ cfg, attempt, retryAfterMs, retryState, signal, log, label });
    if (!proceed) return res;
    log?.info?.(label, `retrying after status ${res.status} (attempt ${attempt + 1})`);
  }
}