## Why

控制台日志页（`/dashboard/console-log`）呈现能力差：缓冲仅 200 行且无条件自动滚底（读历史时被不断拽回底部）、无级别过滤、无搜索、无暂停、无连接状态指示。排障时（如限流重试、思考强度降级）很难定位关键行。参考 llm-retry-proxy 的 logs 页面（SSE + history、虚拟滚动、级别过滤、搜索、暂停、连接状态）做呈现层改造。

## What Changes

- **缓冲扩容**：`CONSOLE_LOG_CONFIG.maxLines` 200 → 5000（服务端环形缓冲与客户端上限共用同一配置）
- **新增解析模块** `src/lib/consoleLogParser.js`：`[时间] emoji [TAG] 文本` 行形状 → 结构化元数据（级别 ❌/💥=ERROR、⚠️=WARN、ℹ️=INFO、🔍=DEBUG、其余=LOG；TAG；时间；正文），纯函数
- **前端重写** `ConsoleLogClient.js`：
  - 虚拟滚动（固定行高 18px + 窗口化渲染，5000 行不卡）
  - 级别过滤 chips（ERROR/WARN/INFO/DEBUG/LOG，可多选开关）
  - 内容搜索（大小写不敏感，输入 `COMBO` 等标签词即按标签过滤）
  - 暂停/恢复（暂停时新行进缓冲不刷视图，恢复一次性补齐并显示 `+N`）
  - 智能自动滚动（贴底才跟随；离底出现"回到底部"悬浮按钮）
  - 连接状态灯（SSE 连接/重连）、行数统计（可见/总量）、复制全部
- **多语言**：页面文案入字典（Pause/Resume/Clear/Copy All/Connected/Connecting…/Search logs…/lines/No console logs yet.，zh-CN + zh-TW）
- 传输层（SSE + consoleLogBuffer + emitter）保持不变

## Capabilities

### New Capabilities

<!-- 无：既有控制台日志能力的呈现层改造 -->

### Modified Capabilities

- `console-log`：呈现层重写与缓冲扩容

## Impact

- `src/lib/consoleLogParser.js`（新增）、`ConsoleLogClient.js`（重写）、`src/shared/constants/config.js`（maxLines）
- 内存代价：5000 行缓冲约数 MB，可接受
- 测试：`tests/unit/console-log-parser.test.js` 10 用例