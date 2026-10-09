## Why

iRouter 内嵌的 9Router 网关基线源码基于上游 decolua/9router **v0.5.95**（commit `a99cf572`）定制。上游已发布最新版本 **v0.5.99**（commit `ce4460ef`，涵盖 27 个提交与 163 个文件变更）。这一区间的演进显著增强了模型协议健壮性、细粒度密钥安全控制、以及主流与国内顶级供应商生态覆盖：

- **Per-API-Key 细粒度访问控制**：数据库 `apiKeys` 表扩展权限控制列，网关全部请求分发入口（Chat, Embeddings, STT, TTS, Images 等）和 `/v1/models` 端点统一接入 `keyAccess.js` 白名单校验，可在控制面板按 Key 细粒度限制可访问的 Combos 与具体模型；
- **AWS Bedrock 完整原生轻量接入与 AWS SSO 支持**：新增 `bedrock` 与 `bedrock-xai` 供应商，基于 Node.js 原生 `node:crypto` 手写 SigV4 签名器，零额外 SDK 依赖（仅在 SSO 模式下动态延迟加载可选依赖 `@aws-sdk/credential-providers`），提取共享的 `awsEventStream.js` 解码器；
- **国内 MiniMax Code (`mcode`) 专有渠道接入**：支持国内版与国际版 OAuth 授权、Token 自动刷新、额度查询与思维链（思考强度）支持；
- **Gemini 与 MCP 工具调用防 400 关键修复**：
  - 在 `normalizeGeminiContents` 中集中重命名 `functionResponse` 中的 `$ref` 键，彻底消除 OpenAPI/JSON Schema 工具返回导致的 `400 INVALID_ARGUMENT` 报错；
  - 修复工具参数字面名为 `properties` 时被误递归为 Schema 节点导致的 400 报错；
  - 针对外部客户端可能发送的重复 `tool_call_ids` 进行唯一化重写与映射；
- **GLM-5.3 强制思考保护与百万上下文矫正**：依据智谱最新规范标记 GLM-5.3 家族 `thinkingCanDisable: false`，杜绝传入 `disabled` 触发 400 错误码 1210；矫正 GLM-5.2/5.3 上下文窗口为 1M；
- **Responses API 协议与思考参数规范化**：Meta Muse 模型严格遵循 Responses API 规范，将思考参数正确嵌套在 `reasoning: { effort, summary }`，并在非流式客户端访问流式上游时正确执行 SSE 转 JSON；Kimi Code 适配 `/responses` 路由；
- **Cursor AgentService 增强**：将 `reasoning_effort` 传递给 AgentService Run，并拦截未成功结束的空轮次；
- **用量与缓存统计精确化**：Ollama 上报 `prompt_eval_cached_count` 为 `cached_tokens`；精确统计并持久化 Codex 图像模型 Token 消耗；
- **Antigravity 渠道模型同步**：全面支持 Claude Sonnet 5.5 / Opus 5.5；刷新模型目录至 Gemini 3.8 Flash (High/Med/Low)、3.6 Flash、3.1 Pro High，清理废弃的 3.5 模型；MITM 默认模型同步升级为 `gemini-3.8-flash-medium`；
- **桌面紧凑窗口排版自适应**：修复小窗下的 API Keys 折行对齐、Header 面包屑溢出与模型 Chip 排版。

本项目推进至上游基线 `v0.5.99`，严格遵守**坚决排除第四梯队内容**原则（彻底阻断 9Remote 外部推广外链，不引入 Docker 构建流水线），并 100% 保护本地专有定制（出站 DLP 脱敏、智能重试、思考强度主动钳制 `effortCap`、全用量留存等）。

## What Changes

