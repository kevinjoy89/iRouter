## Context

- 上游容错已有三层：账号回退（429 → 指数退避 model-lock + 换连接）、combo 成员回退（换下个成员）、思考强度降级（effort-cap，前一个变更）。缺口：全部成员限流时直接 503 交给客户端，Agent 停摆。
- 参考实现 llm-retry-proxy 的重试语义：状态码白名单（503,502,504,524,529,429）、429 专用间隔 + Retry-After 优先 + 指数退避 + ±20% 抖动、MAX_RETRIES（0=无限）、仅首字节前重试、耗尽回 503、`X-Forward-Attempts` 头。
- 客户端事实：Claude Code 对 429 有自动重试，对 503 直接放弃（报"模型不存在"）。

## Goals / Non-Goals

**Goals:**

- 全员限流时网关持住请求、按策略等待后整组重试，Agent 不停摆
- 成员级原地重试可配置（默认关）；与既有账号/成员回退语义兼容
- 客户端断开立即终止所有等待与重试；累计等待预算防呆

**Non-Goals:**

- 不做竞速/对冲模式（HEDGE race/stagger）——自用单机无此压力
- 不做非 chat 模态（image/tts/search/fetch combo）——机制可复制，后续按需
- 不加 `X-Forward-Attempts` 调试头（需重建响应流，日志已覆盖）
- 不区分 429/非429 双基数间隔（单一 `intervalSeconds`，刻意简化）

## Decisions

1. **两层重试、各自可配**：整体重试（请求级，`maxRetries`，默认 20、0=无限）包在 `handleChat` 最外层（`withAutoRetry`，`handleChat` 拆为 wrapper + `handleChatOnce`）；成员级重试（`memberRetries`，默认 0=关）在 `handleComboChat` 循环内、思考强度降级重试之后。两级共享同一 `retryState.waitedMs` 累计等待预算。
2. **触发条件**：状态码白名单（默认 429,500,502,503,504,529，可配）∪ 文本规则（固定启用：`rate limit|too many requests|capacity|overloaded`，仅对 ≥400 生效，与上游 ERROR_RULES 同源）。
3. **等待时长**：`max(Retry-After 封顶值, 指数退避值) × (0.8~1.2 抖动)`；`retryAfterMaxSeconds` 默认 120 封顶（防止异常巨大的 Retry-After 把请求吊死）；`backoffMaxSeconds` 默认 60。
4. **耗尽行为**：原样返回最后一个错误（含 Retry-After 头），不包 503——Claude Code 对 429 自带重试，等于客户端侧第二道防线。
5. **客户端断开**：`request.signal` 贯穿两级重试；成员级等待中断且 signal 已 abort 时**终止整条回退**（继续换成员只是白烧配额）；预算耗尽则保持换下家语义。
6. **预算**：`totalWaitBudgetSeconds`（默认 600，0=不限）为单请求累计等待上限，超限按耗尽处理；仅计实际完成的等待。
7. **流安全**：可重试错误（429/5xx）都是流开始前的拒绝；一旦返回 2xx 响应即不再重试（与参考实现一致）。
8. **修正项**：combo 的 retryAfter 追踪从 body 字段改为读 `Retry-After` 响应头（原字段恒为 null，最终响应从未带过 Retry-After）。

## Risks / Trade-offs

- 持住请求期间占用网关连接；预算 + 客户端断开兜底
- 整体重试重跑 combo 会推进 round-robin 轮转起点——重试天然换成员起步，可接受
- `handleChatOnce` 内层 combo 分支（嵌套 combo 名，罕见路径）没有成员级重试，仅有请求级兜底——文档注明

## Migration Plan

无数据迁移；`mergeWithDefaults` 兜底旧数据。升级 tag 时冲突面：combo.js / chat.js / settingsRepo + 新模块 autoRetry.js + 测试。

## Open Questions

- 多 Agent 并发时是否需要抖动之外的全局重试协调（避免同步重试雪崩）——当前单机自用不需要，观察后再说