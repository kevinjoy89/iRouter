## Context

- 面板 i18n 为运行时 DOM 替换方案：`src/i18n/runtime.js` 按 cookie 取 locale，fetch `/i18n/literals/{locale}.json` 得到 `{英文整句: 译文}` 映射，MutationObserver 遍历文本节点精确替换；`en` 不加载字典；`<select>` 子树不翻译
- 源字典即 `public/i18n/literals/{locale}.json`（34 语言，随上游仓库分发，zh-CN 1392 条）；无生成步骤
- 外挂：`desktop/resources/i18n/{zh-CN,zh-TW}.json` 各 650 条（277 条与上游重叠，其中 139/38 条为品牌与措辞覆盖；373/612 条为新增），build-server 打包时合并进 standalone 产物

## Goals / Non-Goals

**Goals:**

- 补齐思考强度上限降级与自动重试两个特性全部面板文案的 zh-CN / zh-TW 翻译
- 外挂翻译转正：字典唯一源头为 `public/i18n/literals/`，打包管线不再做字典合并
- 新增 UI 文案规范化为纯英文源文（消除中英混合描述）

**Non-Goals:**

- 不铺其余 32 种语言（无条目自动回退英文）
- 不动品牌定制条目本身（如 `iRouter Proxy v0.0.1` 版本串——上游版本变化时该条目会失配，属既有已知行为）

## Decisions

1. **转正方式**：外挂条目整体并入源字典，**补丁值优先**（保留品牌定制与措辞覆盖的语义）；一次性脚本合并，人工不逐条搬。
2. **新文案 22 条**：先在组件里规范化英文源文，再按同一条目写 zh-CN（简体）与 zh-TW（繁体）翻译；关键术语对齐既有字典风格（combo → 组合模型、effort cap → 声明上限、retry → 重试）。
3. **枚举不翻**：档位枚举与状态码保持英文原样（上游枚举风格一致，且 select 子树本就不翻译）；成员行占位符 `effort?` 规范为 `effort`。
4. **title 属性翻译（真机反馈后修正）**：原口径"属性不翻译"导致 tooltip 漏翻——现给运行时机制补齐 `title` 翻译（`processElementTitles` + observer 监听 title 属性变化，幂等：已翻译值不命中英文键、原样保留）；`<select>` 子树仍跳过。
5. **删除外挂**：build-server 步骤 5（合并逻辑 + readdir/read/write 导入）与 `desktop/resources/i18n/` 一并移除。

## Risks / Trade-offs

- 品牌覆盖条目对上游原文精确匹配，上游改版原文即失配（外挂时代同样存在，非新增风险）
- 繁体翻译由简体直转 + 术语校准，个别措辞可能与台港习惯有差——自用可接受，后续可润色

## Migration Plan

一次性脚本合并，无运行时迁移；打包产物 literals 直接来自源字典。

## Open Questions

<!-- 无 -->
