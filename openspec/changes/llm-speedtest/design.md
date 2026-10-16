## Context

详见 `proposal.md`。
当前 iRouter 基于 Tauri v2 桌面壳层（Rust）与 Next.js 前端，后端包含 Node.js 网关及 SQLite 数据库。测速需求对物理时间戳的精度（微秒/纳秒级物理到达时间差）、跨协议 SSE 流式解析及防 GC 停顿要求极高；同时需无缝复用已有的 Provider 配置与凭据体系，支持直连上游与本地代理的耗时损耗对比。

## Goals / Non-Goals

**Goals:**
- 在 `desktop-tauri/src-tauri/src/speedtest` 中用 Rust（`reqwest` + `tokio`）实现原生高性能测速核心，彻底规避 JS 运行时的事件循环抖动与 GC 干扰；
- 原生支持 OpenAI 兼容、Anthropic Messages、OpenAI Responses 三种主流协议的端到端测速解析；
- 完整采集 TTFT、总耗时、稳定吐词速度、平均吐词速度、chunk 间隔 (P50/P95/P99)、间隔离散比与至多 64 点降采样速度曲线；
- 在 Next.js 仪表盘新增独立路由 `/dashboard/speedtest`，提供单模型评测、多模型对比批次（Benchmark Batch）、实时 SVG Sparkline 与历史看板；
- 双轨支持：一键读取 iRouter 已有 Provider/Model 自动填密测速（支持对比直连 vs 代理），亦保留自定义外部端点与 Key 模式；
- 在 SQLite 数据库落盘历史指标，并支持按模型/网关主机多维聚合与 JSONL 导出。

**Non-Goals:**
- 本期不直接将测速指标介入 iRouter 网关的动态权重路由或自动故障倒换（预留数据接口，下期迭代）；
- 不在 Rust 引擎中单独重写所有非标供应商的私有协议（Gemini 等统一走 iRouter 本地代理层自动转为 OpenAI 兼容协议参测）；
- 不落盘保存完整的数十万字节原始 HTTP 流式 Body 报文（仅保存指标与降采样曲线点，单条记录 <2KB）。

## Decisions

### 1. 测速引擎驻留桌面壳层 Rust 侧
- **选定方案**：在 `desktop-tauri/src-tauri/src/speedtest` 下编写 Rust 原生引擎模块，利用 `std::time::Instant` 提供纳秒级单调时钟观测，通过 Tauri IPC 与前端 TS 通信。
- **备选方案**：Node.js 网关纯 JS 实现；独立外部 CLI 二进制。
- **决策理由**：详见 `docs/adr/0010-native-rust-speedtest-engine.md`。纯 JS 易受 Node.js 单线程与 GC 停顿污染，导致 chunk 间隔 P95 与间隔离散比失真；桌面壳层自带已缓存的 `reqwest` 与 `tokio`，性能最优且部署零外部依赖。

### 2. 双模事件流通信契约
- **选定方案**：桌面环境下采用 Tauri Event（`app.emit("speedtest:progress", ...)`）高频推送流式进度；Web 浏览器形态下通过网关 `/api/speedtest` SSE 端点平滑降级。
- **备选方案**：纯 WebSocket 通道；前端定时短轮询。
- **决策理由**：Tauri Event 在桌面内进程间通信延迟低于 0.1ms，零网络开销；对于轻量 Web 环境通过标准 SSE 降级，前端共享统一的 TypeScript 事件监听与解包逻辑。

### 3. 数据持久化与生命周期控制
- **选定方案**：在本地 SQLite 数据库建立 `speedtest_results` 表，记录完整的轮次级指标、汇总中位数与降采样曲线 JSON。
- **备选方案**：沿用外部单独的 `results.jsonl`；仅保存在浏览器 localStorage。
- **决策理由**：存入 SQLite 可以高效支持历史图表视图按「模型 @ 网关主机」的多维度 SQL 聚合查询，并自然接入 iRouter 现有的配置备份与数据清理策略。

### 4. 敏感凭据零泄露原则
- **选定方案**：API Key 仅在 Rust 测速引擎发起网络连接时在内存中使用；数据库落库、历史接口下发及前端渲染一律转换为脱敏指纹（如 `sk-li****6a`）；前端选择已有 Provider 时由后端在网关层完成内部鉴权装配，密钥不暴露到客户端 DOM。

## Risks / Trade-offs

- [跨协议流式解析差异] → 在 Rust 侧使用枚举与 trait 统一解包，针对 `choices[0].delta.content`（OpenAI）、`content_block_delta`（Anthropic）与 Responses 协议编写独立解析器与单元测试用例。
- [部分网关流式响应不返回 usage] → 继承 `llm-speedtest` 经过验证的健壮算法：当 `usage` 缺失时，按 `len(chars) // 4` 粗略估算 token 计数，并在前端标注「估算」标签。
- [多模型串行对比耗时较长] → 对比批次严格串行执行并显示全局「第 X / 共 Y 个条目」进度卡片；单条目因超时或鉴权失败时不中断批次，记录错误并自动步进下一条目。
