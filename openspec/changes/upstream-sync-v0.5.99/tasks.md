# Tasks: 上游基线同步至 v0.5.99

## 阶段 1：基线抓取与分支准备
- [x] 配置 upstream 远端并抓取最新标签（tag `v0.5.99` 指向 `ce4460ef`）
- [x] 生成承接前序基线父子关系的 `v0.5.99` 基线 commit `7fc77f63`
- [x] 检出专有同步工作分支 `sync/v0.5.99`

## 阶段 2：三方合并与冲突解决
- [x] 执行 `git merge --no-ff 7fc77f63`
- [x] 坚决阻断第四梯队内容（侧边栏彻底剔除 9Remote 推广链接，不合入 Donate 按钮）
- [x] 解决全部 8 处交集冲突并精细审查：
  - [x] `open-sse/translator/concerns/thinkingUnified.js`：融合上游 Claude `minimal -> low` 与 Responses 嵌套思考，叠加本地 `capped(...)` 思考强度主动钳制
  - [x] `src/sse/handlers/chat.js`：保留本地 DLP 脱敏、智能重试与 effort-aware 路由，合入上游 `validateKeyAccess` 细粒度鉴权
  - [x] `package.json`：基线版本推进至 `0.5.99`，保留本地 `embedded in iRouter` 项目描述与 Bun 启动脚本
  - [x] `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`：合入 `KeyAccessControls` 模态弹窗，保留本地 `openSettingsSection`
  - [x] `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/TtsExampleCard.js`：合入 selfhosted-tts placeholder，保持本地 `bg-surface-2` 规范
  - [x] `src/shared/components/Header.js`：保留 Header 面包屑窄屏自适应优化，坚决剔除 Donate 按钮
  - [x] `src/shared/components/Sidebar.js`：维持本地纯净侧栏，拒绝合入 9Remote 外部推广与 Web 更新弹窗
  - [x] `CHANGELOG.md`：保留本地未发布记录，合入上游 v0.5.99 变更记录（剔除 9Remote）
- [x] 对齐版本规范与元信息解耦（ADR 0004）：
  - [x] 根目录 `package.json`：`0.5.99`
  - [x] `desktop-tauri/package.json`：产品版本保持 `0.4.0`
  - [x] `CONTEXT.md`：基线号升级至 `v0.5.99`，产品版本号纠正为 `0.4.0`
  - [x] `README.md` 与 `README.zh-CN.md`：基线号升级至 `v0.5.99`，安装包产物版本对齐为 `0.4.0`
- [x] 严格遵守文件操作约束：无任何未授权的 `AGENTS.md` / `CLAUDE.md` 变更

## 阶段 3：回归门禁与快照对齐
- [x] 执行 Baseline 快照验证脚本：
  - [x] `node tests/__baseline__/verify-alias.mjs`（128 tokens 逐字节通过）
  - [x] `node tests/__baseline__/verify-oauth-urls.mjs`（OAuth URLs 逐字节通过）
  - [x] `node tests/__baseline__/verify-providers.mjs`（93 个 Provider 逐字节通过）

## 阶段 4：构建与全量验证
- [x] 执行 `npm run build` 验证全部页面打包与 standalone 资源拷贝通过
- [x] 验证桌面壳层契约（`verify:guard` 9/9 PASS，`verify:updater-shim` 18/18 PASS）

## 阶段 5：变更归档与分支合并
- [x] 在 `openspec/changes/upstream-sync-v0.5.99/` 下归档 `proposal.md`、`design.md`、`tasks.md`
- [ ] 提交主合并 Commit
- [ ] 将已完全验证的 `sync/v0.5.99` 分支合并回 `main`
