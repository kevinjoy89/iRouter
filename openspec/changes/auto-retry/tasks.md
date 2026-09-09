## 1. 策略模块

- [x] 1.1 新增 `open-sse/services/autoRetry.js`：`resolveAutoRetry`（归一化）/ `isRetryable`（状态码白名单 + 限流文本，仅 ≥400）/ `computeWaitMs`（max(Retry-After 封顶, 指数退避) × ±20% 抖动）/ `parseRetryAfterHeader` / `sleepWithAbort` / `waitBeforeRetry`（累计等待预算）/ `withAutoRetry`（请求级循环，耗尽原样返回最后错误）；验证：tests/unit/auto-retry.test.js 26 用例通过

## 2. 运行时挂载

- [x] 2.1 `chat.js`：`handleChat` 拆为外层 wrapper（`withAutoRetry` + request.signal + retryState）与 `handleChatOnce`；两个 combo 调用点传入 `autoRetry/retryState/signal`；验证：单测 withAutoRetry 6 场景 + 语法/eslint 通过
- [x] 2.2 `combo.js`：`handleComboChat` 新增 `autoRetry/retryState/signal` 选项与成员级等待重试块（memberRetries > 0 时启用；客户端断开终止整条回退、预算耗尽换下家）；顺带修正 retryAfter 追踪改读 `Retry-After` 响应头；验证：单测成员级 3 场景（重试同成员 / 0=换下家 / 断开终止）
- [x] 2.3 `settingsRepo.js`：DEFAULT_SETTINGS 增加 `autoRetry` 完整默认值；验证：resolveAutoRetry 归一化用例覆盖缺省/部分/非法值

## 3. UI

- [x] 3.1 Profile 页"Routing Strategy"卡片下方新增"Retry Strategy"卡片：总开关、Max Retries（0=∞）、Member Retries（0=关）、Interval、Exponential Backoff 开关、Backoff Max、Retry-After Cap、Total Wait Budget、Status Codes（逗号分隔）；验证：PATCH /api/settings 路径与既有设置一致，字段与 autoRetry.js DEFAULT 一致

## 4. 测试与验证

- [x] 4.1 全量回归：auto-retry 26 + combo-effort 10 + effort-caps 22 + effort-cap-wire 9 + thinking-unified 62 + max-clamp 5 + provider-thinking-config 1 = 135/135 通过；语法 + eslint 零告警
- [x] 4.2 真机修正（429 现场反馈）：关闭指数退避后等待仍被上游 Retry-After（~33s）接管——修正语义：退避开关 = 自适应等待总开关，关闭即严格固定间隔（不读 Retry-After、无抖动）；指数退避描述文案与 zh-CN/zh-TW 字典条目同步更新
- [ ] 4.3 真机冒烟（待办）：新包安装后，等 sensenova 429 场景复现，确认日志出现 `[RETRY] waiting ... before retry` 且 Agent 不再停摆；确认耗尽时客户端收到 429 + Retry-After