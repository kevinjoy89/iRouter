## Why

参考实现 llm-retry-proxy 的核心能力之一是转发前的敏感信息拦截（DLP）：检测凭据、私钥、身份证、银行卡，支持 audit / redact / block 三档，规则集中在 `retry_proxy/dlp_rules.yaml`（v2，15 条规则 + 关键词预筛 + 熵阈值 + 校验器 + 编码递归解码）。

iRouter 目前**完全没有**这一层。威胁模型是真实的：本机 agent（Claude Code / Codex 等）会把工具输出、本地文件内容、环境变量片段拼进 prompt，其中可能夹带上游凭据，而这些字节会被原样转发给供应商。参考项目已经解决了这个问题，其引擎（594 行）是纯函数、无框架依赖，可直接移植。

移植前核查参考实现的过程中发现一个**独立的、已存在的缺陷**（见 design.md「顺带修正」）：请求级自动重试（ADR 0003）因 `request.json()` 位于重试闭包内而整体失效。它必须先行修复——不仅因为它是用户可见故障，也因为它产出的 body 缓冲层正是脱敏改写的载体。

## What Changes

- **新增 `open-sse/dlp/`**（引擎，纯函数、零 `@/` 依赖）：规则加载与校验、检测引擎（正则 + keywords 预筛 + min_entropy + validator + secret_group + json_keys）、动作解析（audit / redact / block）、嵌套编码解码递归、文本 span 选择与替换、JSON 结构感知遍历、豁免标记处理。规则集为仓库内置 `open-sse/dlp/dlp_rules.yaml`（confbox 解析），支持 `DLP_RULE_FILE` 覆盖
- **新增插入点**：`src/sse/handlers/chat.js`（chat 家族 6 条路由共用）+ embeddings + images，在 body 解析后、转发前调用引擎；命中 redact 则替换 body，命中 block 则返回 422
- **修复请求级自动重试**：`handleChat` 把 `request.json()` 提到 `withAutoRetry` 之外，重试复用同一 body 对象（原实现第 2 次尝试必然返回 `400 Invalid JSON body`）
- **新增设置**：`dlpMode`（off / audit / redact / block，默认 **off**）、`dlpRules`、`dlpMaxBodyBytes`、`dlpAllowExemptions`（默认 false）；Profile 页一个下拉 + 两个 Toggle
- **已知密钥精确匹配**：从 connections 表读取上游凭据构造合并正则（长度 ≥ 8），零误报，日志只记规则名不记值

**Non-Goals**（详见 design.md）：落盘脱敏、入站 gzip/deflate 解压、audio/video 二进制体、逐条规则 UI 开关、`DLP_FAIL_CLOSED` 开关。

## Capabilities

### New Capabilities

- `request-redaction`: 转发前的敏感信息检测与改写（三档动作、规则集、豁免、已知密钥、编码递归），详见 design.md

### Modified Capabilities

- `auto-retry`: 修复重试闭包内重复读取请求体导致的整体失效（不改变重试策略语义）

## Impact

- 根目录源码：新增 `open-sse/dlp/`（引擎 + 规则文件）、`tests/unit/dlp.test.js`；修改 `src/sse/handlers/chat.js`（body 解析位置 + 脱敏插入点）、`embeddings.js`、`imageGeneration.js`、`settingsRepo.js`（默认值）、Profile 页
- **默认行为变化：无**。`dlpMode` 默认 `off`，升级后流量行为不变。唯一的行为变化是重试修复——那是修 bug
- 不做入站压缩体扫描，故不触碰 `Content-Encoding` 转发语义
- 不改变 `requestDetails` 落盘内容（见 ADR 0005 边界）
