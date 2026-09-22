# 贡献指南 (Contributing to iRouter)

感谢您对 **iRouter** 的关注与支持！iRouter 是 9Router 的跨平台独立桌面版，基于上游 [decolua/9router](https://github.com/decolua/9router) 定制开发。

为了保证代码质量与长期可维护性，请在提交代码前阅读以下规范。

---

## 架构概览

```
iRouter/
├── src/ open-sse/ tests/ cli/   # 9Router 网关源码（基于上游基线定制，独立维护）
├── desktop/                     # 桌面壳层：Electron 主进程、托盘、窗口、打包与单实例管理
│   ├── main.js                  # Electron 主进程入口与进程生命周期
│   ├── settings.js              # 壳层独立配置与持久化
│   ├── scripts/                 # 打包与自动化冒烟测试脚本
│   └── resources/               # 应用图标等静态资产
├── openspec/                    # 功能规格与变更记录（包含上游同步记录）
├── docs/adr/                    # 架构决策记录（Architecture Decision Records）
└── CONTEXT.md                   # 核心术语与定义
```

- **壳层与网关边界**：壳层位于 `desktop/`，负责窗口、托盘、单实例与守护子进程；网关服务运行在本地回环地址 `127.0.0.1:20128`，两者通过进程边界和 HTTP 协议解耦交互。
- **数据目录隔离**：网关核心数据存储在 `~/.irouter`（包含 SQLite 数据库与凭据），Chromium 缓存位于系统 `userData` 目录，两者完全隔离。

---

## 本地开发指南

### 前置环境要求
- Node.js >= 18（推荐 Node 20+）
- npm

### 启动开发环境
```bash
# 1. 安装根目录与桌面端依赖
npm install
cd desktop && npm install --include=dev

# 2. 构建内嵌网关并启动桌面开发实例
npm run dev
```

### 运行自动化冒烟测试
```bash
cd desktop

# 运行端到端冒烟测试（隔离临时数据目录）
npm run smoke

# 首次运行导入流程验证
npm run test:import

# 单实例互斥验证
npm run test:instance
```

---

## 代码与提交规范

### 提交信息规范 (Conventional Commits)
所有 Git Commit 必须遵循 Conventional Commits 规范：
- `feat(...)`: 新功能
- `fix(...)`: Bug 修复
- `chore(...)`: 构建脚本、依赖更新、版本发布
- `docs(...)`: 文档更新
- `refactor(...)`: 重构
- `test(...)`: 测试用例补充与修正

示例：
```bash
git commit -m "feat(desktop): 支持自定义托盘快捷菜单项"
git commit -m "fix(gateway): 修复请求超时后的连接释放问题"
```

### 上游同步机制 (Upstream Sync)
iRouter 定期从上游 [decolua/9router](https://github.com/decolua/9router) 手工合并新版本并保留本地全部定制特性。
相关的同步记录与设计方案统一归档在 `openspec/changes/upstream-sync-*` 与 `docs/` 下。

---

## 报告问题与提出建议

- **Bug 报告**：请在 GitHub Issues 提交，并详细说明复现步骤、操作系统版本、网关端口号与控制台异常日志。
- **功能建议**：欢迎提出关于桌面体验、模型路由优化、脱敏策略等方向的改进建议。
