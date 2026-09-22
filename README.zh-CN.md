<div align="center">

# iRouter

**9Router 的跨平台独立桌面版**

[English](./README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/kevinjoy89/iRouter?include_prereleases)](https://github.com/kevinjoy89/iRouter/releases)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](https://github.com/kevinjoy89/iRouter/releases)

</div>

---

**iRouter** 是 9Router 的跨平台独立桌面客户端。安装后是一个原生的桌面应用程序，内置 9Router 控制面板，无需安装系统 Node.js 环境，也无需打开外部浏览器。

网关核心源码基于上游 [decolua/9router](https://github.com/decolua/9router)（MIT）**v0.5.81** 定制与维护，位于仓库根目录（`src/`、`open-sse/`、`tests/`）；桌面 Electron 壳层位于 `desktop/`。术语表见 [CONTEXT.md](./CONTEXT.md)，技术决策详见 [docs/adr/](./docs/adr/)。

---

## ✨ 核心特性

- 🖥️ **原生桌面体验**：基于 Electron 构建，集成托盘常驻、单实例互斥、随系统启动等特性，关闭窗口自动隐藏至托盘，网关服务不间断运行。
- 🎯 **思考强度上限降级与能力感知路由**：主动将模型的 `reasoning_effort` 钳制到服务商声明的接受档位，优先将请求派发至原生支持该思考档位的组合模型成员。
- 🔄 **智能限流重试 (Auto-Retry)**：请求遇限流（429 / 503 / 529）时触发带退避与抖动的自动重试机制，防止 Claude Code / Codex 等 CLI 工具因短暂限流直接报错退出。
- 🛡️ **出站请求脱敏 (DLP)**：转发前检测并改写敏感凭证、私钥、身份证、银行卡等内容，四档模式切换，安全防泄密且引擎保持 fail-open。
- 📊 **用量全量留存与实时刷新**：近 24 小时动态滚动刷新，历史详情无损持久化，状态精准过滤。
- 🔒 **数据目录安全隔离**：核心 SQLite 数据库、密钥与配置持久化保存于用户主目录下的 `~/.irouter`，应用升级、缓存清理与卸载均不影响核心数据；首次运行支持从 CLI 旧版 `~/.9router` 一键安全复制导入。

---

## 🚀 安装与下载

### 方式一：下载预编译安装包（推荐）
前往 [GitHub Releases](https://github.com/kevinjoy89/iRouter/releases) 下载对应平台的最新安装包：
- **macOS**: `iRouter-0.3.0.dmg`
- **Windows**: `iRouter-0.3.0-setup.exe`
- **Linux**: `iRouter-0.3.0.AppImage`

下载后将 **iRouter** 拖入「应用程序（Applications）」即可。

> **macOS 首次打开提示**：
> 个人开源应用未购买苹果开发者企业证书（无公证），macOS Gatekeeper 会弹出安全拦截提示。解决办法二选一：
> 1. 在「应用程序」里 **右键（按住 Control）点击 iRouter → 打开 → 弹窗中再点「打开」**；
> 2. 或进入「系统设置 → 隐私与安全性 → 安全性」，找到拦截记录点击「仍要打开」。
> 仅首次启动需要确认，之后正常双击打开即可。

### 方式二：从源码自主构建
```bash
git clone https://github.com/kevinjoy89/iRouter.git
cd iRouter/desktop
npm install --include=dev

# 构建并打包安装包
npm run dist:mac    # macOS (.dmg)
npm run dist:win    # Windows (NSIS .exe)
npm run dist:linux  # Linux (.AppImage)
```

---

## 💡 日常使用

| 操作 | 行为 |
| --- | --- |
| **启动 iRouter** | 窗口内直接渲染 9Router 面板（内嵌网关已在后台就绪） |
| **关闭窗口** | 窗口隐藏至托盘，本地网关服务继续保持运行；并非退出程序 |
| **系统托盘** | 点击托盘图标可唤出菜单：显示面板 / 开机自启 / 退出应用 |
| **退出应用** | 托盘右键退出，网关后台进程将一并安全终止（无孤儿进程残留） |

---

## 🔌 网关地址与外部 CLI 配置

iRouter 桌面面板与 OpenAI 兼容 API 端点共享统一端口：

```
Endpoint:  http://127.0.0.1:20128/v1
API Key:   在 iRouter 桌面面板中复制
```

- **默认端口 20128**（与上游 CLI 保持一致）。
- **端口顺延机制**：若 20128 端口已被占用，iRouter 会**自动顺延**探测下一个空闲端口（如 20129），**绝不强杀占用端口的外部进程**；请留意应用窗口标题栏或托盘菜单中的实际端口。
- **本地安全绑定**：网关仅绑定 `127.0.0.1` 回环地址，严禁暴露至公网或局域网。

---

## 📂 数据持久化路径

| 平台 | 核心数据库与配置目录 (`DATA_DIR`) | 运行时缓存路径（Chromium 缓存等） |
| --- | --- | --- |
| macOS | `~/.irouter`（核心数据：`~/.irouter/db/data.sqlite`） | `~/Library/Application Support/iRouter` |
| Windows | `%USERPROFILE%\.irouter` | `%APPDATA%\iRouter` |
| Linux | `~/.irouter` | `~/.config/iRouter` |

**完全卸载**：托盘退出应用 → 删除应用程序文件 → 手动删除对应的 `~/.irouter` 目录即可干净移除。

---

## 🛠️ 本地开发与调试

```bash
cd desktop

# 1. 构建内嵌网关并启动桌面开发实例
npm run dev

# 2. 运行端到端自动化冒烟测试
npm run smoke

# 3. 首次数据导入与单实例隔离验证
npm run test:import
npm run test:instance
```

架构决策、技术细节与踩坑要点请参阅 [CONTEXT.md](./CONTEXT.md)、[docs/adr/](./docs/adr/) 与 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 🤝 致谢 (Acknowledgements)

本项目在开源社区多位先驱的贡献与灵感启发下演进，特别致谢：

1. **[decolua/9router](https://github.com/decolua/9router)**：
   - 感谢 decolua 及 9Router 社区为 AI 开发者提供的高效、灵活的通用模型路由网关基石。iRouter 核心网关源码基于 9Router 定制并遵循其 MIT 协议。
2. **[momijineko/llm-retry-proxy](https://github.com/momijineko/llm-retry-proxy)**：
   - 感谢 momijineko 优秀的开源实践。iRouter 深度借鉴并移植了其在**智能限流重试机制 (Auto-Retry)**、**出站数据防泄密脱敏引擎 (Request Redaction / DLP)** 以及**控制台虚拟滚动日志呈现层**的架构理念与核心设计。

---

## 📄 开源许可证 (License)

本项目遵循 **[MIT License](./LICENSE)** 开源协议。
- 上游 9Router 核心组件版权归原作者 [decolua](https://github.com/decolua/9router) 及贡献者所有。
- iRouter 桌面壳层与定制增强功能版权归 [kevinjoy89](https://github.com/kevinjoy89) 及贡献者所有。