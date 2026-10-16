# Tasks

## 1. 原生 Rust 测速引擎实现（桌面壳层）

- [x] 1.1 在 `desktop-tauri/src-tauri/src/speedtest/` 下建立模块结构（`mod.rs`, `types.rs`, `protocols.rs`, `metrics.rs`, `engine.rs`），并在 `desktop-tauri/src-tauri/src/lib.rs` 或 `main.rs` 中声明引入；验证：`cargo check` 正常通过，无模块解析错误
- [x] 1.2 实现数据模型与 Serde 序列化/反序列化（`types.rs`）：定义 `SpeedtestConfig`, `SpeedtestProgress`, `SpeedtestResult`, `ChunkMetrics`, `CurvePoint`, `SpeedtestProtocol` 等结构；验证：编写 Rust 单元测试验证 JSON 序列化与反序列化双向无损
- [x] 1.3 实现核心算法与度量计算（`metrics.rs`）：
  - 线性插值百分位数算法（P50/P95/P99），对齐 Python 原型：`rank = pct * (len - 1)`
  - 间隔离散比（P95 / P50，P50 为 0 时容错）
  - 净吐词速度 `tokens / (total - ttft)` 与平均吞吐速度 `tokens / total`
  - 降采样速度曲线算法：自适应步长 `step = max(64, output_tokens / 64)`，最大 64 点，末尾准确追加终点
  验证：编写 Rust 单元测试，输入固定时间戳差分数组，断言计算结果与预期指标完全一致
- [x] 1.4 实现多协议请求构建与流式 SSE 状态机解析（`protocols.rs`）：
  - OpenAI 兼容：`POST /chat/completions`，提取 `choices[0].delta.content`，解析 `usage.completion_tokens`，缺失时以字符数/4 容错；
  - Anthropic Messages：`POST /v1/messages`，注入 `x-api-key` 与 `anthropic-version`，提取 `content_block_delta.delta.text` 与 `message_delta.usage`；
  - OpenAI Responses：`POST /v1/responses`，解析流式事件增量；
  验证：编写 mock SSE 数据流解析单测，覆盖三种协议的数据提取与 usage 解析
- [x] 1.5 实现测速引擎主执行器（`engine.rs`）：
  - 基于 `reqwest` 流式接收 `bytes_stream`，结合 `std::time::Instant` 记录微秒级物理到达时间戳；
  - 驱动状态机累加 token 与 chunk 间隔，通过 Tauri Window/AppHandle 发射 `speedtest:progress` 事件；
  - 支持 `tokio_util::sync::CancellationToken` 实现随时主动安全中止；
  验证：编写 mock HTTP 响应流单测，断言 TTFT 捕获、进度事件触发及 abort 立即生效
- [x] 1.6 注册 Tauri IPC 命令 `speedtest_run` 和 `speedtest_abort`，并在 `capabilities/` 权限配置中声明；验证：`cargo test --locked` 通过，且 command 在桌面 IPC 注册表可见

## 2. 数据持久化与网关服务接口（Node.js / SQLite）

- [x] 2.1 在 SQLite 数据库新建 `speedtest_results` 表结构与初始化迁移：
  - 包含 `id`, `batch_id`, `model_id`, `provider_id`, `gateway_url`, `protocol`, `prompt_template`, `rounds`, `ttft_ms`, `steady_speed`, `avg_speed`, `chunk_p50_ms`, `chunk_p95_ms`, `chunk_p99_ms`, `jitter_ratio`, `output_tokens`, `curve_points_json`, `raw_metrics_json`, `created_at` 字段；
  验证：执行 SQLite 迁移脚本，验证建表及索引创建成功
- [x] 2.2 实现敏感凭据脱敏工具函数与落库安全防护：
  - 确保 API Key 不写入 `speedtest_results`，仅存脱敏指纹（前后各 5 位，中间打码）；
  验证：编写单元测试断言脱敏正则与空值/短 Key 等边缘情况
- [x] 2.3 实现历史与聚合统计 API（`src/app/api/speedtest/route.js`）：
  - `GET /api/speedtest/history`：支持分页、按模型/网关过滤及按批次查询；
  - `GET /api/speedtest/stats`：按「模型 @ 网关主机」聚合平均 TTFT、中位数稳定吐词速度；
  - `GET /api/speedtest/export`：导出历史记录为标准 JSONL 格式；
  - `DELETE /api/speedtest/history`：支持清理全部或指定历史记录；
  验证：编写 API 端点测试，覆盖查询、聚合、导出与删除
