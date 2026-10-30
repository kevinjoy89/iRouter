# i18n 审计：上游 v0.5.104 → v0.5.112

本文件记录 2026-10-30 对上游区间 `decolua/9router v0.5.104...v0.5.112`
（70 提交、325 文件）所做的多语言覆盖审计结果，作为后续 P1 批次摘取 UI 改动时的
前置输入。

## 审计口径

本项目的语言集合是**三种**（`src/i18n/config.js` 的 `LOCALES`）：

```js
export const LOCALES = ["en", "zh-CN", "zh-TW"];
```

英文是源文本，因此需要维护两份字典：`public/i18n/literals/zh-CN.json` 与
`zh-TW.json`。上游则维护 30+ 种语言，两边的语言集合不一致——**这决定了上游的
literals 提交不能整文件照搬，只能按 zh-CN / zh-TW 逐条比对后手工迁移**。

审计方法是：对区间内每个改过 UI 层（`src/app/`、`src/shared/components/`、
`src/features/`）的提交，抽取新增的 JSX 文本节点与 `label` / `placeholder` /
`title` / `aria-label` 属性，然后用 `python3` 做 JSON 精确键匹配，逐个查上游
`v0.5.112` 自带的 zh-CN / zh-TW 字典里有没有对应条目。

## 结论 1：上游 `a3ca2f9b` 自身存在 zh-TW 缺口

提交 `a3ca2f9b fix(dashboard): correct API key visibility guidance` 改写了
API Key 创建弹窗的提示文案，并同步了 6 个语言字典（fa / id / km / pt-BR / th /
zh-CN）。实测上游 `v0.5.112` 的字典状态：

| 字典 | 旧串 `This is the only time you will see this key. Store it securely.` | 新串 `Store this key securely. You can view or copy it later from the API Keys list.` |
| :--- | :--- | :--- |
| 上游 zh-CN | 已删除 | 已添加 |
| 上游 zh-TW | **已删除** | **未添加** |

后果：在 v0.5.112 上切到繁体中文时，该弹窗提示会原样显示英文；且因为旧键已被
删除，连旧的繁体译文都不会回退命中。

**摘取要求**：合入 `EndpointPageClient.js` 的文案改动时，zh-TW 译文必须自行
翻译补齐，不能照搬上游。

本地现状：未摘该提交，本地 zh-CN 与 zh-TW 都仍是旧串且译文完整，因此本轮
（P0 批次）没有暴露此缺口。

## 结论 2：上游新增 UI 文案的中文覆盖缺口清单

以下串来自区间内改过 UI 层的 20 个提交。`[zh-CN/zh-TW]` 列表示上游 v0.5.112
字典中是否存在该键（`Y` 有 / `N` 缺）。

### 两份字典都缺（18 条）

| 文案 | 来源提交 |
| :--- | :--- |
| `Image (URL or upload)` | `38a0c449` web-cookie |
| `Opening browser window` | `38a0c449` |
| `Saving connection` | `38a0c449` |
| `Waiting for you to log in` | `38a0c449` |
| `Manage OAuth connections →` | `421f2262` Codex STT |
| `This service shares your existing OAuth connections.` | `421f2262` |
| `Custom system prompt` | `8a842043` RTK 自定义提示词 |
| `Prompt Extend` | `351b04cb` SenseNova |
| `Search combos` | `9b4ea9eb` 组合搜索框 |
| `Search combos…` | `9b4ea9eb` |
| `Configure in Media Providers` | `f3f86fdd` Smart Router |
| `Configure routing policy and prompt cache retention` | `f3f86fdd` |
| `Pick the System One model that decides model routing` | `f3f86fdd` |
| `Prompt Cache Benefits:` | `f3f86fdd` |
| `Ready (Free)` | `f3f86fdd` |
| `Reset router to Auto` | `f3f86fdd` |
| `Select System One Router Model` | `f3f86fdd` |
| `Smart Router` / `Smart Router — System One` | `f3f86fdd` |
| `Switch Confidence Threshold:` | `f3f86fdd` |
| `Max output tokens` | `72cb589e` Pi CLI 设置 |

（其中 `f3f86fdd` 一处就占 10 条，是缺口最集中的提交——它是约 1100 行的
Smart Router / System One 新功能，作者未做任何本地化。）

### zh-CN 有、zh-TW 缺（3 条）

| 文案 | 来源提交 |
| :--- | :--- |
| `Add Connection` | `38a0c449` |
| `Clear search` | `9b4ea9eb` |
| `Not configured` | `f3f86fdd` |

## 结论 3：字典基数对比

```
本地 zh-CN 键数:      2914
上游 v0.5.112 键数:   1417
仅本地有:             1501
仅上游有:                4
```

本地字典规模是上游的两倍，来自历次同步累积的本地补充翻译。上游仅有、本地没有的
仅 4 条：

| 键 | 处置 |
| :--- | :--- |
| `Donate` | 按既有 ADR 一贯排除（9Remote 商业推广） |
| `Get 9Remote` | 同上 |
| `Store this key securely. You can view or copy it later from the API Keys list.` | 随 `a3ca2f9b` 摘取时补入（见本文件「结论 1」） |
| `ms / Total` | 随 usage 面板改动摘取时补入 |

## 对后续批次的操作要求

1. **任何摘取 UI 改动的批次，必须同步补 zh-CN 与 zh-TW 两份译文**，不得只补
   其一，也不得因为「上游字典里有」就认为两份都齐（结论 1 就是反例）。
2. **验收方式**：照 `tests/unit/dlp-i18n-coverage.test.js` 的模式，为每个新增
   UI 区域加覆盖守卫——从源码抽取英文源串，断言 zh-CN 与 zh-TW 字典都命中，
   且译文不等于英文（防「值 == 键」的占位式入典）。
3. **不要整文件覆盖上游 literals**：两边语言集合不同，覆盖会丢掉本地 1501 条
   补充翻译。

## P0 批次（已完成）的 i18n 影响

P0 批次 5 个提交（`1bad6f90` / `4366671e` / `cb6e95d5` / `491e0159` /
`3c899c73`）共改 15 个文件，全部位于服务端逻辑层（`open-sse/`、`src/lib/db/`、
`src/shared/utils/` 纯函数、`tests/`），**未触及 UI 层，未新增用户可见文案**。

新增的英文串经逐条判定均不面向用户：

- 模块路径、内部枚举值（`MALFORMED_FUNCTION_CALL`、`tool-call`、`response.completed`）
- Headroom 诊断文案 —— 消费链为 `setDiagnostic` → `chatCore.js` 的
  `log?.warn?.("HEADROOM", ...)` → 服务端日志，`diagnostics.reason` 无任何 UI 读取方
- 测试夹具
- `Upstream SSE stream failed` —— 作为 HTTP 错误响应体返回给 API 调用方，
  属机器可读响应而非面板文案；同类的既有串 `Invalid JSON response from ${provider}`
  同样未入典
- `LLM` —— bulk-add 产出的**连接名称**前缀（`LLM 1`、`LLM 2`），作为用户数据
  存入数据库，不是 UI 标签；`baseName` 在 `src/app/**` 下无任何引用，且连接名
  是用户可编辑标识符，翻译它会导致同一账号在不同语言下显示不同名字