- **全量三方合并上游 tag `v0.5.99`（commit `ce4460ef`）**：
  - 基于上游基线生成 `v0.5.99` 基线 commit `7fc77f63`，在 `sync/v0.5.99` 分支执行 `--no-ff` 三方合并；
  - 彻底阻断第四梯队内容：拒绝合入 9Remote 外部推广链接，保持侧边栏纯净；
  - 安装并对齐上游新增依赖（`enquirer` 及 optional `@aws-sdk/credential-providers`）。
- **精细融合 8 处交集冲突**：
  1. `open-sse/translator/concerns/thinkingUnified.js`：融合上游 Claude `minimal -> low` 映射与 Responses API `openai-responses` 嵌套处理，并全量叠加本地 `capped(...)` 思考强度主动钳制；
  2. `src/sse/handlers/chat.js`：在最前端融入 `validateKeyAccess` 细粒度鉴权，与本地 DLP 脱敏、智能重试机制无缝叠加；在嵌套 Combo 路径接入 `filterAdapterModels`；
  3. `package.json`：基线版本推进至 `0.5.99`，保留本地 `embedded in iRouter` 描述与 Bun/Tauri 脚本；
  4. `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`：引入 `KeyAccessControls` 模态弹窗，保留本地 `openSettingsSection`；
  5. `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/TtsExampleCard.js`：合入 selfhosted-tts placeholder，保留本地 `bg-surface-2` 主题规范；
  6. `src/shared/components/Header.js`：保留 Header 面包屑小窗自适应优化，坚决剔除 Donate 按钮；
  7. `src/shared/components/Sidebar.js`：坚决维持本地纯净侧边栏，拒绝合入 9Remote 推广链接与 Web 更新弹窗；
  8. `CHANGELOG.md`：保留本地未发布更新条目，合入上游 v0.5.99 变更记录（剔除 9Remote）。
- **遵循 ADR 0004 版本号解耦规范**：
  - 根目录 `package.json`：`0.5.99`；
  - 桌面端产品版本在 `desktop-tauri/package.json` 保持独立的 `0.4.0`；
  - 同步修正 `CONTEXT.md`、`README.md` 与 `README.zh-CN.md` 中残留的历史版本描述至 `0.4.0` 与基线 `v0.5.99`。
- **全量门禁与生产构建**：
  - Baseline 三重脚本 `verify-alias.mjs`（128 tokens）、`verify-oauth-urls.mjs`、`verify-providers.mjs`（93 个 Provider）逐字节通过；
  - 生产环境编译构建 `npm run build` 全量通过；
  - 桌面壳层守卫 `verify:guard` 9/9 通过，更新器契约 `verify:updater-shim` 18/18 通过。

## Capabilities

### New Capabilities
- `key-access-control`: 引入 Per-API-Key 细粒度访问控制，支持在面板可视化限制密钥所能访问的 Combo 和 Model；
- `aws-bedrock`: 增加 Amazon Bedrock 原生轻量接入与 AWS SSO 支持；
- `minimax-code`: 增加 MiniMax Code (`mcode`) 积分供应商生态；
- `gemini-ref-sanitize`: 净化 MCP 工具响应中的 `$ref`，根治 Gemini 400 崩溃；
- `glm-5.3-protection`: 标记 GLM-5.3 强制思考，矫正 1M 上下文；
- `antigravity-catalog-refresh`: Antigravity 渠道支持 Claude 5.5，刷新 Gemini 3.8/3.6 主流生态。

### Modified Capabilities
- `effort-cap-degrade`: 将思考强度主动钳制平滑扩展至 Responses API (`openai-responses`)，持续保护所有上游接口；
- `chat-pipeline`: 请求主管道完成 Key 鉴权、DLP 脱敏、重试策略的三重安全与容灾协同。

## Impact
- **第四梯队零污染**：工作区未引入任何 9Remote 商业推广；
- **本地专有定制 100% 保留**：DLP 脱敏、自动重试、思考强度主动钳制等专有特性完整平移；
- **数据库向前兼容**：`SCHEMA_VERSION = 2` 自动平滑升级，所有存量密钥默认不受限运行。
