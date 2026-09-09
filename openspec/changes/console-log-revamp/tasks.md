## 1. 缓冲与解析

- [x] 1.1 `CONSOLE_LOG_CONFIG.maxLines` 200 → 5000（服务端环形缓冲与客户端上限共用）
- [x] 1.2 新增 `src/lib/consoleLogParser.js`：`parseLogLine`（时间/图标/TAG/文本/级别）+ `matchesFilters`（级别集合 + 大小写不敏感 query）+ `LOG_LEVELS`；验证：tests/unit/console-log-parser.test.js 10 用例通过

## 2. 前端重写

- [x] 2.1 `ConsoleLogClient.js` 重写：SSE 缓冲写入 logsRef（rAF 节流渲染）、虚拟滚动（行高 18px + overscan 30）、级别 chips、搜索、暂停/恢复（+N 补齐）、智能自动滚动（贴底 <40px 跟随 + 回底按钮）、连接状态灯、行数统计、复制全部、清空；验证：next build 通过（见打包流程）
- [x] 2.2 多语言：9 条 UI 文案入字典（Pause/Resume/Clear/Copy All/Connected/Connecting…/Search logs…/lines/No console logs yet.）；验证：条目数 zh-CN 1858、zh-TW 878

## 3. 提交与打包

- [x] 3.1 外层仓库提交
- [ ] 3.2 重打 dmg（待办）