## Context

- 传输层已具备：`consoleLogBuffer`（console.log 补丁 → 环形缓冲 + EventEmitter 批量 flush 100ms/50 行）→ `/api/translator/console-logs/stream`（SSE：init/line/lines/clear + 25s 心跳 + request.signal 清理）
- 呈现层仅 96 行：无条件自动滚底、200 行硬上限、无任何过滤/搜索/暂停
- 参考实现 llm-retry-proxy logs.html：SSE + history since、虚拟滚动、级别过滤、搜索、暂停、连接状态、行数统计

## Goals / Non-Goals

**Goals:**

- 排障体验对齐参考实现：关键行可过滤、可搜索、可暂停细读
- 5000 行缓冲下渲染流畅（虚拟滚动）
- 新 UI 文案全量入字典（zh-CN/zh-TW）

**Non-Goals:**

- 不做磁盘持久化 / history since 回放（运行期实时视图定位；落盘属 usage 职责）
- 不改 SSE 协议与 consoleLogBuffer 事件模型
- 不做按 TAG 的独立下拉过滤（搜索框输入标签词即可覆盖）

## Decisions

1. **行解析纯函数**（`src/lib/consoleLogParser.js`）：`[时间] 图标 [TAG] 文本` → `{time, icon, tag, text, level, raw}`；级别按图标（去 U+FE0F）：❌/💥=ERROR、⚠=WARN、ℹ=INFO、🔍=DEBUG、其余=LOG；解析不可行的行原样归 LOG。
2. **虚拟滚动**：行高固定 18px（`whitespace-pre` 不换行 + 容器横向滚动），滚动窗口化渲染（可见行 + 30 行 overscan），上下 spacer 撑总高。
3. **暂停语义**：暂停仅冻结视图渲染（新行照常进缓冲），恢复一次性补齐；按钮显示 `+N` 表示暂停期间新增行数。
4. **智能自动滚动**：距底 < 40px 视为"贴底"才跟随；离底显示回底悬浮按钮，点击恢复跟随。
5. **解析缓存**：按行字符串缓存解析结果（Map，上限 2×缓冲），滚动重渲染零重复解析。
6. **多语言**：9 条 UI 文案入字典；级别 chips（ERROR/WARN/INFO/DEBUG/LOG）为枚举值不翻译。

## Risks / Trade-offs

- `whitespace-pre` 长行需横向滚动（终端惯例，接受）
- 固定行高虚拟滚动不支持行内换行——长行被裁剪可横向滚动查看
- 5000 行缓冲的过滤为全量线性扫描（每渲染 ~ms 级），可接受

## Migration Plan

无数据迁移。`maxLines` 调整即时生效（缓冲环形裁剪）。

## Open Questions

<!-- 无 -->
