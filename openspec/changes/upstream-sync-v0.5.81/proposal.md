## Why

iRouter 内嵌的 9Router 网关基线源码基于上游 decolua/9router **v0.5.75**（commit `17c4cc76`）定制。上游已发布最新稳定版本 **v0.5.81**（commit `a8c9d380`，涵盖 100+ 个提交）。这一区间的重大改进直接影响 iRouter 的核心能力与连接稳定性：

- **OpenCode 免费模型防御体系完善**：官方上游针对近期 OpenCode Free Tier 激进的反爬与风控拦截，引入了完整的会话规范化映射、诱饵工具（decoy tools）伪装机制、强制流式传输防御以及历史思维链过滤；
- **Zed 原生鉴权与模型动态发现**：引入完整的 Zed 本地 HTTP Proxy 回调捕获、RSA-OAEP 握手解密、动态模型获取与 Zed 完成协议线支持；
- **思考模型展示（display）参数与协议增强**：支持上游思考展示控制参数，补齐各翻译器中针对 tool_result 图片块及 CommandCode 中断异常的处理；
- **流式中断标准错误帧与连接健康状态**：在流式异常中断时生成带内标准错误字节，同时在 accountFallback 中精细化区分客户端 4xx 请求与账号故障转移。

本项目在此次同步中推进至上游最新发布标签 `v0.5.81`，并继续保持全部专有定制（出站 DLP、请求重试/429 自定义锁定、思考强度主动钳制、桌面端纯净化与 9Remote 彻底隐藏等）。

## What Changes

- **以全量三方合并（git merge）上游 tag `v0.5.81`（commit `a8c9d380`）**：检出 `sync/v0.5.81` 分支，保留完整双亲历史，最后合并入 `main`；
- **解决 13 处交集冲突**：
  1. `public/i18n/literals/fa.json`：保留上游波斯语字典与本地有效键；
  2. `src/shared/components/Sidebar.js`：拒绝合入上游 9Remote / 9English 徽标与侧边栏入口，保持纯净；
  3. `open-sse/services/accountFallback.js`：合并请求级 4xx 错误不冷却机制，保留本地 `retryCfg`（支持关闭退避与自定义基础/最大冷却时长）；
  4. `open-sse/translator/concerns/thinkingUnified.js`：同时支持本地 `effortCap` 钳制与上游 `display` 参数；
  5. `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`：保留本地 `text-text-main` 样式并采用 `providerLabel`；
  6. `src/sse/services/auth.js`：采用 `slice(0, 200)` 并保留 `cooldownMs > 0` 判定与安全 `getSettings` 调用；
  7. `open-sse/utils/streamHandler.js`：保留上游 `abortMessage` 传递与本地 `transformStream` 即时结算；
  8. `open-sse/handlers/chatCore/streamingHandler.js`：同时保留 `estimateInputTokens` 与 `buildStreamErrorBytes`；
  9. `open-sse/executors/opencode-go.js`：规范化会话映射，兼容 `isMuseSparkModel` 与注册表模型查询；
  10. `open-sse/executors/opencode.js`：合并上游防风控机制（诱饵工具与会话生成），补全 Javadoc 注释；
  11. `tests/unit/opencode-go-muse-spark-responses.test.js`：对齐上游完整用例；
  12. `tests/unit/opencode-muse-spark-thinking.test.js`：更新测试用例断言；
  13. `tests/unit/opencode-session.test.js`：修复闭合块与作用域重名问题。
- **遵循 ADR 0004 版本号解耦规范**：
  - 根目录 `package.json` 随基线推进至 `0.5.81`（作为 User-Agent / X-Msh-Version 向上游对齐的依据）；
  - 桌面端产品版本号在 `desktop/package.json` 维持 `0.2.10`；
  - `desktop/package.json` description、`CONTEXT.md`、`README.md` 的基线版本描述同步更新为 `v0.5.81`。
- **测试套件与门禁保障**：
  - 门禁 `verify-no-regression.mjs` 校验 0 regression；
  - `verify-providers.mjs`、`verify-alias.mjs`、`verify-oauth-urls.mjs` 快照逐字节比对通过；
  - 根目录 `npm run build` 前端与独立服务端成功构建；
  - 桌面端 `npm run smoke`、`npm run test:instance`、`npm run test:import` 全量通过。

## Capabilities

### New Capabilities
- `upstream-sync-v0.5.81`: 推进 9Router 网关基线至 `v0.5.81`，支持 Zed 原生鉴权模型发现、OpenCode 最新风控防御与 Responses 标准中断错误帧。

### Modified Capabilities
- `effort-cap-degrade`: 保持与上游 `thinkingUnified` display 属性兼容；
- `auto-retry`: 保持与上游请求级 4xx 账号免冷却机制兼容；
- `combo`: 跨 Provider / 跨模型组合轮换在单模型遇到 4xx 时继续尝试后续候选模型。

## Impact

- **冲突与本地定制**：13 处冲突均严格保留本地业务定制，无任何定制丢失；
- **外部依赖与驱动**：保持对 Node 26 内置 `node:sqlite` 的良好支持，Electron 运行时排除原生 better-sqlite3；
- **零中断升级**：数据表结构无破坏性变更，配置与连接无缝承接。