- [x] 2.4 实现纯 Web 环境下的 SSE 测速降级网关路由（`src/app/api/speedtest/run/route.js`）：
  - 检测非 Tauri 桌面壳层时，由网关发起流式代理并通过 SSE 下发进度；
  验证：单元测试验证 SSE 流输出格式与事件结构与 Tauri Event 完全对齐

## 3. 前端测速控制台与仪表盘（TypeScript / React / Next.js）

- [x] 3.1 增加多语言文案字典（`zh-CN.json`, `zh-TW.json`, `en`）：
  - 包含测速控制台所有标签、指标（TTFT、稳定吐词速度、平均速度、chunk 间隔、间隔离散比）、预设 Prompt 模板选项及提示文案；
  验证：执行语言校验断言字典键同步无缺失
- [x] 3.2 封装测速通信客户端抽象（`src/features/speedtest/client.ts`）：
  - 自动检测是否处于 Tauri 桌面环境：在桌面环境下优先使用 `@tauri-apps/api/core` 调用 `speedtest_run` 并监听 `speedtest:progress`；在 Web 模式下自动降级监听 `/api/speedtest/run` SSE 流；
  验证：编写单元测试 mock 两套环境，验证事件回调与 abort 机制
- [x] 3.3 实现双轨参数配置表单组件（`SpeedtestConfigForm.tsx`）：
  - 支持「已有供应商（Provider/Model 联动）」与「自定义外部端点」模式切换；
  - 支持「对比 iRouter 本地网关代理」勾选框（自动添加直连 vs 代理两个条目）；
  - 支持 3 组基准 Prompt 模板（默认长文 1500 词、快速 TTFT 探针、代码生成压测）与自定义 Prompt 及 `max_tokens`；
  - 支持配置 2~6 个对比条目的 Benchmark Batch 控制台；
  验证：表单交互单元测试，验证条目增删、模板切换与校验逻辑
- [x] 3.4 实现原生矢量 SVG 速度曲线组件（`SpeedtestSparkline.tsx`）：
  - 基于降采样曲线点数组（≤64 点）渲染轻量平滑 SVG 折线；
  - 支持鼠标悬停展示当前采样点 token 索引与瞬时速度 tooltip；
  验证：无额外第三方重型图表库依赖，SVG 坐标计算单元测试通过
- [x] 3.5 实现测速进度与横向对比结果卡片（`SpeedtestBatchView.tsx`）：
  - 串行测速时展示全局进度（第 X / 共 Y 个），当前条目实时刷新 TTFT、当前速度与 Sparkline；
  - 完成后展示横向指标排序对比表（支持按 TTFT、稳定速度升降序排列，标出最优与最劣）；
  验证：组件渲染单测，模拟多条目状态流转与排序
- [x] 3.6 实现历史分析与趋势看板（`SpeedtestHistoryView.tsx`）：
  - 展示历史测速表格、模型速度梯队水平柱状图与 TTFT 历史趋势折线图；
  - 支持「一键导出 JSONL」与「清空历史」；
  验证：组件加载历史数据渲染无误，导出按钮触发 Blob 下载
- [x] 3.7 侧边栏与快捷入口联动集成：
  - 新增顶级页面路由 `/dashboard/speedtest`；
  - 在主导航侧边栏追加「模型测速」入口；
  - 在 Providers 列表与 Models 详情卡片上新增「测速」快捷跳转按钮（携带 query 参数预填表单）；
  验证：各入口点击导航及 URL query 解析预填测试通过

## 4. 全链路端到端验证与门禁

- [x] 4.1 运行 Rust 原生引擎单测（`cargo test -p desktop-tauri speedtest`）：
  - 验证高精度时钟观测、插值分位数、SSE 状态机解析与取消信令响应全部通过
- [x] 4.2 运行前端与后端单元测试（`npx vitest run tests/speedtest`）：
  - 覆盖数据持久化、脱敏过滤、API 聚合统计及前端状态驱动全部通过
- [ ] 4.3 桌面端真实端到端集成验证（需在实机 GUI 会话验证）：
  - 启动桌面端应用，进入 `/dashboard/speedtest`，选择已有 Provider 执行 1 次测速，验证实时 TTFT、速度曲线及历史落库正常；
  - 勾选「对比 iRouter 本地网关代理」，验证两个条目串行测试完成并正确渲染直连 vs 代理差异指标
- [x] 4.4 跑全仓回归门禁：
  - `cargo test --locked` 通过；
  - `npx vitest run` 与门禁基线无新增回归

## Workflow follow-up

- 归档前确认 `openspec/specs/` 首次 sync 出三个新能力（`speedtest-engine` / `speedtest-dashboard` / `speedtest-persistence`）。
- 归档本变更后核对主 spec 的 Purpose 段是否完整（新能力由 delta 的 `## Purpose` 复制而来）。
