## Purpose

提供基于本地原生单调时钟与流式状态机的高精度 LLM 吐词测速引擎，消除事件循环抖动并支持多协议实时指标观测与速度曲线采样。

## ADDED Requirements

### Requirement: 多协议端到端流式请求与时钟观测
测速引擎 SHALL 支持针对 OpenAI 兼容（`/chat/completions`）、Anthropic Messages（`/v1/messages`）以及 OpenAI Responses（`/v1/responses`）协议的流式端到端测速调用，并基于物理高精度单调时钟观测每一个数据块到达时刻。

#### Scenario: 成功发起 OpenAI 兼容协议测速并捕获首包
- **WHEN** 客户端以 OpenAI 协议参数向目标端点发起测速调用
- **THEN** 引擎建立 HTTP POST 流式连接，准确记录从请求发出至接收到首个有效内容数据块的时间差作为 TTFT

#### Scenario: 针对 Anthropic 协议自动适配鉴权头与事件解析
- **WHEN** 客户端选择 Anthropic 协议进行测速
- **THEN** 引擎自动追加 `x-api-key` 与 `anthropic-version` 请求头，并从 `content_block_delta` 事件中提取文本增量

### Requirement: 吐词稳定性与分布指标计算
引擎 SHALL 统计整个流式生命周期中的物理 chunk 时间差分序列，并实时计算分位数与卡顿衡量指标。

#### Scenario: 计算相邻 chunk 间隔分位数与离散比
- **WHEN** 一轮测速完成且接收到至少两个数据块时间戳
- **THEN** 引擎按线性插值法计算相邻 chunk 间隔的 P50、P95、P99 分位数，并产出间隔离散比（P95 ÷ P50）

#### Scenario: 计算生成期净吐词吞吐速度
- **WHEN** 测速完成并获取到生成阶段总耗时与输出 token 计数
- **THEN** 引擎计算稳定吐词速度为 `输出 tokens ÷ (总耗时 − TTFT)`，以及平均吐词速度为 `输出 tokens ÷ 总耗时`

### Requirement: 步长自适应降采样速度曲线
引擎 SHALL 对流式生成过程中观测到的时间戳与累计输出数据进行步长自适应降采样，输出不超过 64 个数据点的速度曲线。

#### Scenario: 速度曲线采样点步长自适应与极值保护
- **WHEN** 流式生成持续推进且累计 token 超过下一采样步长阈值
- **THEN** 引擎计算该区间的瞬时吞吐速度并记录采样点，保证全过程曲线点数在 1 至 64 个之间，且最后一个点准确反映最终总吞吐

### Requirement: 实时进度通知与运行态控制
引擎 SHALL 支持在测速执行期间高频发射实时进度事件，并允许客户端随时发送中断信号。

#### Scenario: 实时进度事件高频通知
- **WHEN** 测速过程中每收到数据块且产生有效增量
- **THEN** 引擎向外发射包含已生成 token 数、瞬时速度和当前曲线最新采样点的进度事件

#### Scenario: 主动中止测速执行
- **WHEN** 客户端发送中断命令或连接断开
- **THEN** 引擎立即中止当前正在执行的 HTTP 传输，释放网络连接并停止计时
