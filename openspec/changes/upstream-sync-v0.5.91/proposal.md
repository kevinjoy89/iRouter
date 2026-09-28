## Why

iRouter 内嵌的 9Router 网关基线源码基于上游 decolua/9router **v0.5.86**（commit `39e36d3d`）定制。上游已发布最新版本 **v0.5.91**（commit `f01fb909`，涵盖 38 个提交与 104 个文件变更）。这一区间的演进显著增强了模型协议兼容性、数据库大连接池性能、以及供应商生态覆盖：

- **OpenAI 格式客户端完整接收 Claude 思考文本**：在 `captureThinking` 中记录客户端的思考意图，若请求带有 `reasoning_effort`，自动向 Anthropic 注入 `display: "summarized"`，彻底解决 OpenCode、Cherry Studio、Chatbox 等客户端在开启思考时思考过程被脱敏丢弃的顽疾；
- **Responses API 流式终端携带完整输出与 `<think>` 标签泄漏修复**：在 `response.completed` 事件中补全完整的 `output` 数据项，解决 GitHub Copilot CLI 1.0.89+ 与官方 OpenAI SDK 抛出 `No response was returned` 报错；杜绝思考流向普通 content 泄漏 `<think>` 标签，确保 reasoning item 在 message/function_call 前闭合；
- **Gemini 多轮对话末尾卫语句**：在 `normalizeGeminiContents` 中，当上下文末尾为 `model` 角色或未完成的 `functionCall` 时自动补全虚拟 `user` 或 `functionResponse` 轮次，彻底杜绝 Google 400 Invalid Argument 报错；
- **Claude 工具名降级脱敏安全回退与限流头透传**：网络重连或重试导致 `toolNameMap` 丢失时自动剥离 `CLAUDE_TOOL_SUFFIX` 后缀，避免向客户端输出无法识别的 `_ide` 工具名；合并客户端自定义 `anthropic-beta` 并透传 `retry-after` 与 `anthropic-ratelimit-*` 响应头；从 `metadata.user_id` 自动提取 session ID；
- **大连接池 API Key 插入性能 O(1) 优化与防覆盖**：使用 SQL `SELECT MAX(priority)` 替代全表重排，消除上千 Key 导入时的锁库与慢响应，新增 `allowOverwrite` 保护；
- **用量统计 API Key 聚合桶隔离**：实时统计改为按完整 API Key 聚合，修复共享机器码前缀的团队 Key 相互覆盖破坏归属的缺陷；
- **新供应商与模型支持**：引入 Token Harbor 及 4 个聚合供应商（Dahl, Atria, Agnes, B.AI）；支持 Codex GPT-6 Sol 与 Luna（`responsesLite` 模式）；补齐 OpenCode Go 40 款模型目录与家族正则分发路由；提供 `cline-free/*` 0 元计费兜底。

本项目推进至上游基线 `v0.5.91`，严格遵守用户要求**坚决排除第四梯队内容**（彻底杜绝 9Remote / 9English 商业推广入口与徽标、移除 Docker 构建流水线），并完整保护本地专有定制（出站 DLP、请求重试、思考强度主动钳制 `effortCap`、Combo 容灾不中断与对象格式兼容等）。

## What Changes

- **全量三方合并上游 tag `v0.5.91`（commit `f01fb909`）**：
  - 基于上游基线生成 `v0.5.91` 基线 commit `0b6b42c5`，在 `sync/v0.5.91` 分支执行 `--no-ff` 三方合并；
  - 彻底清理第四梯队内容：拒绝合入 9Remote / 9English 推广，保持工作区纯净。
- **解决 8 处交集冲突并精细融合**：
  1. `open-sse/executors/default.js`：保留本地会话管理导入，合入 Claude session ID 提取工具；
  2. `open-sse/executors/opencode-go.js`：保留本地会话规范化转换，采用上游重构的 `isResponsesModel` 与正则分发；
  3. `open-sse/handlers/chatCore/nonStreamingHandler.js`：保留本地详细日志追踪，合入上游 `upstreamResponseHeaders` 透传；
  4. `open-sse/providers/capabilities.js`：融合上游 `resolveCaps` 能力覆盖参数，完整保留本地 Combo 成员对象格式兼容与空白字符过滤；
  5. `open-sse/translator/concerns/thinkingUnified.js`：融合上游 `supportedLevels` 不包含 `"max"` 时自动降级为 `"high"` 的防护，与本地 `capped(...)` 思考强度主动钳制叠加；
  6. `package.json`：基线版本推进至 `0.5.91`，保留本地 `embedded in iRouter` 项目元描述；
  7. `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`：合入 Claude 限流重置标题并保持本地 `text-text-main` 颜色规范；
  8. `src/shared/components/Sidebar.js`：仅引入 `useSettingsStore` 优化，坚决剔除 `NineRemotePromoModal` 等第四梯队推广组件。
- **遵循 ADR 0004 版本号解耦规范**：
  - 根目录 `package.json` 升级至 `0.5.91`；
  - 桌面端产品版本在 `desktop/package.json` 保持独立的 `0.3.1`，基线描述升级至 `v0.5.91`；
  - 同步更新 `CONTEXT.md`、`README.md` 与 `README.zh-CN.md`。
- **全量门禁与生产构建**：
  - Baseline 三重脚本 `verify-alias.mjs`、`verify-oauth-urls.mjs`、`verify-providers.mjs`（Codex CLI 0.155.0 快照对齐）逐字节通过；
  - 生产环境编译构建 `npm run build` 全量通过。

## Capabilities

### New Capabilities
- `upstream-sync-v0.5.91`: 推进 9Router 网关基线至 `v0.5.91`，获得 OpenAI 客户端 Claude 思考完整返回、Responses API 终态输出、Gemini 末尾轮次卫语句、Provider O(1) 插入、Zed 凭证自动导入、Claude 限流免费重置、以及 GPT-6 Sol/Luna 等核心能力。

### Modified Capabilities
- `effort-cap-degrade`: 维持本地思考强度主动钳制在 Combo 和 DeepSeek/GLM 模型中的完整功能，并与上游 max 档位降级防护无缝融合；
- `combo`: 融合 `resolveCaps` 参数，由服务端能力精确矫正上下文窗口与最大输出限制，同时保持对对象成员 `{ model: "..." }` 的兼容。

## Impact

- **第四梯队零污染**：工作区未合入任何 9Remote / 9English 推广 UI、未引入 Docker 构建流水线；
- **本地专有定制 100% 保留**：DLP 脱敏、自动重试、思考强度主动钳制等专有特性完整平移；
- **平滑兼容**：数据库向前兼容，所有历史连接与 API Key 均可无缝承接。
