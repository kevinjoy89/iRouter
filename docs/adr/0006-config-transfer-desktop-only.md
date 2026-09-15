# 配置导出/导入只在壳层设置里，且只覆盖配置层

「下载备份 / 导入备份」从网关设置（`/dashboard/profile` 的 Local Mode 卡片）迁入壳层设置模态框，并改称「配置导出 / 导入」。

**为什么搬进模态框就等于桌面专属。** 设置模态框由壳层主进程经 IPC 唤起（`desktop/preload.js` 的 `onOpenSettings` → `ShellSettingsHost`），浏览器形态没有 preload，模态框永不打开。所以这次搬迁不是「换个入口」，而是**把该能力从浏览器形态移除**。这是刻意的：iRouter 的产品面是桌面应用，浏览器形态逐步废除；两处并存会让「两个设置」的混乱原样复制到数据操作上，并造出两个真相源。

**为什么密码是就地输入行，而不是第二个模态框。** 该接口需要一次密码再确认（`verifyDashboardPassword`），原实现弹第二个 `Modal`。搬进模态框后两者会嵌套，而 `Modal.js` 的 Escape 监听挂在 document 上、`document.body.style.overflow` 由各自独立写入——叠加的结果是按一次 Escape 关掉两个、内层卸载清掉外层的滚动锁。就地输入行不开第二个模态框，三个问题一并消失。

**为什么改称「配置」而不是「备份」。** 仓库里已有另一个 backup：`src/lib/db/backup.js`，schema 迁移前的 SQLite 快照，自动触发、只留三份、**无恢复路径**。而导出的是 JSON，覆盖设置、供应商连接（含凭据）、供应商节点、代理池、API key、组合模型、模型别名/自定义模型/pricing 等**配置层**若干张表，**不含** usage 与 requestDetails。也就是说「导入」替换的是配置，用量与请求日志原样保留，它不是回到某个时间点。沿用「备份」会让用户期待完整回滚，而代码不提供。

Status: accepted

Considered Options:

- **桌面专属（选定）** / 两处并存 / 给浏览器补一个入口：见上，单一真相源优先于覆盖面
- **就地密码行（选定）** / 嵌套模态框（需给 `Modal` 加堆叠支持）/ 走 IPC 用 CLI 令牌跳过密码：最后一项要拿掉一个刻意的安全闸门（备份是敏感操作，密码是它的再确认），不为省一个输入框而丢
- **改称配置导出/导入（选定）** / 保留 Backup：准确性与「schema 安全备份」的区分优先于用词熟悉度

Consequences:

- 浏览器形态（含 Docker 部署）不再能导出/导入配置。要放开需另立决策，不是本次的疏漏
- 未登录时该段禁用并说明原因：模态框挂在 root layout，登录页也能开，而该接口在 `ALWAYS_PROTECTED`，无 JWT 一律 401，本机也不免
- 导入后立即失效组合轮换与 DLP 已知密钥缓存（`resetComboRotation` / `invalidateKnownSecrets`）。此前导入只重放 outbound proxy，导入新组合或规则要重启网关才生效。代价是这两处缓存从此需与 `PATCH /api/settings` 同步维护
- 界面显示的数据库路径改为由网关回报的真实值。原先硬编码 `~/.irouter`，只在桌面形态正确（上游默认是 `~/.9router`）