## 1. 上游约束决策

- [x] 1.1 ADR 0003 取代 ADR 0002 零改动条款：9Router 源码（基于上游 v0.5.69 定制，现位于仓库根目录）可直接修改（升级 = 对比上游手工合并）；CONTEXT.md 同步更新"定制基线"词条并新增 组合模型/思考强度上限/主动钳制/反应式降级重试/能力感知排序 术语；验证：docs/adr/0003-self-maintained-upstream.md 存在，CONTEXT.md 术语与其他文件一致

## 2. 核心逻辑

- [x] 2.1 新增 `open-sse/services/effortCaps.js`：`getDeclaredLevels`（声明集合解析，剥思考后缀）/ `clampLevel`（钳到集合边界）/ `resolveRequestedEffort`（后缀优先于 body 字段，识别 4 种 body 形状）/ `applyEffortToBody` / `nextLowerLevel`（按声明集合跳档）/ `isInvalidEffortError`（窄匹配 400/422）；验证：tests/unit/effort-caps.test.js 22 用例通过
- [x] 2.2 `combo.js`：`reorderByEffortCap` 稳定排序（未声明视为可支持）+ `handleComboChat` 在 auto-switch 后执行 effort 重排（effortAwareRoute 开关）+ 循环内 invalid-effort 触发 `degradeRetry`（structuredClone 每档重发，成功后直接返回，失败交回主流程）；验证：tests/unit/combo-effort.test.js 10 用例通过
- [x] 2.3 `chat.js`：`handleSingleModelChat` 漏斗钳制（后缀重写 or body 重写，EFFORT 日志）；`handleChat` 与内层 combo 分支把 `effortCaps` + `effortAwareRouteFor(settings, comboName)` 传入 handleComboChat（fusion 不传——重排不适用，漏斗钳制仍生效）；验证：`node --check` 通过、eslint 零告警

## 3. 配置与 UI

- [x] 3.1 `settingsRepo.js` 默认值：`effortCaps: {}`、`effortAwareRoute: true`；验证：mergeWithDefaults 语义正确（显式 false 不被默认值覆盖）
- [x] 3.2 Combo 页：卡片加 Effort-aware 开关（onSetStrategy 写 `comboStrategies[name].effortAwareRoute`，prune 逻辑适配）；编辑弹窗成员行加"最大思考强度" select（写 `settings.effortCaps`）；验证：页面可加载、开关与 select 读写正确
- [x] 3.3 Profile 页：全局 Effort-aware Routing 开关（写 `settings.effortAwareRoute`）；验证：fetch 路径与既有 updateComboStrategy 一致

## 4. 测试与验证

- [x] 4.1 新增单测：effort-caps 22 用例 + combo-effort 10 用例；验证：`./node_modules/.bin/vitest run unit/effort-caps.test.js unit/combo-effort.test.js` 32/32 通过
- [x] 4.2 既有回归：translator/thinking-unified.test.js（62）、unit/thinking-effort-openai-max-clamp.test.js（5）、unit/provider-thinking-config.test.js（1）全部通过；验证：combo.js 引入 effortCaps 依赖未破坏 thinkingUnified 模块图
- [x] 4.3 语法与 lint：改动的 4 个运行时文件 `node --check` 通过、eslint 零告警
- [ ] 4.4 真机冒烟（待办）：在 iRouter 面板组合一个 mixed-cap 组合（如 providerB 上限 xhigh、providerC 上限 high）后 `reasoning_effort: max` 请求应成功且日志出现 EFFORT clamp / effort-aware reorder——需真实供应商凭据，随日常使用验证