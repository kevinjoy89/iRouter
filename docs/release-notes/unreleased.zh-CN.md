# Unreleased（未发布变更）

> **只放 v0.4.2（2026-10-09）之后、尚未发布的改动。** 发布某个版本时：把条目整理成
> `vX.Y.Z.zh-CN.md`（+ 英文 `vX.Y.Z.en.md`），在 [README](./README.md) 版本表加一行，
> 然后从这里删掉。
>
> 仓库根原先的 `CHANGELOG.md` 已移除——它是上游 [decolua/9router](https://github.com/decolua/9router)
> 的产物（v0.5.69…v0.5.99 全部历史），本仓只在它顶部累积过一个 `# Unreleased` 段；
> 而那个段里 **v0.3.4–v0.4.2 时期的绝大多数条目其实早已发布**（例如「并行写入丢使用量记录」、
> 「`text-[Npx]` 失效」、「设置面板双栏」都在 `v0.3.4.zh-CN.md` 里），属于重复记录，
> 因此不再搬运——各版本的真实记录见本目录的 `vX.Y.Z` 文件。

---

## Fixes
- **Tray/三平台**: 统一托盘图标并修「深色任务栏上看不到」（用户实机截图：macOS 正常、Win11 深色模式基本看不到、MX Linux 面板上是一团黑）。根因是 `tray.rs` 三平台共用同一张**纯黑 + alpha 的 macOS 模板图**：`icon_as_template` 是 **macOS only**（`tauri tray/mod.rs:295` 文档原文），macOS 会按菜单栏明暗自动反色，所以那边一直对；Windows/Linux **原样绘制**，纯黑图形落在深色任务栏/面板上对比度只有 **1.29:1（Win11 深色 `#202020`）/ 1.66:1（Xfce `#2E3436`）**——等于隐形。现按平台取色：macOS 仍用模板图 + `icon_as_template(true)`；Windows/Linux 用**同一 alpha 轮廓的品牌橙 `#F14B0D`**（应用图标橙色像素中位数，白底 3.65、`#202020` 上 4.46、`#2E3436` 上 3.46，三种底都 ≥3:1）。新增 `assets/tray-color.png` 与两条断言：**可见性**（对三种典型底色算 WCAG 对比度，≥3:1）与**同轮廓**（与模板图逐像素比 alpha，防止只重做一张）。变异验证：橙色图换回纯黑 → 可见性断言红在 `1.29:1`；只改一张的一个像素 → 同轮廓断言红在第 225 像素
- **Linux/打包**: 启动器里显示的是写给开发者的 crate 描述（用户实测 MX Linux 菜单显示「iRouter 桌面壳层（Tauri v2 + Bun sidecar）」）。根因：`.desktop` 的 `Comment` 取自 `bundle.shortDescription`，**不设就回落到 `Cargo.toml` 的 `description`**（tauri-bundler `linux/freedesktop/mod.rs:171`）。现显式设置 `shortDescription: "iRouter 本地智能网关"`，并补 `longDescription`（进 deb 长描述，此前是 `(none)`）；同时把断言加进 CI 的 Linux 包烟测——解包 deb 读 `usr/share/applications/iRouter.desktop`，`Name` / `Comment` 按字面量钉死（只断言"文件在不在"抓不住文案回归）；`bundle.category` 一并补成 `Utility`——此前 `Categories=` 是**空串**，而 freedesktop 要求至少一个主分类，缺了启动器只能把它归到「其他/未分类」，现在连 `Categories=Utility;` 一起断言
- **CI/Desktop**: 桌面壳层的 **Rust 单测在 CI 里此前完全没有覆盖**——`ci.yml` 的回归门禁只跑 `tests/` 下的 vitest，于是「托盘白板」那类只有单测能抓的问题在 CI 全绿的情况下活到了实机验收。四平台矩阵的 `package` job 现在在 gateway 负载与 sidecar staging 之后跑一步 `cargo test --locked`（本机 153 passed；唯一失败的是 `gateway::kills_grandchildren…`，原因是本机沙箱禁止 `ps`，与代码无关）。两个**刻意**不加的开关：不加 `--target`（单测跑宿主三元组，跨架构的 macos-amd64 因此不需要 Rosetta；实测宿主 triple 的 externalBin 缺失不影响编译）、不加 `--release`（`src/shell/selftest.rs` 有两条用例是 `#[cfg(all(test, debug_assertions))]`，release 下会被**静默跳过**——那是「测试在跑，但没跑全」的假绿）
- **Zed/OAuth**: 修「错误密钥的 token 被静默当成有效凭据存下」的真实缺陷——它同时是回归门禁的**概率性假红**（CI 首次跑挂、重跑即绿，`tests/unit/zed-native-auth.test.js :: criterion L` 报 `expected 'done' to be 'error'`）。根因在 `decryptZedAccessToken` 的 PKCS#1 v1.5 兜底分支：v1.5 去填充**没有任何完整性校验**，而 OpenSSL ≥ 3.2 对该路径启用 **implicit rejection**——私钥不匹配时 `privateDecrypt` **根本不抛错**，直接返回随机字节；原先「解出文本不含 U+FFFD 即视为成功」的判据在这堆随机字节上约 **0.8%** 成立（CI 的 Node 22.23.3 / OpenSSL 3.5.8 实测：20000 个错误密钥密文 166 个被接受，长度全落在 0–8 字节，其中还有 `"зO"`、`"gr\u0002"` 这类并非可打印 ASCII 的值）。于是「上一个弹窗留下的密文」会被当成真 token 建出连接。现改为**只接受凭据形状的明文**（≥16 字节、可打印 ASCII 且无空白——真 token 要原样进 `Authorization: <userId> <token>` 头，Zed 自己签发的是 64 字符 base64url，16 是对实测 8 字节垃圾的宽裕余量）；OAEP 路径本身有完整性校验，未改动。修复后同规模复测 **0/20000**。新增 3 条用例：确定性拒绝实测到的垃圾形状、确认合法 V0 token 仍可解（兼容保留）、256 次逐次换密文的错误密钥全部拒绝；变异测试验证过（还原旧逻辑 → 新增用例 2 条立刻失败）
- **Desktop/Windows**: Windows 安装包（`-windows-amd64-installer.exe`）用的是 **NSIS 自带的默认图标**（绿蓝地球），不是应用图标（用户实测截图）。根因是 `tauri.conf.json` 的 `bundle.windows.nsis` 只写了 `installMode`，没写 `installerIcon`——而 Tauri 的 `installer.nsi` 模板里图标是**条件定义**：`!if "${INSTALLERICON}" != ""` → `!define MUI_ICON`，缺省时这个分支不成立，NSIS 就回落到自己的默认图标。已补 `"installerIcon": "icons/icon.ico"`（连带 `uninstallerIcon`，卸载器同理）。用 Tauri 固定的 NSIS 3.11 实测过对照：不设时提取出的图标是 NSIS 默认地球，设成 `icons/icon.ico` 后提取出的是应用图标；也确认了 NSIS 接受这个 6 个尺寸全为 PNG 压缩的 `.ico`
- **Desktop/Windows**: 运行时会多出一个 CMD 窗口（用户实测截图）。根因是壳层 `main.rs` **缺 `windows_subsystem` 声明**：缺了它，release 版被链接成**控制台子系统**程序，Windows 就为它分配一个控制台窗口——标题是 exe 全路径（NSIS `currentUser` 装到 `AppData\Local`，与截图一致），内容正是壳层日志实现打到 stderr 的日志 + `gateway.rs` 转发上来的 sidecar 输出。补上 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`（Tauri 官方模板同款，且用 `not(debug_assertions)` 门控：debug 构建保持控制台，`tauri dev` / `verify-shell.mjs` 照旧看得到日志）。连带一处：`gateway.rs` 的 `taskkill` 补 `CREATE_NO_WINDOW`——壳层不再有控制台后，控制台程序 `taskkill` 会被 Windows **新分配**一个控制台窗口（启动回收孤儿与退出清理各闪一次黑窗）。两处均用真实二进制实测过：父进程为无控制台的 GUI 程序时，默认创建的子进程 `GetConsoleWindow()` 非零且 `IsWindowVisible` 为真（即黑窗），加 `CREATE_NO_WINDOW` 或 `DETACHED_PROCESS` 后均无控制台
