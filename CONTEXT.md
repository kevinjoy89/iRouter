# iRouter Context

iRouter 是 9Router（开源 AI 路由网关，decolua/9router）的跨平台安装版：装完是一个真正的桌面应用，窗口内直接显示 9Router 面板，无需打开系统浏览器。9Router 源码基于上游 **v0.5.75** 定制，位于本仓库根目录（`src/`、`open-sse/`、`tests/` 等）；桌面壳层在 `desktop/`。

## Language

**iRouter**:
本产品的正式名称。9Router 的桌面独立安装版，MIT 许可下沿用上游功能与数据格式。
_Avoid_: 9Router Desktop、9Router 桌面版（容易和上游官方概念混淆）

**定制基线（v0.5.75 baseline）**:
9Router 源码基于上游 decolua/9router v0.5.75 定制，位于仓库根目录，可自由修改；升级 = 对比上游新版本手工合并本地定制。原 submodule 锁版结构已废弃（ADR 0002/0003 为历史决策）。
_Avoid_: 锁版上游、零改动、submodule（均为旧结构用语）

**上游同步（upstream sync）**:
把上游新区间（标签或 HEAD）merge 进根目录源码、保留全部本地定制的动作；产出是 merge commit 血缘 + 重新快照的测试基线。可见版本号不随同步变化（那是产品版本号，见下条）。
_Avoid_: 升级（歧义：易与产品发版混淆）、更新版本

**产品版本号（product version）**:
iRouter 自身对外可见的版本号（当前 `0.1.0`），真源为 `desktop/package.json`，构建期经 `NEXT_PUBLIC_APP_VERSION` 注入面板。与**上游基线号**（根 `package.json`，当前 `0.5.75`）解耦：后者只用于 UA / `X-Msh-Version` / `_meta.appVersion` 等与上游对齐的标识，不外露。二者不同不是缺陷，勿统一（ADR 0004）。
_Avoid_: 网关版本（易与上游基线号混淆）、应用版本

**壳层（shell layer）**:
位于 `desktop/` 的桌面化定制代码，负责：窗口、托盘、单实例、自启、打包安装器。壳层与网关源码同仓库，通过进程边界交互。
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

### 控制台日志

**已接收（received）**:
控制台日志页自会话以来收到的日志行总数（超出容量上限时丢弃最旧的），含被级别过滤或搜索排除的行。
_Avoid_: 总行数（未区分与「可见」的关系）

**可见（visible）**:
当前级别过滤与搜索条件下实际展示的日志行数。恒有 可见 ≤ 已接收。
_Avoid_: 「N / M 行」写法（方向易误读，已弃用）

### 脱敏策略

**脱敏策略（redaction policy）**:
「请求脱敏」在设置面板里的配置入口：模式四档（关闭 / 仅告警 / 改写 / 拦截）加「匹配已知密钥」「允许豁免标记」两个开关。它是**配置集**，与逐条的「敏感信息规则」不在同一层——前者决定这套能力怎么跑，后者是其中一条检测规则。面板卡片标题即此词。
_Avoid_: 与「请求脱敏」互指（前者是能力名、出现在 ADR 与代码注释里，后者是配置入口；混用会让 ADR 失去锚点）

**敏感信息规则（sensitive-data rule）**:
一条检测规则 = 正则 + 预筛关键词 + 熵阈值 + 校验器（身份证校验位 / Luhn）+ 动作覆盖 + 替换占位符。规则集是数据文件（`dlp_rules.yaml`）而非代码，可与参考实现逐行 diff。
_Avoid_: 策略（与 settings 里其它策略混淆）

**豁免标记（exemption marker）**:
正文中一对固定标记围出的区间，声明"这段确实要发"。启用后该区间不参与规则匹配，标记在转发前移除；未配对或嵌套的标记按普通正文处理。默认关闭（可信单用户部署的显式放行机制，不是访问控制）。
_Avoid_: 白名单（那是按值豁免，不是按位置）

**已知密钥（known secret）**:
本机已存储的上游凭据值，用于精确匹配。命中即判泄漏、零误报，日志只记规则名不记值；长度不足 8 的凭据不参与。
_Avoid_: 号池密钥（那是 key pool 语境）

**代码语境误报（code-context false positive）**:
检测命中的是「代码里在讨论凭据」而非凭据本身——例如赋值语句 `accessToken = newCredentials`、点分路径 `updateData.accessToken`。判据是**值形如代码标识符**（小写驼峰或点分路径），而非值很短或像变量名。与「敏感信息规则」的 allowlist 同层但取向相反：allowlist 按值放行，deny 按形状放行。它的代价是把自己变短——每加一条就要问「真密钥会不会长这样」，真密钥含 `-`、数字或全大写，故不冲突。
_Avoid_: 白名单（那是 allowlist，按具体值）；噪声（太泛，说不清是哪一类结构）

**观测篡改（observer tampering）**:
出站脱敏的一项副作用，此前未被 ADR 0005 记录：脱敏改写的是**模型赖以决策的观察**。当 agent 把工具输出（`grep` 结果、`sed` 输出、文件读取）拼进 prompt 时，被改写的字节会成为模型下一轮推理的前提——模型会基于被篡改的视图去 debug 一个不存在的字符串。对被动读日志的用户，脱敏是隐私保护；对模型本身是主体、且其输出又反过来成为输入的 loop，它是观测污染。二者取舍相反，故同一份配置在不同角色下评价不同。
_Avoid_: 数据损坏（那是 bug，这是设计）；与「落盘脱敏」混谈（两者作用对象不同：一个改出站字节，一个改本机副本）
**出站脱敏 / 落盘脱敏（egress vs at-rest redaction）**:
两个独立的战场。出站脱敏作用于转发给上游的字节；落盘脱敏作用于本机 `requestDetails` 表里存的完整 messages。**第一版只做出站**，落盘另立项：二者都做会让日志里存的与发出去的不一致，排障时会误导。代价是开了脱敏之后本机 SQLite 仍是明文。
_Avoid_: 混为一谈（会让人以为开了脱敏就没有本机明文副本）
