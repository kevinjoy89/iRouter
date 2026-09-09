# iRouter Context

iRouter 是 9Router（开源 AI 路由网关，decolua/9router）的跨平台独立安装版：装完是一个真正的桌面应用，窗口内直接显示 9Router 面板，无需打开系统浏览器。9Router 上游源码保持零改动，所有定制都在本仓库的壳层完成。

## Language

**iRouter**:
本产品的正式名称。9Router 的桌面独立安装版，MIT 许可下沿用上游功能与数据格式。
_Avoid_: 9Router Desktop、9Router 桌面版（容易和上游官方概念混淆）

**锁版上游（pinned upstream）**:
`9router/` 目录中固定在某个 tag 的 9Router 源码 checkout，自 ADR 0003 起允许直接修改源码（自维护）；升级 = 切到新 tag 并合并本地改动。ADR 0002 的"零改动"条款已被取代。
_Avoid_: 依赖上游原样（历史含义，自 0003 起不再是约定）

**壳层（shell layer）**:
本仓库内独立于 `9router/` 的定制代码（计划位于 `desktop/` 子目录），负责桌面化：窗口、托盘、单实例、自启、打包安装器。壳层通过进程边界与锁版上游交互。
_Avoid_: 封装、wrapper（与本仓库其他含义混淆）

**内嵌面板（embedded dashboard）**:
iRouter 应用窗口内直接渲染的 9Router Web 面板（Electron 窗口指向本机网关地址），不经系统浏览器。
_Avoid_: 浏览器访问（那是 CLI 形态的旧体验）

**网关服务（gateway）**:
9Router 提供的 OpenAI 兼容本地 API（iRouter 默认 `http://127.0.0.1:20128/v1`，仅绑定回环地址），供 Claude Code、Codex 等外部 CLI 工具调用。它和面板是同一个进程/端口。
_Avoid_: 服务端、后端（过于泛化）

**数据目录（data dir）**:
由 9Router 的 `DATA_DIR` 环境变量决定的位置，存放配置、数据库、密钥。iRouter 默认指向平台应用数据目录（macOS `~/Library/Application Support/iRouter` 等）；首次运行可一键导入旧 CLI 的 `~/.9router` 数据。
_Avoid_: 安装目录（与程序文件位置无关）

### 模型路由

**组合模型（combo）**:
用户创建的具名模型条目，聚合多个 `provider/model` 成员（如多个供应商的 `deepseek-v4-flash`），请求按策略（fallback / round-robin / fusion）在这些成员间路由。上游源码中的正式叫法即 combo。
_Avoid_: 聚合模型（用户说法，代码与文档统一用 combo）

**思考强度（reasoning effort）**:
请求中的思考档位，`reasoning_effort` 一类字段的取值，档序 minimal < low < medium < high < xhigh < max（另有 none / auto 特殊值）。不同供应商接受不同的档位集合。
_Avoid_: 思考预算（那是另一套 token 预算语义）

**思考强度上限（effort cap）**:
某一 (provider, model) 声明的可接受思考强度档位集合，配置在 settings 的 `effortCaps` 中。请求档位超出集合时降级（钳到集合边界），低于集合下限时升到下限。
_Avoid_: 档位映射表（设计上是"接受集合 + 边界钳制"，不是显式逐档映射）

**主动钳制（proactive clamp）**:
发送前把思考强度钳到该供应商声明的接受集合内；与**反应式降级重试**（收到 invalid-field 类 400 后同供应商逐档下调重试）互补，前者确定性、后者兜底配置缺失/错误。

**能力感知排序（effort-aware routing）**:
组合模型路由前，把"成员声明上限 ≥ 请求档位"的成员排前、声明上限不足的排后，使请求尽量命中原生支持的成员。可通过全局 `effortAwareRoute`（默认开）或每 combo 的 `comboStrategies[name].effortAwareRoute` 关闭。

### 重试

**重试策略（auto-retry）**:
限流/过载类错误（状态码白名单或限流文本）触发"等待后重试"的策略，配置在 settings 的 `autoRetry`。分两层：**整体重试**（请求级：整条回退链穷尽后等待、整组重来）与**成员级重试**（组合内某成员限流时原地等待重试，次数用尽才换下家）。重试只发生在首字节之前；客户端断开立即终止。
_Avoid_: 无限重试（默认有次数与累计等待预算上限）

**回退链（fallback chain）**:
一次 chat 请求内的既有容错层序：账号回退（同供应商多连接轮换）→ 成员回退（combo 换下个成员）。整体重试位于回退链之外，是最后一道防线。
_Avoid_: 自动重试（那是回退链之外的整体重试）
