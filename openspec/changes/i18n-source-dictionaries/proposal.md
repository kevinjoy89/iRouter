## Why

思考强度上限降级与限流自动重试两个特性的面板文案（Effort-aware 开关、Retry Strategy 卡片、成员思考强度上限选择等约 22 条）没有进入多语言字典，中文界面直接显示英文。同时，此前多个迭代的面板定制翻译采用**外挂**方式：`desktop/resources/i18n/{zh-CN,zh-TW}.json`（各 650 条，含品牌定制如 `9Router Proxy v0.5.69 → iRouter Proxy v0.0.1`、`~/.9router → ~/.irouter`）在打包时由 build-server 合并进产物。源码并入仓库根目录后，这套外挂已无存在必要。

## What Changes

- 面板 i18n 机制说明：英文即源文；非英文运行时 fetch `public/i18n/literals/{locale}.json`（`{英文整句: 译文}`，上游随仓库分发）按 DOM 文本节点精确替换；`<select>` 子树与 `title` 属性不在翻译范围
- **外挂转正**：`desktop/resources/i18n/{zh-CN,zh-TW}.json` 各 650 条并入源字典 `public/i18n/literals/{zh-CN,zh-TW}.json`（补丁值优先——139/38 条为有意的品牌与措辞覆盖）；随后删除 build-server 步骤 5（合并逻辑）与 `desktop/resources/i18n/`
- **补全新功能文案**：22 条新增字符串（Effort-aware / Retry Strategy 卡片全部 label 与描述）规范化为纯英文源文，并提供 zh-CN / zh-TW 翻译入字典；混合语言文案（中英夹杂描述）一并修正
- 档位枚举（low/medium/high/xhigh/max）、状态码不翻译；`<select>` 内占位符改为中性 `effort`（机制上 select 子树不翻译，title 属性保持英文）

## Capabilities

### New Capabilities

<!-- 无新增能力：既有 i18n 机制的字典内容补全与维护方式调整 -->

### Modified Capabilities

- 面板多语言字典：条目数 zh-CN 1392 → 1787、zh-TW 195 → 806；外挂合并机制移除

## Impact

- 删除 `desktop/resources/i18n/`；`desktop/scripts/build-server.mjs` 移除合并逻辑与未用导入，打包管线回归上游原样
- 源字典 `public/i18n/literals/{zh-CN,zh-TW}.json` 直接维护（即源头）；新 UI 文案后续随功能一并入字典
- 其余 32 种语言无新条目，自动回退英文（机制原生行为）