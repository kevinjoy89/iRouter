## 1. 缓冲与解析

- [x] 1.1 `CONSOLE_LOG_CONFIG.maxLines` 200 → 5000（服务端环形缓冲与客户端上限共用）
- [x] 1.2 新增 `src/lib/consoleLogParser.js`：`parseLogLine`（时间/图标/TAG/文本/级别）+ `matchesFilters`（级别集合 + 大小写不敏感 query）+ `LOG_LEVELS`；验证：tests/unit/console-log-parser.test.js 10 用例通过

## 2. 前端重写

- [x] 2.1 `ConsoleLogClient.js` 重写：SSE 缓冲写入 logsRef（rAF 节流渲染）、虚拟滚动（行高 18px + overscan 30）、级别 chips、搜索、暂停/恢复（+N 补齐）、智能自动滚动（贴底 <40px 跟随 + 回底按钮）、连接状态灯、行数统计、复制全部、清空；验证：next build 通过（见打包流程）
- [x] 2.2 多语言：9 条 UI 文案入字典（Pause/Resume/Clear/Copy All/Connected/Connecting…/Search logs…/lines/No console logs yet.）；验证：条目数 zh-CN 1858、zh-TW 878

## 3. 提交与打包

- [x] 3.1 外层仓库提交
- [ ] 3.2 重打 dmg（待办）
## 4. 真机反馈修正（v0.0.2 验收）

- [x] 4.1 布局：console-log 纳入 DashboardLayout 满高分支（内容区不整体滚动），日志区改为 flex-1 内部滚动，尺寸随窗口剩余空间自适应；工具条与日志区之间补间距
- [x] 4.2 级别识别：无时间戳行按文本标记识别（`⨯/✗/×` 开头、`Error:`、`Warning:`、`Debug:` 等）；行内改用级别标签（ERROR/WARN/INFO/DEBUG/LOG）显示，旧级别 emoji 不再重复渲染（会话色点等有信息量的图标保留）
- [x] 4.3 验证：parser 单测 13 用例通过；真实数据目录副本起网关，SSR `/dashboard/console-log` 返回 200
- [x] 4.4 复制通道修正（真机反馈）：根因 = 壳层隐藏 Edit 顶栏菜单，macOS 选区复制无键等效可用。改为原生方案：右键上下文菜单（role copy/cut/paste/selectAll，适配选中/可编辑态）+ before-input-event 显式接管 Cmd/Ctrl+C/V/X/A；撤掉"复制选中"按钮（与原生路径重复），保留复制全部与每行悬浮复制
