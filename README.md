# iRouter

**9Router 的跨平台独立桌面版**——装完是一个真正的 App，窗口里直接是 9Router 面板，不用再开浏览器，也不需要目标机器装 Node。

9Router 源码基于上游 [decolua/9router](https://github.com/decolua/9router)（MIT）**v0.5.69** 定制，位于本仓库根目录（`src/`、`open-sse/`、`tests/`），可自由修改（如思考强度上限降级、限流自动重试）；升级 = 对比上游新版本手工合并。桌面壳层在 `desktop/`。术语见 [CONTEXT.md](./CONTEXT.md)，技术决策见 [docs/adr/](./docs/adr/)。

## 安装（macOS）

1. 打开 `desktop/build/dist/iRouter-0.0.1.dmg`
2. 把 **iRouter** 拖进 `Applications`
3. **首次打开**：应用未做签名与公证，Gatekeeper 会拦。解决办法二选一：
   - 在「应用程序」里 **右键（按住 Control）点 iRouter → 打开 → 再点打开**
   - 或 系统设置 → 隐私与安全性 → 找到被拦截提示 → 点「仍要打开」

之后正常双击即可，不需要再重复这一步。

## 日常使用

| 操作 | 行为 |
| --- | --- |
| 启动 iRouter | 窗口内直接显示 9Router 面板（内嵌网关已就绪） |
| **关闭窗口** | 只是**隐藏到托盘**，网关继续运行；不是退出 |
| 托盘菜单 | 打开面板 / 开机自启（默认关） / 退出 iRouter |
| 托盘退出 | 网关进程一并终止（含其子进程，无残留） |

## 网关地址与外部 CLI 配置

面板和 OpenAI 兼容 API 共用同一个端口：

```
Endpoint:  http://127.0.0.1:20128/v1
API Key:   面板内复制
```

- **默认端口 20128**（与上游 CLI 一致）
- 若 20128 已被占用（例如你的 CLI 正在跑），iRouter 会**自动向上顺延**到下一个空闲端口（如 20129），**绝不杀掉占用进程**；此时请查看**窗口标题或托盘提示**里的实际端口，并同步修改 Claude Code / Codex 等工具里的 endpoint
- 只绑定 `127.0.0.1`，不会把网关暴露到局域网（上游 CLI 默认绑 `0.0.0.0`，这是桌面版的刻意收紧）

## 数据放在哪

| 平台 | 核心数据库与配置路径 | 运行时缓存路径（GPUCache 等） |
| --- | --- | --- |
| macOS | `~/.irouter`（核心：`~/.irouter/db/data.sqlite`） | `~/Library/Application Support/iRouter` |
| Windows | `%USERPROFILE%\.irouter` | `%APPDATA%\iRouter` |
| Linux | `~/.irouter` | `~/.config/iRouter` |

**核心数据与应用卸载隔离**：核心 SQLite 数据库、密钥与配置持久化保存在用户主目录下的 `~/.irouter`，即便偶尔卸载应用或清理系统 Application Support 缓存，您的数据与配置依然完好无损。首次运行自动无感平滑迁移已有数据。

**首次运行**若检测到旧版 CLI 的 `~/.9router`，会弹窗询问是否导入（配置、数据库、密钥；不含 CLI 专用的 `runtime/`）。导入是**复制而非移动**，原数据始终保留，随时可退回 CLI 形态。

**卸载**：托盘退出 → 删除 `iRouter.app` → 删除上面的数据目录。不留任何残余。

## 与 CLI 形态的关系

两者数据目录各自独立，可以共存，但**默认端口相同（20128）**：先启动者拿到 20128，后启动者自动顺延到 20129。但**不要同时连接同一个供应商做 OAuth**，两边各自的数据目录互不同步。

## 开发

```
iRouter/
├── src/ open-sse/ tests/ cli/   # 9Router 源码（基于上游 v0.5.69 定制）
├── desktop/          # 壳层：Electron 主进程 + 构建脚本 + 打包配置
│   ├── main.js
│   ├── scripts/      # build-server / smoke / test-import / test-single-instance / mask-icon
│   ├── resources/    # 源资产（icon.png）
│   └── build/        # 生成产物（gitignore）
├── docs/adr/         # 架构决策记录
├── openspec/         # 规格与变更管理
└── CONTEXT.md        # 术语表
```

常用命令（在 `desktop/` 下，完整手动打包与排错指南见 [docs/PACKAGING.md](./docs/PACKAGING.md)）：

```bash
npm install --include=dev   # 本机 npm 若设了 NODE_ENV=production，必须显式带 --include=dev
npm run build-server        # 构建内嵌网关（根目录 next build，产物拷进 build/gateway/server）
npm run dev                 # 构建 + 启动开发实例
npm run smoke               # 端到端冒烟（隔离数据目录，不碰真实数据）
npm run test:import         # 首次运行导入的 4 场景验证
npm run test:instance       # 单实例验证
npm run dist:mac            # 产出 .dmg
npm run smoke:packaged      # 对打包成品跑冒烟
```

### 三个必须知道的坑

1. **宿主环境变量泄漏**：如果构建环境里残留其他 Next.js 应用的变量（`__NEXT_PRIVATE_STANDALONE_CONFIG`、`PORT`、`HOSTNAME`、`NEXT_DIST_DIR`），`next build` 会**跳过本项目的 `next.config.mjs`**、改用泄漏配置而崩溃（`TypeError: generate is not a function`），或让网关绑到错误端口。`build-server.mjs` 与 `main.js` 都已做环境净化，改动时不要去掉。
2. **electron-builder 的 node_modules 硬排除**：复制 `extraResources` 时，相对路径**恰好为** `node_modules` 的目录会被无条件剔除（`app-builder-lib/util/filter.js`），`filter: ["**/*"]` 也救不回来。所以网关产物必须嵌套一层放在 `build/gateway/server`，打包后落在 `Resources/gateway/server`。
3. **子进程不能直接用主二进制启动**：`spawn(process.execPath, ...)` 在 macOS 会被 LaunchServices 当成独立应用，Dock 上多出一个通用 "exec" 图块（`ELECTRON_RUN_AS_NODE` 与 `__CFBundleIdentifier` 都挡不住）。现改为 spawn `Contents/Frameworks/iRouter Helper.app/Contents/MacOS/iRouter Helper`（其 Info.plist 已声明 `LSUIElement=true`），与 VS Code 跑扩展宿主同一套路。另外网关子进程用 `detached: true` 启动，主进程被强杀时它会孤儿化继续占端口，因此数据目录里有 `.gateway.pid`，启动时先回收孤儿。

## 已知限制

- 未签名、未公证、无自动更新（自用定位）；macOS 之外首次运行会有 SmartScreen / 包管理器提示
- Windows 与 Linux 的打包配置已就位，但**未在实机验证**
- 开机自启基于 Electron 的 login item API，Linux 下需要额外的 `.desktop` 方案，当前不保证生效
- 存储走 `node:sqlite`（Node 内建）或 `sql.js` 回退，不含 `better-sqlite3` 原生模块

## 许可

MIT（与上游一致）。上游 9Router 版权归 [decolua](https://github.com/decolua/9router) 所有。
