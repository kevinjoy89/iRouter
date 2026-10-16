## Purpose

为 iRouter 仪表盘提供专业的 LLM 测速与基准评测可视化界面，支持双轨配置、多模型串行对比、实时速度曲线渲染与历史分析看板。

## ADDED Requirements

### Requirement: 独立基准评测页面与侧边栏导航入口
系统 SHALL 在主导航菜单中提供独立入口，引导用户进入完整的模型测速与基准评测控制台。

#### Scenario: 从侧边栏进入测速仪表盘
- **WHEN** 用户点击侧边栏「模型测速」导航项
- **THEN** 界面导航至 `/dashboard/speedtest` 并展示测速控制台与评测看板

### Requirement: 双轨参数配置与 iRouter 资产联动
控制台 SHALL 同时支持复用 iRouter 本地已存 Provider 资产与手动输入外部端点参数。

#### Scenario: 从已有 Provider 下拉选择并自动载入凭据
- **WHEN** 用户切换至「已有供应商」模式并选择特定的 Provider 和模型
- **THEN** 系统自动绑定对应的目标端点并调用内部安全凭据，免除手动输入 API Key

#### Scenario: 对比直连上游与本地代理网关
- **WHEN** 用户勾选「对比 iRouter 本地网关代理」选项
- **THEN** 系统将该模型的「直连供应商源站」与「经本地网关转发」自动拆分为两个条目加入对比批次

### Requirement: 多模型对比批次评测（Benchmark Batch）
系统 SHALL 支持配置 2 至 6 个对比条目，并在全局统一下发后串行执行逐项评测。

#### Scenario: 批次任务串行评测与横向汇总对比
- **WHEN** 用户启动包含多个条目的对比批次任务
- **THEN** 系统按顺序串行测速，单条失败不阻断批次，全部执行完毕后展示横向指标排序对比表

### Requirement: 实时流式进度反馈与原生 SVG 速度曲线
系统 SHALL 在测速过程中动态呈现实时数据，并以矢量 Sparkline 渲染速度变化轨迹。

#### Scenario: 实时渲染进度卡片与悬停交互
- **WHEN** 测速任务正在执行并接收到引擎推送的进度事件
- **THEN** 卡片上的 TTFT、已生成字符、实时吞吐数值即时刷新，下方 SVG 速度曲线动态延伸并支持鼠标悬停查看采样点瞬时速度

### Requirement: 供应商与模型卡片快捷测速入口
系统 SHALL 在 Providers 列表及 Models 详情卡片提供一键跳转至测速控制台的直达入口。

#### Scenario: 从 Provider 模型卡片调起快速测速
- **WHEN** 用户在模型列表中点击该模型的「测速」操作按钮
- **THEN** 页面跳转至 `/dashboard/speedtest` 并自动预填该供应商与模型参数
