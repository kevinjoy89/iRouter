# Tasks: 上游基线同步至 v0.5.81

## 阶段 1：分支准备与上游抓取
- [x] 确认当前工作分支干净并记录当前 HEAD（`b374edbd`）
- [x] 检出专有同步分支 `sync/v0.5.81`
- [x] 从上游仓库 `https://github.com/decolua/9router.git` 获取最新变更与 tag
- [x] 确认目标 tag `v0.5.81` 指向 commit `a8c9d380`

## 阶段 2：三方合并与冲突解决
- [x] 执行 `git merge --no-ff a8c9d380`
- [x] 解决 13 处交集冲突并逐个审查：
  - [x] `public/i18n/literals/fa.json`：保留波斯语字典与本地键
  - [x] `src/shared/components/Sidebar.js`：拒绝上游商业入口，保持 9Remote 隐藏
  - [x] `open-sse/services/accountFallback.js`：合并请求级 4xx 免冷却与本地 `retryCfg`
  - [x] `open-sse/translator/concerns/thinkingUnified.js`：同时支持 `effortCap` 钳制与 `display` 参数
  - [x] `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`：保留本地配色与标签
  - [x] `src/sse/services/auth.js`：合并 `slice(0, 200)` 与本地连接健康度判定
  - [x] `open-sse/utils/streamHandler.js`：合并上游 `abortMessage` 与本地即时 Token 结算
  - [x] `open-sse/handlers/chatCore/streamingHandler.js`：保留 Token 估算与带内错误字节构建
  - [x] `open-sse/executors/opencode-go.js`：支持规范会话与 Responses 模型中转
  - [x] `open-sse/executors/opencode.js`：合并诱饵工具防风控与中文 Javadoc 注释
  - [x] `tests/unit/opencode-go-muse-spark-responses.test.js`：对齐上游测试
  - [x] `tests/unit/opencode-muse-spark-thinking.test.js`：更新思维链断言
  - [x] `tests/unit/opencode-session.test.js`：修复闭合块与语法
- [x] 提交合并 Commit（`4ec31388`）

## 阶段 3：版本描述与基线解耦对齐
- [x] 按照 ADR 0004 规范校验各文件版本号：
  - [x] 根目录 `package.json`：`0.5.81`
  - [x] `desktop/package.json`：`0.2.10`（description 升级至 v0.5.81）
  - [x] `CONTEXT.md` & `README.md`：基线更新为 `v0.5.81`
- [x] 提交文档更新 Commit（`76954295`）

## 阶段 4：回归门禁与专项修复
- [x] 执行快照验证脚本：
  - [x] `node __baseline__/verify-providers.mjs` (81 providers)
  - [x] `node __baseline__/verify-alias.mjs` (117 tokens)
  - [x] `node __baseline__/verify-oauth-urls.mjs`
- [x] 运行核心受改动影响的单元测试（Zed、OpenCode、Kiro、Combo、DLP 等）
- [x] 修复上游同步暴露的回归与测试断言：
  - [x] `open-sse/executors/opencode-go.js`：支持 `isMuseSparkModel` 动态识别
  - [x] `open-sse/services/combo.js`：允许 Combo 轮换在单成员 4xx 时继续 fallback
  - [x] `src/sse/services/auth.js`：安全调用 `getSettings`
  - [x] 单元测试适配：更新 CommandCode、图片块及已修复 bug 的断言
- [x] 提交测试与回归修复 Commit（`332db736`）
- [x] 运行 `verify-no-regression.mjs` 门禁，确认 0 regression

## 阶段 5：构建与端到端验证
- [x] 根目录执行 `npm run build`，成功编译 136 个页面并拷贝 standalone 资产
- [x] `desktop` 目录执行 `npm run build-server` 组装网关产物
- [x] 运行桌面端冒烟测试 `npm run smoke`（100% PASS）
- [x] 运行桌面单实例测试 `npm run test:instance`（5/5 PASS）
- [x] 运行桌面导入测试 `npm run test:import`（15/15 PASS）

## 阶段 6：变更归档与分支合并
- [x] 在 `openspec/changes/upstream-sync-v0.5.81/` 下归档 `proposal.md`、`design.md`、`tasks.md`
- [ ] 将已完全验证的 `sync/v0.5.81` 分支合并回 `main`
