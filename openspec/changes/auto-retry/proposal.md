## Why

组合模型的成员遇到 429（tpm/rpm 限流）等临时性错误时，上游既有机制（账号 model-lock → 换账号 → combo 换成员）会把请求换到别的成员继续；但当**全部成员都限流**时，网关直接向客户端返回 503，Claude Code 对 503 的反应是放弃并报"模型不存在"，Agent 整体停摆。真机日志（sensenova 双连接 429 → 全员穷尽 → 503）确认了这条路径。缺少的正是参考项目 llm-retry-proxy 的核心能力：等待后自动重来。

## What Changes

- 新增 `open-sse/services/autoRetry.js`：重试策略计算（状态码白名单 + 限流文本规则、Retry-After 封顶、指数退避 + ±20% 抖动、累计等待预算）与可中断等待原语（客户端断开即停）
- **整体重试（请求级）**：`chat.js` 外层包 `withAutoRetry`——整条回退链（账号 → 成员）穷尽且错误可重试时，等待后整组重来；耗尽后**原样返回最后一个错误**（429 + Retry-After 头），让具备自动重试的客户端（Claude Code 对 429）接手
- **成员级重试（可配置，默认关）**：`combo.js` 内成员遇可重试错误时原地等待重试同一成员 `memberRetries` 次才换下家；客户端断开则终止整条回退（不再白烧上游配额）
- 顺带修正：combo 的 retryAfter 追踪此前只读 body 字段（恒为 null），现改为读 `Retry-After` 响应头，最终 503/429 响应能带上正确的 Retry-After
- 配置：`settings.autoRetry`（enabled / statusCodes / maxRetries / memberRetries / intervalSeconds / backoff / backoffMaxSeconds / retryAfterMaxSeconds / totalWaitBudgetSeconds）+ Profile 页"路由策略"下方新增"重试策略"卡片
- 重试只发生在首字节之前（可重试错误均为流开始前的拒绝，天然安全）

## Capabilities

### New Capabilities

- `auto-retry`: 限流/过载错误的自动重试策略（整体 + 成员两级，详见 design.md）

### Modified Capabilities

<!-- 无 -->

## Impact

- 根目录源码：新增 1 个服务模块；修改 combo.js（成员级重试 + Retry-After 头解析）、chat.js（外层重试循环，`handleChat` 拆为 wrapper + `handleChatOnce`）、settingsRepo（默认值）
- 默认行为变化：**默认开启**整体重试（429/5xx，最多 20 次、单请求累计等待 ≤ 10 分钟）；成员级重试默认关闭（保持换下家语义）
- 不重试：2xx/3xx、普通 4xx（invalid field / 404 等，思考强度降级走 effort-cap 那套机制）