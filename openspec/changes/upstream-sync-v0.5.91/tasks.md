# Tasks: 上游基线同步至 v0.5.91

## 阶段 1：基线抓取与分支准备
- [x] 配置 upstream 远端并抓取最新标签（tag `v0.5.91` 指向 `f01fb909`）
- [x] 生成承接前序基线父子关系的 `v0.5.91` 基线 commit `0b6b42c5`
- [x] 检出专有同步工作分支 `sync/v0.5.91`

## 阶段 2：三方合并与冲突解决
- [x] 执行 `git merge --no-ff 0b6b42c5`
- [x] 坚决阻断第四梯队内容（侧边栏彻底剔除 9Remote 推广与组件，排除 Docker 流水线）
- [x] 解决全部 8 处交集冲突并精细审查：
  - [x] `open-sse/executors/default.js`：保留本地会话管理导入，合入 Claude session ID 提取工具
  - [x] `open-sse/executors/opencode-go.js`：保留本地会话规范化转换，采用上游重构的 `isResponsesModel` 与正则分发
  - [x] `open-sse/handlers/chatCore/nonStreamingHandler.js`：保留本地详细日志追踪，合入上游 `upstreamResponseHeaders` 透传
  - [x] `open-sse/providers/capabilities.js`：融合上游 `resolveCaps` 机制，完整保留本地 Combo 成员对象格式兼容与空白字符过滤
  - [x] `open-sse/translator/concerns/thinkingUnified.js`：融合上游 max 档位降级防护与本地 `capped(...)` 思考强度主动钳制
  - [x] `package.json`：基线版本推进至 `0.5.91`，保留本地 `embedded in iRouter` 项目元描述
  - [x] `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`：合入 Claude 限流重置标题并保持本地 `text-text-main` 规范
  - [x] `src/shared/components/Sidebar.js`：仅引入 `useSettingsStore`，坚决剔除 `NineRemotePromoModal` 等商业推广
- [x] 对齐版本规范与元信息解耦（ADR 0004）：
  - [x] 根目录 `package.json`：`0.5.91`
  - [x] `desktop/package.json`：产品版本保持 `0.3.1`，基线描述升级至 `v0.5.91`
  - [x] `CONTEXT.md`：基线号升级至 `v0.5.91`
  - [x] `README.md` 与 `README.zh-CN.md`：基线描述升级至 `v0.5.91`
- [x] 严格遵守文件操作约束：unstage `CLAUDE.md`，避免直接提交

## 阶段 3：回归门禁与快照对齐
- [x] 执行 Baseline 快照验证脚本：
  - [x] `node tests/__baseline__/verify-alias.mjs`（117 tokens 逐字节通过）
  - [x] `node tests/__baseline__/verify-oauth-urls.mjs`（OAuth URLs 逐字节通过）
  - [x] `node tests/__baseline__/verify-providers.mjs`（对齐 Codex CLI 0.155.0 快照，88 个 Provider 逐字节通过）

## 阶段 4：构建与全量验证
- [x] 执行 `npm run build` 验证全部页面打包与 standalone 资源拷贝

## 阶段 5：变更归档与分支合并
- [x] 在 `openspec/changes/upstream-sync-v0.5.91/` 下归档 `proposal.md`、`design.md`、`tasks.md`
- [x] 提交主合并 Commit
- [x] 将已完全验证的 `sync/v0.5.91` 分支合并回 `main`
