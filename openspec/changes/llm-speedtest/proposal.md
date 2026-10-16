## Why

在多模型聚合网关日常运维与应用开发中，各模型提供商（或自建/开源模型）的首包延迟（TTFT）、吞吐生成速度以及流式吐词顿挫感存在极大差异。虽然父目录 `llm-speedtest` 实现了基于 Python 的高精度流式测速原型，但无法直接复用 iRouter 本地已配置的供应商凭据、模型目录与网关代理资产，且 JavaScript 运行时 GC 停顿与事件循环抖动无法保证纳秒/微秒级物理时钟观测。

本变更将原生 Rust 测速引擎与 TypeScript 前端仪表盘深度集成至 iRouter，打通现有 Provider 资产与直连/代理双轨评测，为模型选型与网关性能提供客观、高精度、可持久化分析的基准评测体系。

## What Changes

- 在桌面壳层 `desktop-tauri/src-tauri/src/speedtest` 中引入原生 Rust 测速模块，基于 `Instant` 提供纳秒级单调时钟观测与流式 SSE 协议状态机解析；
- 支持 OpenAI 兼容（`/chat/completions`）、Anthropic（`/v1/messages`）、OpenAI Responses（`/v1/responses`）三种协议直连测速，以及经由 iRouter 本地代理的通用测速；
- 统计并实时计算首 token 延迟 (TTFT)、总耗时、稳定吐词速度、平均吐词速度、chunk 间隔 (P50/P95/P99)、间隔离散比，以及至多 64 点的降采样速度曲线；
- 建立 Tauri Event (`speedtest:progress`) 零延迟通信通道，并在纯 Web 模式下以 SSE (`/api/speedtest`) 平滑降级；
- 在前端侧边栏新增 `/dashboard/speedtest` 独立基准评测页面，支持单条测速与 2~6 条目对比批次（Benchmark Batch）串行评测与横向表格排序；
- 提供原生 SVG 速度曲线 Sparkline 折线图及历史聚合条形图/折线图视图；
- 支持双轨模式：既可一键选择现有已配置的 Provider 与已存密钥（并支持直连 vs 本地代理损耗对比），又支持自由输入外部端点和 Key；
- 在 SQLite 数据库中新建 `speedtest_results` 表持久化评测指标，敏感 Key 仅内存使用绝不落盘，支持导出为 JSONL 文件；
- 在 Providers 与 Models 列表卡片增加快捷「测速」跳转入口。

## Capabilities

### New Capabilities
- `speedtest-engine`: 原生 Rust 测速引擎，负责高精度单调时钟观测、多协议流式 SSE 解析、分位数与离散比计算及步长自适应降采样速度曲线生成。
- `speedtest-dashboard`: 前端 TypeScript 基准评测仪表盘，负责单条与多模型对比控制台、实时进度呈现、原生 SVG 速度曲线渲染、历史图表分析及与现有 Provider 资产的联动。
- `speedtest-persistence`: 测速历史与基准指标在 SQLite 数据库中的结构化落库、生命周期管理、脱敏安全保护与 JSONL/CSV 导出。

### Modified Capabilities
<!-- 本次为独立新增模块，不修改原有功能的 Spec 级行为 -->

## Impact

- **桌面壳层 (Rust)**: `desktop-tauri/src-tauri/src/` 新增 `speedtest` 模块，注册 `speedtest_run`、`speedtest_abort` 命令，依赖现有 `reqwest`、`tokio` 与 `serde`。
- **网关与数据库 (Node.js)**: 新增 SQLite `speedtest_results` 表；新增 `/api/speedtest/history`、`/api/speedtest/stats` 与 SSE 降级路由。
- **前端页面 (Next.js)**: 新增路由 `/dashboard/speedtest`；侧边栏新增导航项；修改 Provider/Model 卡片追加快捷测速入口。
