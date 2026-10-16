# 本地原生 Rust 测速引擎与前端双轨基准测试架构

在 iRouter 桌面端引入原生 Rust 测速引擎，前端通过 Tauri IPC / SSE 双模通信与 SQLite 持久化，提供高精度 LLM 吐词速度与稳定性基准评测。

## Context

父项目 `llm-speedtest` 提供了跨 OpenAI / Anthropic / Responses 协议的高精度流式测速（TTFT、稳定吐词速度、chunk 间隔 P50/P95/P99、间隔离散比、降采样速度曲线）。由于 JavaScript 运行时的事件循环与垃圾回收（GC）停顿会引入不可忽视的时间漂移，无法满足微秒级物理 chunk 到达间隔与高频降采样的硬精度要求；且 iRouter 已有大量 Provider 与凭据配置，重复输入端点和 Key 体验割裂。

## Decision

1. **引擎驻留桌面壳层**：在 `desktop-tauri/src-tauri/src/speedtest` 中用 Rust（`reqwest` + `tokio`）实现原生测速引擎，提供纳秒级高精度单调时钟观测与流式 SSE 协议解析。
2. **双轨资产打通**：支持直接复用 iRouter 现有 Provider / 凭据一键发起测速，并提供「直连供应商 vs 经本地网关」双向损耗对比；同时保留自定义 BaseURL / Key 自由测速能力。
3. **独立仪表盘视图**：在前端导航新增 `/dashboard/speedtest` 作为专用基准评测控制台，并在 Provider / Model 列表页设置快捷测速入口。
4. **双模通信契约**：桌面端优先走 Tauri Event (`speedtest:progress`) 零延迟推送进度与曲线点；Web 环境下通过网关 `/api/speedtest` SSE 端点平滑降级。
5. **结构化 SQLite 落库**：测速结果与汇总指标持久化至本地 SQLite 数据库（`speedtest_results` 表），支持多维聚合检索并接入现有的数据导出备份体系。

Status: accepted

## Considered Options

- **桌面壳层内置 Rust 引擎（选定）** / Node.js 网关侧纯 JS 实现 / 独立外部 Python/Rust CLI 子进程。
  - 纯 JS 实现被否：Node.js 单线程与 GC 波动会直接污染 chunk 间隔 P95 与间隔离散比等物理时钟指标；
  - 独立外部 CLI 被否：增加多进程管理、生命周期捕获与跨平台分发复杂度。
- **SQLite 结构化存储（选定）** / 仅 JSONL 文件 / 纯前端 LocalStorage。
  - 纯文件与 LocalStorage 无法支撑前端按模型、网关、日期多维度高效统计条形图与趋势图。

## Consequences

- 桌面壳层 Rust 代码库新增 `speedtest` 模块，依赖既有的 `reqwest`、`tokio` 与 `serde`，不增加新的原生底层 C 库依赖；
- 需定义跨 Rust 与 TypeScript 的强类型传输协议（请求参数、进度事件 payload、指标汇总）；
- API Key 严格保持内存态流转，落库指标与前端回放时绝不写入敏感凭据。
