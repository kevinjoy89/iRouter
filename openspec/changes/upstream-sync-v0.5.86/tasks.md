# Tasks: 上游基线同步至 v0.5.86

## 阶段 1：基线抓取与分支准备
- [x] 配置 upstream 远端并抓取最新标签（tag `v0.5.86` 指向 `39e36d3d`）
- [x] 生成承接前序基线父子关系的 `v0.5.86` 基线 commit `f55afb924bf7`
- [x] 检出专有同步工作分支 `sync/v0.5.86`

## 阶段 2：三方合并与冲突解决
- [x] 执行 `git merge --no-ff f55afb92`
- [x] 坚决阻断第四梯队文件（移除 Dockerfile、`DOCKER.md`、`docker-publish.yml`，恢复 `open-sse/AGENTS.md`）
- [x] 解决全部 11 处交集冲突并审查：
  - [x] `open-sse/handlers/chatCore/sseToJsonHandler.js`：保留本地详细追踪日志，合入 `upstreamStatus` 状态码透传
  - [x] `package.json`：基线版本推进至 `0.5.86`，保留本地项目元信息与脚本
  - [x] `public/i18n/literals/zh-CN.json`：合并词条，保留本地 MITM 词条，合入 MiMo 桌面登录词条
  - [x] `src/app/(dashboard)/dashboard/combos/page.js`：保留本地 `handleSetEffortCap`，合入 `handleBulkSetStrategy`
  - [x] `src/app/(dashboard)/dashboard/usage/components/OverviewCards.js`：合入上游居中排版，保留本地大数字格式化
  - [x] `src/app/(dashboard)/dashboard/usage/components/UsageChart.js`：合入 Tokens / Requests / Cost 三模式切换，保留 `refreshKey`
  - [x] `src/app/api/v1/models/route.js`：采用 `aggregateComboCapabilities` 聚合能力并挂载标准限制字段
  - [x] `src/i18n/runtime.js`：保留属性监听与纯函数导出，合入 `_translated` 与 `_originalText` 动态追踪
  - [x] `src/shared/components/Sidebar.js`：彻底移除 9Remote / 9English 推广与徽标，合入 systemone 媒体项
  - [x] `src/shared/components/UsageStats.js`：适配 6 栏网格与本地 `surface-2` 样式
  - [x] `README.md`：保持本地中英双语文档，更新基线版本描述至 `v0.5.86`
- [x] 提交主合并 Commit `19a24776`

## 阶段 3：版本规范与元信息解耦
- [x] 按照 ADR 0004 规范校验各文件版本号：
  - [x] 根目录 `package.json`：`0.5.86`
  - [x] `desktop/package.json`：产品版本保持 `0.3.0`，基线描述升级至 `v0.5.86`
  - [x] `desktop/package-lock.json`：顶层版本统一为 `0.3.0`
  - [x] `CONTEXT.md`：更新基线号至 `v0.5.86`

## 阶段 4：回归门禁与专项修复
- [x] 执行快照验证脚本：
  - [x] `node tests/__baseline__/verify-alias.mjs`（117 tokens 逐字节通过）
  - [x] `node tests/__baseline__/verify-oauth-urls.mjs`（OAuth URLs 逐字节通过）
  - [x] `node tests/__baseline__/verify-providers.mjs`（83 个 Provider 快照逐字节通过）
- [x] 修复上游同步暴露的回归与测试断言：
  - [x] `open-sse/providers/capabilities.js`：补齐 `MODEL_CAPABILITIES["glm-5.2"]` 的 `thinkingEffortSupported: true`
  - [x] `open-sse/providers/capabilities.js`：增强 `aggregateComboCapabilities` 兼容对象成员与空白标识过滤
  - [x] 修复 GenericCliToolCard、ProviderBarChart、TopModelsChart、XiaomiMimoAuthModal 中 4 处未定义颜色类
  - [x] 对齐 Claude CLI UA 2.1.280 快照与测试断言
  - [x] 适配 OpenCode 指纹诱饵工具注入与 Responses 缺省 `tool_choice: auto` 行为
  - [x] 纠正 `tests/unit/kimchi.test.js` 中 category 断言为 `freeTier`
- [x] 提交测试与兼容修复 Commit `7197add1`
- [x] 运行全量单元测试与回归门禁：`node tests/__baseline__/verify-no-regression.mjs results.json`（0 regression，2933+ 测试通过）

## 阶段 5：构建与全量验证
- [x] 根目录执行 `npm run build`，成功编译 145 个页面并拷贝 standalone 生产资源

## 阶段 6：变更归档与分支合并
- [x] 在 `openspec/changes/upstream-sync-v0.5.86/` 下归档 `proposal.md`、`design.md`、`tasks.md`
- [ ] 将已完全验证的 `sync/v0.5.86` 分支合并回 `main`
