## Why

组合模型（combo）聚合多个供应商的同一模型（如多个供应商的 `deepseek-v4-flash`）时，不同供应商对思考强度（reasoning effort）的支持上限不同：有的支持到 `max`，有的只到 `xhigh`，有的只到 `high`。Agent 指定 `max` 后，请求一旦路由到上限不足的供应商即被拒（`fieldReasoningEffort invalid, should be one of: low,medium, high, xhigh`），combo 全体成员同样拒绝后整体失败，组合模型无法正常工作。上游没有"每供应商最大支持到哪一档"的用户可配项，能力表（capabilities.js 的 pattern 兜底）对 provider 是"盲"的。

## What Changes

- 根目录源码直接修改（基于上游 v0.5.69 定制，ADR 0003）：新增 `open-sse/services/effortCaps.js`（声明集合解析、钳制、降档步进、invalid-effort 错误匹配的纯函数）
- 主动钳制（proactive clamp）：`chat.js` 的 `handleSingleModelChat` 漏斗（单模型、combo 成员、fusion panel 的公共入口）发送前把请求档位钳进声明集合（模型后缀 `model(max)` 与 body 字段 `reasoning_effort` / `reasoning.effort` / `output_config.effort` / gemini thinkingLevel 均覆盖）
- 能力感知排序（effort-aware routing）：`combo.js` 新增 `reorderByEffortCap`，请求携带思考强度时把"声明上限不足"的成员稳定沉底、能原生支持的排前；复用既有 auto-switch 的排序先例（硬能力优先后排序）
- 反应式降档重试（reactive degrade retry）：`combo.js` 的 fallback 循环内，invalid-effort 类 400/422（窄匹配：文本提及 reasoning_effort/effort）触发同成员逐档下降重发（按声明集合跳档），降到集合下限仍失败则用**原始**请求试下一个成员；流开始后不重试（此类错误必发生在流开始前，天然安全）
- 配置：`settings.effortCaps`（`{ "provider/model": [档位升序数组] }`）与 `settings.effortAwareRoute`（全局默认开）+ 每 combo `comboStrategies[name].effortAwareRoute` 覆盖
- 面板 UI：Combo 页成员行加"最大思考强度"选择（声明 low..上限 的连续区间）与每 combo 的 Effort-aware 开关；Profile 页全局默认开关
- 测试：新增 `tests/unit/effort-caps.test.js` 与 `tests/unit/combo-effort.test.js`（32 用例）

## Capabilities

### New Capabilities

- `effort-cap`: 思考强度上限——声明、钳制、降级与能力感知路由（详见 design.md）

### Modified Capabilities

<!-- 无：openspec/specs/ 为空 -->

## Impact

- 9Router 源码（仓库根目录）：直接修改（基于 v0.5.69 定制，升级 = 对比上游手工合并；ADR 0003）
- settings JSON 新增两个键，无数据库迁移（settings 表整行 JSON）
- 行为变化仅在"声明了上限"时发生；未声明时全部路径与原先一致（no-op + 反应式重试兜底）
- 术语：CONTEXT.md 新增 组合模型/思考强度/思考强度上限/主动钳制/能力感知排序 词条