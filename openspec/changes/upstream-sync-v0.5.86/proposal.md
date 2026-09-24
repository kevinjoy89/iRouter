## Why

iRouter 内嵌的 9Router 网关基线源码基于上游 decolua/9router **v0.5.81**（commit `a8c9d380`）定制。上游已发布最新版本 **v0.5.86**（commit `39e36d3d`，涵盖 50+ 个提交与 20 个新增测试套件）。这一区间的重大改进直接增强了网关调度的鲁棒性与供应商生态适配：

- **OpenCode Free-Tier 强防风控指纹与响应处理**：上游通过引入 bash/glob/grep/read 四件套诱饵工具伪装机制，彻底规避了近期 OpenCode 免费池频繁出现的 403 FreeTierError，并适配了 1.3-Free 模型的 tool_choice 自动降级与历史加密推理内容过滤；
- **Qoder 403 限流识别与健康回退穿透**：修复 SSE 转 JSON 解析器在遇到 403 限流响应时的状态码丢弃缺陷，确保上游状态码原样穿透到网关调度层，触发供应商与账号维度的健康冷却与故障转移；
- **SystemOne 媒体网关接入与供应商扩展**：支持 SystemOne 多模态扩展、Kimchi 免登供应商与模型动态探测，升级 Claude CLI User-Agent 至 2.1.280；
- **Combo 动态上下文聚合与木桶原则**：提供 `aggregateComboCapabilities`，使得聚合模型对外提供更精准的上下文窗口（取最小值保守策略）和最大补全限制；
- **控制面板用量图表与国际化动态追踪**：用量看板支持 Tokens / Requests / Cost 三模式即时切换，优化响应式排版，国际化内核增加 `_translated` 与 `_originalText` 动态追踪避免 DOM 重复翻译。

本项目在此次同步中推进至上游基线 `v0.5.86`，同时严格执行用户要求**坚决排除第四梯队内容**（彻底杜绝 9Remote / 9English 商业推广入口与徽标、移除 Docker 构建发布流水线、剔除无关文档），并完整保护本地专有定制（出站 DLP、请求重试、思考强度主动钳制、Combo 容灾不中断等）。

## What Changes

- **全量三方合并（git merge）上游 tag `v0.5.86`（commit `39e36d3d`）**：
  - 基于上游基线生成 `v0.5.86` commit `f55afb924bf7`，创建 `sync/v0.5.86` 分支执行 `--no-ff` 合并；
  - 彻底清理第四梯队文件：删除 `.github/workflows/docker-publish.yml`、`DOCKER.md`、`Dockerfile`，恢复 `open-sse/AGENTS.md`。
- **解决 11 处交集冲突**：
  1. `open-sse/handlers/chatCore/sseToJsonHandler.js`：保留本地详细日志追踪，合并上游 `upstreamStatus` 状态码透传；
  2. `package.json`：基线版本升级至 `0.5.86`，保留本地项目元信息与打包指令；
  3. `public/i18n/literals/zh-CN.json`：合并两端词条，保留本地 MITM / 开机自启词条，合入小米 MiMo 桌面登录词条；
  4. `src/app/(dashboard)/dashboard/combos/page.js`：保留本地 `handleSetEffortCap`，合入上游 `handleBulkSetStrategy` 与 `aggregateComboCapabilities`；
  5. `src/app/(dashboard)/dashboard/usage/components/OverviewCards.js`：合并上游居中响应式排版，保留本地大数字格式化；
  6. `src/app/(dashboard)/dashboard/usage/components/UsageChart.js`：合并 Tokens / Requests / Cost 三模式切换，保留本地 `refreshKey`；
  7. `src/app/api/v1/models/route.js`：采用 `aggregateComboCapabilities` 聚合能力并挂载标准限制字段；
  8. `src/i18n/runtime.js`：保留本地属性监听与纯函数导出，合入动态追踪字段；
  9. `src/shared/components/Sidebar.js`：彻底排除 9Remote / 9English 推广与徽标，合入 systemone 媒体项；
  10. `src/shared/components/UsageStats.js`：适配 6 栏网格与本地 `surface-2` 样式；
  11. `README.md`：保持本地中英双语文档结构，对齐版本描述至 `v0.5.86`。
- **解决上游潜在缺陷与本地测试适配**：
  - `open-sse/providers/capabilities.js`：补齐 `MODEL_CAPABILITIES["glm-5.2"]` 的 `thinkingEffortSupported: true`；增强 `aggregateComboCapabilities` 支持对象成员与空白标识过滤；
  - 修复上游引入的 4 处 Tailwind v4 未定义类（规范为 `bg-surface-2` 与 `text-text-main`）；
  - 对齐 Claude CLI UA 2.1.280 快照与测试断言；
  - 适配 OpenCode Responses API 诱饵工具与 Responses 默认 `tool_choice: auto` 行为。
- **遵循 ADR 0004 版本号解耦规范**：
  - 根目录 `package.json` 升级至 `0.5.86`；
  - 桌面端产品版本在 `desktop/package.json` 保持 `0.3.0`，基线描述升级至 `v0.5.86`；
  - `CONTEXT.md` 同步更新。
- **全量门禁与生产构建**：
  - Baseline 三重脚本 `verify-alias.mjs`、`verify-oauth-urls.mjs`、`verify-providers.mjs` 逐字节通过；
  - 全量单元测试 `verify-no-regression.mjs` 0 regression；
  - `npm run build` 成功完成全量静态页面生成与独立服务端资源打包。

## Capabilities

### New Capabilities
- `upstream-sync-v0.5.86`: 推进 9Router 网关基线至 `v0.5.86`，获得 OpenCode 指纹防御、Qoder 403 穿透、SystemOne 媒体接入、Kimchi 供应商、以及 Usage 三模式用量图表等核心能力。

### Modified Capabilities
- `effort-cap-degrade`: 维持本地思考强度主动钳制在 Combo 和模型列表中的完整功能，并修复 GLM-5.2 思考档位识别；
- `combo`: 采用新版聚合能力算法，保守计算 Combo 上下文窗口与最大输出限制。

## Impact

- **第四梯队零污染**：工作区中未合入任何 9Remote / 9English 推广 UI、未引入 Docker 构建流水线；
- **本地专有定制 100% 保留**：DLP 脱敏、自动重试、思考强度主动钳制等专有特性完整平移；
- **平滑升级**：数据表结构向前兼容，现有配置与连接无缝承接。
