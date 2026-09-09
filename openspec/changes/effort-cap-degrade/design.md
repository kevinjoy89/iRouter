## Context

- 9Router 源码位于仓库根目录（基于上游 v0.5.69 定制，可直接修改）；思考强度归一化在 `thinkingUnified.js`，combo 路由在 `services/combo.js`，capabilities 表（`*deepseek-v4*` pattern 兜底）对 provider 是"盲"的——同一个模型名在所有未覆写供应商上采用同一格式与档位透传
- combo 已有能力感知自动切换（`reorderByCapabilities`，vision/pdf 等硬能力），但完全不看思考强度；fallback 循环对 unmatched 错误默认下沉到下个成员，但全体成员同样拒绝时整体失败
- 配置存 `settings` 表 JSON（`comboStrategies` 先例）；`updateSettings` 任意键合并，无需白名单改动

## Goals / Non-Goals

**Goals:**

- 请求思考强度超出供应商声明的上限时自动降级到上限，让组合模型在混合上限供应商之间正常工作
- 请求 `max` 时优先路由到能原生支持 `max` 的成员，尽量不降级
- 配置缺失/变化时仍能兜底（反应式降档重试），不把 400 直接抛给调用方
- 未声明上限时行为与原先完全一致（零回归面）

**Non-Goals:**

- 不做显式逐档映射表（requested→actual）；"声明接受集合 + 边界钳制"已覆盖连续与非连续集合
- 不做自动探测供应商上限（发送前未知能力靠反应式重试兜底）
- 不改 thinkingUnified 的既有 per-format 归一化（deepseek 格式的 xhigh→max 升档语义保留）
- UI 只提供连续区间（low..上限），稀疏集合（如只支持 high）走 settings JSON 直编

## Decisions

1. **配置形态：`settings.effortCaps`**：`{ "provider/model": ["low","medium","high","xhigh"] }`（升序数组）。键 = combo 成员字符串（剥离思考后缀）。声明是端点属性不是组合属性，全局生效（单模型请求同样钳制）。
2. **钳制位置：`handleSingleModelChat` 漏斗**（chat.js）：单模型、combo 成员、fusion panel 的公共入口，一处覆盖所有路径。钳制在 getModelInfo 之后、翻译管线之前；模型后缀经 `modelStr = "provider/model(clamped)"` 重写，body 字段经 `applyEffortToBody` 重写。
3. **排序机制：`reorderByEffortCap`（combo.js）**：稳定排序，声明上限 ≥ 请求档的成员在前、不足的沉底、未声明的视为可支持保持原序（最小惊讶）。在 auto-switch（硬能力）之后执行。开关 `effortAwareRoute`：全局默认开，每 combo 覆盖；关闭时完全不排序（钳制仍生效）。
4. **重试机制：invalid-effort 窄匹配 + 同成员降档**：status 400/422 且错误文本匹配 `/reasoning.?effort|(^|[^a-z])effort[^a-z0-9]/i`。按声明集合逐档下降（跳档，不发注定被拒的中间值）；无声明时沿档位梯逐档。降到底仍失败 → 交回主流程（fallback 循环用**原始**请求试下一个成员，Q6 决策）。
5. **降级语义：钳到声明集合边界**：请求档在集合内 → 原样；高于集合最大值 → 取集合内 ≤ 请求档的最大档；低于集合最小值 → 取最小值（升档，覆盖"只支持 high"类集合）；none/auto 不参与。
5b. **钳制落点：翻译产出的线上档位（实测修正）**：首版只钳客户端输入意图，真机验证失败——调用方（Claude Code）的思考意图是 budget 形状（`thinking.budget_tokens`），不经过档位字段；且各格式映射非单调（deepseek 把 xhigh 升为 max、kimi 把 xhigh 升为 max），输入侧钳制会被映射再次越界。修正：声明集合沿 chat.js → chatCore → translateRequest → applyThinking 显式下传，在 applyThinking 所有产出 reasoning_effort/thinkingLevel 的格式分支（openai/claude-adaptive/gemini-level/zai/deepseek/kimi/step/tokenrouter）包一层边界钳制。budget 形状的意图由此天然覆盖，无需改写客户端请求体。
6. **透明性**：响应形状不变，降级/重排如实记录在网关日志（`EFFORT` / `COMBO` 前缀），面板 usage 不额外展示。
7. **UI**：Combo 页成员行 select（不声明/low/…/max → 存连续区间数组）+ 每 combo Effort-aware 开关（`comboStrategies[name].effortAwareRoute`，与 fallbackStrategy 同对象共存，prune 逻辑已适配）；Profile 页全局 `effortAwareRoute` 默认开关。
8. **测试**：纯函数单测（clamp/resolve/apply/nextLower/match）+ combo 行为单测（重排、降级重试、降到底换成员用原始档位、无关 400 不重试）。

## Risks / Trade-offs

- 反应式重试每次降档多一次被拒请求（仅发生在配置缺失/错误的成员上；配置正确时零额外请求）
- `structuredClone` 每重试一次克隆 body（Node ≥ 17，当前基线满足；仅重试路径）
- 升档语义（请求 low、集合只支持 high → 发 high）可能让调用方以为自己在低档——日志可查，接受
- UI 连续区间假设：稀疏集合需直编 JSON，文档注明

## Migration Plan

无数据迁移：settings JSON 加默认值（`mergeWithDefaults` 兜底），旧数据直接可用。升级上游 tag 时需合并本变更涉及的 5 个源码文件 + 2 个测试文件（冲突面固定）。

## Open Questions

- 是否需要把"实际生效档位"透出到响应元数据（当前静默）——留待面板 usage 扩展时一并决策