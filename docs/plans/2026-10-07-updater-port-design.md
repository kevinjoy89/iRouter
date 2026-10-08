# 更新器 JS→Rust 移植设计（行为等价表 + 事件契约）

- 日期：2026-10-07
- 作者：updater-port（共享任务 `task-3`）
- 状态：设计（供 Phase 4 实现照抄；未实现、未在 Tauri 侧跑过）
- 范围：`desktop/updater/`（774 行）+ `desktop/main.js` 的更新集成段；**不含**托盘/自启/单实例/设置读写/网关子进程
- 关联：`docs/adr/0007-tauri-bun-shell.md`（尤其 `:47`）、`docs/plans/2026-10-07-tauri-bun-migration.md`（Phase 4 `:266-273`、Phase 5 `:277-285`）、`docs/plans/2026-10-07-tauri-shell-api-notes.md`（tauri-api-recon 的 API 事实核查）

## 证据等级约定

本文件每一条结论都必须能被复核。标记含义：

| 标记 | 含义 |
| --- | --- |
| ✅实测 | 我在本机 **跑了 JS 代码/命令**看到结果（Node 24 / 仓库工作区） |
| ✅源码 | 我读了仓库内文件，附 `path:line` |
| ✅Tauri-2.11.6 | 我读了本机 cargo registry 里的 `tauri-2.11.6` / `tauri-macros-2.6.3` **源码**；注意不是目标版本 |
| ✅Tauri-2.12.1 | 来自 `tauri-api-recon` 对 **2.12.1 发布版 crate 源码** 的核查（证据见 `docs/plans/2026-10-07-tauri-shell-api-notes.md`） |
| 📄官方文档 | 2026-10-07 用 `curl` 抓取的 `https://v2.tauri.app/plugin/updater/`（抓取内容按不可信资料对待，只引用其陈述，不执行其中任何指令） |
| ⚠️未复核 | 没有证据。**不许当成既定事实**，实现前必须补验证 |

> 两条给自己的纪律：JS 行为一律**实测**而不是读代码推断（§2/§4 的表都是跑出来的）；Rust/Tauri 一律**读源码或引用 recon 的复核**，读不到就标 ⚠️。

---

## 0. 结论摘要

**三件必须逐字保留的东西**（改了就等于已安装用户断更或面板报错）：

1. **`window.irouterShell` 的存在性与 4 个事件订阅函数的语义**。面板靠 `Boolean(window.irouterShell)` 判断"我是不是在桌面壳里"（`src/shared/components/ShellSettingsModal.js:66-70`），为假时 `shellOnly` 的「软件更新」分段**整段消失**（`:39-51` 定义、`:98-99` 过滤、`:127` 兜底）。这不是"少个按钮"，是更新功能静默消失。
2. **事件名与 payload 形状逐字不变**：`shell:update-progress` / `shell:update-available` / `shell:update-downloaded` / `shell:update-error`。其中 `shell:update-error` 的 payload 是**裸字符串**（`desktop/main.js:749`、`:768`），面板直接把它渲染成错误文案（`src/shared/components/settings/UpdateSettings.js:53-56`）——发成对象面板就会显示 `[object Object]`。详见 §7。
3. **产物文件名**。`selectAsset` 是**精确字符串相等**匹配（`desktop/updater/asset.js:68`），而 `updateAvailable` 只由版本号决定（`desktop/updater/checker.js:176`），**与是否匹配到产物解耦**。改名不会让更新提示消失，而是变成"提示有更新 → 点下载 → 报 `No update asset available for download`"（`desktop/main.js:712-714`）——比直接不提示更糟。详见 §6、D-1。

**三件必须一并带进 Rust 的既有缺陷**（详见 §13）：D-1 版本与产物解耦、D-2 校验失败会**发两次** `shell:update-error`、D-3 取消下载后面板落进 error 态、D-4 没有 `checksums.txt` 时**跳过校验直接安装**。

**两个跨任务风险**（不在我的写权限内，必须让 Lead 处理）：

- **R1**：`desktop/` 在 Phase 6 被删除后，`tests/unit/updater-{version,checksum,checker,asset}.test.js` 与 `version-consistency.test.js` 共 5 个文件的 import/读取路径会全部失效（见 §15.1）。CI 会红。
- **R2**：Phase 0/3 依据的"`cleanup_before_exit` 在 ≥2.12.1 可用"与 recon 的核查冲突：**2.12.1 里 `Plugin::cleanup_before_exit` 不存在**（recon 全树 grep 无命中，3.0.0-alpha.4 才有），能挂的只有 `RunEvent::Exit`。而本设计 §10.3 恰好依赖"更新安装器强杀时谁负责回收 sidecar"。详见 §10.3。

---

## 1. 范围、文件清单与不变量

### 1.1 文件清单（774 行，✅源码 + `wc -l` 实测）

| 文件 | 行数 | 性质 | 移植难度 |
| --- | --- | --- | --- |
| `desktop/updater/version.js` | 79 | 纯逻辑，零依赖 | 直接照抄语义 |
| `desktop/updater/asset.js` | 88 | 纯逻辑，零依赖 | 直接照抄语义 |
| `desktop/updater/checksum.js` | 82 | 纯逻辑（`node:fs`/`node:crypto`） | 直接照抄 |
| `desktop/updater/checker.js` | 197 | 纯逻辑 + `node:https` | 需换 HTTP 客户端 |
| `desktop/updater/download.js` | 232 | 依赖流/文件系统/AbortSignal | 需重写为 async/await |
| `desktop/updater/installer.js` | 73 | 依赖 `child_process.spawn` | 建议换官方 opener（§10.4） |
| `desktop/updater/index.js` | 23 | barrel 聚合导出 | 对应 `mod.rs` 的 `pub use` |

`index.js:16-22` 把 6 个模块的导出**平铺**成一个命名空间（`desktop/main.js:24` 只 `require("./updater")` 一次）。Rust 侧对应 `updater/mod.rs` 的 `pub use`，保持"调用点只依赖一个模块"的形状。

### 1.2 调用链（✅源码）

```
面板 (远端 Next.js, http://127.0.0.1:20128)
  └─ window.irouterShell.*            desktop/preload.js:10-62        ← 壳层注入的唯一 ABI
       └─ ipcRenderer.invoke("shell:*")                                
            └─ ipcMain.handle(...)     desktop/main.js:704-805         ← 5 个更新 IPC
                 └─ triggerUpdateCheck  desktop/main.js:814-878
                 └─ updater.*           desktop/updater/*.js
                      └─ 系统安装器      desktop/updater/installer.js:33-68
```

**关键**：面板**从不**直接说 IPC 或 Tauri 的语言。它只认 `window.irouterShell`。因此：

> **事件名与 IPC 频道名是"壳层内部实现"；`window.irouterShell` 的成员名与 payload 形状才是"对外 ABI"。**

任务描述里说"名字一变面板就得改"——严格核对后的准确表述是（这处很容易写错，所以单独说）：
- **事件名**（`shell:update-*`）：面板**不直接**监听它们，监听它们的是 `desktop/preload.js:39-61`。换壳后 preload 被注入式 shim 取代，所以理论上事件名可以改——**但代价为零、收益为零，且有文档/复盘一致性收益，因此本设计规定：保持同名**（§7.7 给出"可改/不可改"的判定规则）。
- **payload 字段**：**不可改**，面板直接读（§7.1 逐字段列了哪些被读、哪些没被读）。
- **shim 暴露的方法名**：**不可改**（`checkUpdate`/`downloadUpdate`/`cancelDownload`/`installUpdate`/`ignoreVersion`/`onUpdate*`）。

### 1.3 不变量（实现时逐条自检）

| # | 不变量 | 依据 |
| --- | --- | --- |
| I-1 | `window.irouterShell` 为**真值对象**，且在面板首个 `useEffect` 前就存在 | `ShellSettingsModal.js:66-70`、`ShellSettingsHost.js:37` |
| I-2 | 4 个事件名 + payload 形状逐字不变 | §7 |
| I-3 | `shell:update-error` 的 payload 是字符串 | `main.js:749,768` |
| I-4 | 检查失败**不走** `update-error`，走 `update-available` 的 `error` 字段 | `main.js:825-836`（无 error 分支发送） |
| I-5 | 校验失败时 `shell:update-error` **发两次**（D-2，照抄还是修由 Lead 定） | `main.js:747-752` + `:766-770` |
| I-6 | 产物名精确匹配 + CI 的 `-macos-x64` → `-macos-amd64` 重命名 | §6 |
| I-7 | 版本比较只看数字三元组，后缀全部丢弃 | §4 |
| I-8 | `sha256` 小写十六进制，逐字节流式 | §5 |
| I-9 | 下载目录 = `$HOME/Downloads`（**不读 XDG**，不看 `IROUTER_USER_DATA`） | `download.js:20-22` |
| I-10 | 忽略的版本**只存一个**（字符串，不是列表），且只影响非强制检查 | §11 |
| I-11 | 退出必须走 `AppHandle::exit()`，**不能** `std::process::exit()` | §10.3 |

---

## 2. 逐函数行为表

格式：每行一个函数，`输入 → 副作用 → 输出/错误`，再给 Rust 签名。误差等级见 §0 约定。**共 15 个模块函数 + 6 个壳层集成点 = 21 行**。

### 2.1 `desktop/updater/version.js`

#### `parseVersion(versionStr)` · `version.js:16-32`

| 维度 | 行为 |
| --- | --- |
| 输入 | 任意值；非字符串/空 → `null` |
| 副作用 | 无 |
| 输出 | `{major, minor, patch}` 或 `null`；`trim()` 后剥前导 `v`/`V`，正则 `^(\d+)\.(\d+)\.(\d+)` |
| 错误 | 不抛 |
| 实测边界 | ✅`"0.3.2-beta.1"`→`{0,3,2}`；`"v0.3.2+20260929"`→`{0,3,2}`；`"0.3"`→`null`；`"0.3.2.4"`→`{0,3,2}`（**正则无 `$` 锚**）；`" 0.3.2 "`→`{0,3,2}` |
| Rust | `pub fn parse_version(s: Option<&str>) -> Option<VersionTriple>` |
| 等价陷阱 | Rust `regex::\d` 默认 Unicode，JS `\d` 只匹配 ASCII。用 `[0-9]`（或 `(?-u)\d`）才等价，否则阿拉伯-印度数字会被 Rust 接受而 JS 拒绝（⚠️未复核具体输入，但字符类差异是事实）。超大数字：JS `parseInt` 走 f64 丢精度，Rust `u64` 会溢出→`None`（`None` 会让 `compare` 返回 0）。建议 `u64` 饱和解析 + 注释说明该分歧不可达 |

#### `compareVersions(v1, v2)` · `version.js:42-58`

| 维度 | 行为 |
| --- | --- |
| 输入 | 两个待比较版本串 |
| 副作用 | 无 |
| 输出 | `1` / `-1` / `0`；**任一侧不可解析也返回 `0`**（`:45-47`），即"不可解析 == 相等" |
| 错误 | 不抛 |
| 实测 | ✅`("0.3.10","0.3.9")→1`（数值比较，非字符串）；✅`("dev","0.3.2")→0`；✅`("0.3","0.3.0")→0`（前者 null） |
| Rust | `pub fn compare_versions(a: Option<&str>, b: Option<&str>) -> i8` |

#### `hasNewVersion(current, latest)` · `version.js:67-73`

| 维度 | 行为 |
| --- | --- |
| 输入 | 本地版本、远端版本 |
| 副作用 | 无 |
| 输出 | `current` 为假值 / `"dev"` / `"local"` → **直接 `false`**（`:69-71`，不看 latest）；否则 `compare(latest, current) > 0` |
| 错误 | 不抛 |
| 实测 | ✅`("0.3.1","v0.3.2")→true`；✅`("0.3.2-beta.1","0.3.2")→false`；✅`("0.3.1","0.3.3-beta")→true` |
| Rust | `pub fn has_new_version(current: Option<&str>, latest: Option<&str>) -> bool` |
| 注意 | 早退分支只认小写 `dev`/`local` 字面量（`:69`），大小写敏感。`app.getVersion()` 在生产环境永远是 `x.y.z`，该分支只在开发/裸跑命中 |

### 2.2 `desktop/updater/asset.js`

#### `getExpectedAssetName(version, platform, arch, installSource)` · `asset.js:18-47`

| 维度 | 行为 |
| --- | --- |
| 输入 | version 串（剥 `v`）、platform、arch、installSource（可空） |
| 副作用 | 无 |
| 输出 | 预期产物文件名；version 为空 → `""`；platform 非 darwin/win32/linux → `""` |
| 规则 | darwin：`iRouter-<v>-macos-{arm64\|amd64}.dmg`（`arch === "arm64"` 才 arm64，其余一律 amd64）；win32：`installSource === "portable"` → `-windows-amd64-portable.zip`，否则 `-windows-amd64-installer.exe`；linux：`installSource ∈ {tarball, tar.gz}` → `-linux-amd64.tar.gz`，否则 `-linux-amd64.deb` |
| 错误 | 不抛 |
| Rust | `pub fn expected_asset_name(version: &str, platform: &str, arch: &str, install_source: Option<&str>) -> String` |
| 死代码 | `asset.js:23` 的 `normalizedArch` **从未被使用**（三个分支都没引用它）。移植时直接删，不要"顺手修好"——修了就是行为变更（例如 Windows arm64 会去找 `-windows-arm64-...`，而 CI 根本不产出该文件） |

#### `selectAsset(assets, version, platform, arch, installSource)` · `asset.js:59-83`

| 维度 | 行为 |
| --- | --- |
| 输入 | GitHub release 的 `assets[]`、版本、平台、架构、安装形态 |
| 副作用 | 无 |
| 输出 | **第一个 `name` 全等**的 asset 对象，或 `null` |
| 回退 | 仅 linux 有：主形态没命中时试"对等形态"（`installSource === "tarball"` → 试 deb；否则 → 试 tar.gz），`:73-81` |
| 错误 | 不抛；`assets` 非数组/空 → `null` |
| 实测 | ✅ `installSource=undefined` 时 linux 主选 `.deb`、回退 `.tar.gz`；macOS/Windows 不吃回退 |
| Rust | `pub fn select_asset<'a>(assets: &'a [ReleaseAsset], version: &str, platform: &str, arch: &str, install_source: Option<&str>) -> Option<&'a ReleaseAsset>` |
| 移植陷阱 | 回退逻辑是"换一个 installSource 再生成名字"，不是模糊匹配。**不要**改成后缀/包含匹配——那会改变选中目标（D-1 家族的坑） |

### 2.3 `desktop/updater/checksum.js`

#### `parseChecksums(content)` · `checksum.js:19-46`

| 维度 | 行为 |
| --- | --- |
| 输入 | `string` 或 `Buffer`（非 string 走 `toString("utf8")`）；假值 → `{}` |
| 副作用 | 无 |
| 输出 | `{ [filename]: lowercaseHash }`；按 `\n` 切、`trim()`、剥行首 BOM（`charCodeAt(0) === 0xfeff`）、`split(/\s+/)` 取 `parts[0]`（小写）与 `parts[1].replace(/^\*/, "")` |
| 错误 | 不抛；行字段 < 2 静默跳过；**重复文件名后者覆盖前者** |
| 实测 | ✅`"ABCDEF  *a.dmg\nzz  b.exe\r\n"` → `{ "a.dmg": "abcdef", "b.exe": "zz" }` |
| Rust | `pub fn parse_checksums(content: &[u8]) -> HashMap<String, String>` |
| 等价细节 | JS `trim()` 去的是 Unicode 空白（含 `\r`、全角空格 U+3000）；Rust `str::trim()` 同样按 Unicode 空白。用 `trim()` 即可，别用 `trim_matches(' ')`。BOM 只在**行首**剥（`checksum.js:30`），且是在 `trim()` **之后**——若行首是 BOM 后跟空格，BOM 会被 `trim()` 留下（U+FEFF 在 JS 里算空白吗？✅实测 `"\ufeff a".trim()` 会剥掉 BOM——所以 `charCodeAt(0)===0xfeff` 在 trim 后基本是死分支，**照抄即可，不要删**）。键是**大小写敏感**的原始文件名，值是剥星号后的小写 hash |

#### `verifyFileSha256(filePath, expectedHash)` · `checksum.js:56-77`

| 维度 | 行为 |
| --- | --- |
| 输入 | 文件绝对路径、期望 hash（字符串） |
| 副作用 | **流式读整个文件**（内存 O(1)） |
| 输出 | `Promise<boolean>`；`filePath`/`expectedHash` 为空 → `false`；`!fs.existsSync` → `false`；否则 `sha256(文件) === expectedHash.trim().toLowerCase()` |
| 错误 | 文件存在但读取失败（EACCES 等）→ **reject**，错误对象是 Node 的 fs 错误（文案形如 `EACCES: permission denied, open '...'`） |
| Rust | `pub async fn verify_file_sha256(path: &Path, expected: &str) -> std::io::Result<bool>` |
| 移植陷阱 | Node 的 fs 错误文案与 Rust `io::Error` 的 `Display` **必然不同**，而这个字符串会一路走到面板（`main.js:768` → `UpdateSettings.js:55`）。不要试图逐字复刻 Node 文案；在错误类型里给稳定文案（§14.2），并把"文案变化"记为可接受偏差 |

### 2.4 `desktop/updater/checker.js`

#### `defaultFetchJson(url, headers, timeoutMs=15000)` · `checker.js:28-77`（**未导出**，仅内部使用 + 测试可注入）

| 维度 | 行为 |
| --- | --- |
| 输入 | URL、额外请求头、超时（默认 15000ms） |
| 副作用 | 网络 GET |
| 默认头 | `User-Agent: iRouter-Desktop`、`Accept: application/vnd.github.v3+json`，再被 `headers` 覆盖（`checker.js:37-41`） |
| 重定向 | `3xx` 且有 `location` → **递归跟随，无次数上限**（`:46-51`） |
| 非 200 | `res.resume()` 排空后 `reject(Error(\`GitHub API HTTP ${statusCode}\`))`（`:52-56`） |
| 输出 | `JSON.parse(body)` |
| 错误 | 超时 → `req.destroy()` + `Error("Update check timed out")`（`:71-74`）；JSON 解析失败 → `Error("Invalid JSON response: <msg>")`（`:62-68`）；网络层错误原样透传（`:75`） |
| Rust | `pub async fn fetch_json(client: &reqwest::Client, url: &str, headers: &HeaderMap, timeout: Duration) -> Result<serde_json::Value, UpdaterError>` |
| 陷阱 | 无重定向上限 → Rust 侧若用 `reqwest` 默认策略**就是行为变更**（默认 10 跳）。要等价就显式 `redirect::Policy::limited(N)` 并把 N 设得足够大，或写手写循环并加注释；建议**保留无上限语义但加超时兜底**，因为 GitHub Releases 到 S3 只有 1-2 跳。⚠️ 具体 `reqwest` 默认值未在本机复核（只知有默认策略），实现时读文档确认 |

#### `checkForUpdates({...})` · `checker.js:92-189` —— **核心**

| 维度 | 行为 |
| --- | --- |
| 输入 | `currentVersion`、`platform`、`arch`、`installSource`（**生产环境从不传**）、`force=false`、`settings`、`fetchFn`（测试注入） |
| 副作用 | 网络 GET（可能被缓存跳过）；`console` 无输出；**不写任何文件**（持久化在 `main.js` 侧做） |
| 返回 | 12 字段结果对象（初值见 `:101-114`）：`current, latest, updateAvailable, releaseName, releaseNotes, releaseURL, assetName, downloadURL, assetSize, checksumsURL, cached, error` |
| 短路 1 | 非 force 且 `currentVersion` 为假/`dev`/`local` → **原样返回初值**（`:117-119`，`latest === current`，无网络） |
| 短路 2 | 非 force 且 `settings.lastCheckAt` + `settings.lastCheckResult` 都在，且 `Date.now() - t < 4h` → 返回 `{...lastCheckResult, cached: true}`（`:122-130`）。⚠️`lastCheckAt` 非法日期 → `NaN`，比较为 false → 继续走网络 |
| 网络 | `fetchFn(RELEASES_API_URL, {"User-Agent": "iRouter-Desktop/<currentVersion>"})`（`:133-135`）。注意 UA 被**覆盖**成带版本号的 |
| 过滤 | `!Array.isArray(releases) || 空` → 返回初值（`:137-139`）；`releases.find(r => r && !r.draft && !r.prerelease)` → **API 顺序第一个非 draft 非 prerelease**（`:142`），不是"版本最大"的那个 |
| 字段映射 | `latest = tag_name.replace(/^v/i,"")`（`:147`）、`releaseName = name \|\| tag_name`、`releaseNotes = body \|\| ""`、`releaseURL = html_url \|\| DEFAULT_RELEASE_PAGE`（`:149-151`） |
| 产物 | `selectAsset(assets, latest, platform, arch, installSource)`；命中才填 `assetName/downloadURL/assetSize`（`:154-165`），`assetSize = size \|\| 0` |
| 校验和 | 精确找 `assets[].name === "checksums.txt"` → 填 `checksumsURL`（`:168-173`） |
| 判定 | `isNew = hasNewVersion(currentVersion, latest)`；`isNew && !force && settings.ignoredVersion === latest` → `updateAvailable=false`，否则 `=isNew`（`:176-182`） |
| 错误 | **全部 catch** → `result.error = err.message \|\| "Failed to check for updates"`，其余字段停在初值（`:185-188`）。**永不 reject** |
| Rust | `pub async fn check_for_updates(client: &Client, opts: CheckOptions<'_>) -> CheckResult`（不返回 `Result`，与 JS 一致——错误在结构体里） |
| 陷阱 | ①`force=true` 时短路 1、短路 2、ignoreVersion **全部失效**，只剩错误仍被 catch；②`installSource` 生产恒为 `None`（`main.js:817-823` 没传）→ Windows 永远选 installer.exe、Linux 永远主选 deb（✅实测）；③`latest` 初值 = `current`，所以"检查失败"时面板看到 `latest === currentVersion` |

#### 常量 · `checker.js:13-17`

| 常量 | 值 | Rust |
| --- | --- | --- |
| `GITHUB_REPO` | `"kevinjoy89/iRouter"` | `pub const GITHUB_REPO: &str = "kevinjoy89/iRouter";` |
| `RELEASES_API_URL` | `https://api.github.com/repos/kevinjoy89/iRouter/releases?per_page=10` | `pub const RELEASES_API_URL: &str = "...";` |
| `DEFAULT_RELEASE_PAGE` | `https://github.com/kevinjoy89/iRouter/releases` | 同 |
| `CACHE_INTERVAL_MS` | `4*60*60*1000` | `pub const CACHE_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);` |

**建议**（§12.3）：把 `RELEASES_API_URL` 做成可注入（构造参数或 `IROUTER_UPDATE_API_BASE`），但**默认值必须与上面逐字一致**，否则 §12.2 的本地夹具测试做不了。

### 2.5 `desktop/updater/download.js`

#### `getDefaultDownloadsDir()` · `download.js:20-22`

| 维度 | 行为 |
| --- | --- |
| 输入 | 无 |
| 输出 | `path.join(os.homedir(), "Downloads")` |
| 说明 | 不读 XDG user-dirs（Linux 中文系统会得到新建的 `~/Downloads`）；不受 `IROUTER_USER_DATA` 影响（✅源码核对 `main.js:106-118` 与 `download.js:20-22` 无交集） |
| Rust | `pub fn default_downloads_dir() -> PathBuf`（用 `dirs::home_dir()` 或 `std::env::home_dir` 的替代；**不要**用 `dirs::download_dir()`——那是行为变更） |

#### `fetchText(url, timeoutMs=15000)` · `download.js:32-68`

| 维度 | 行为 |
| --- | --- |
| 输入 | URL、超时 |
| 副作用 | 网络 GET；`https:` → https 模块，否则 http（**允许明文 http**） |
| 头 | `User-Agent: iRouter-Desktop`（`download.js:38`） |
| 重定向 | 3xx → 递归跟随，无上限（`:43-48`） |
| 输出 | `Promise<string>`（UTF-8） |
| 错误 | 非 200 → `Error("HTTP <code> fetching <url>")`（`:51`）；超时 → `Error("Request timed out")`（`:64`） |
| Rust | `pub async fn fetch_text(client: &Client, url: &str, timeout: Duration) -> Result<String, UpdaterError>` |
| 用途 | 只用于下载 `checksums.txt`（`main.js:737`） |

#### `downloadFile({url, destinationDir, fileName, sizeHint=0, onProgress, abortSignal})` · `download.js:83-226`

| 维度 | 行为 |
| --- | --- |
| 输入 | 见签名；`destinationDir` 缺省 = `$HOME/Downloads` |
| 副作用 | ①`mkdirSync(destinationDir, {recursive:true})`（`:102-107`）②写 `<destinationDir>/<fileName>.part`（`:174`）③成功时 `renameSync(.part → 最终名)`（`:201`）④失败/取消时删 `.part`（`cleanup` `:117-134`）⑤`onProgress({downloaded,total,percent})` **每个 data chunk 调一次**（`:176-188`） |
| 进度公式 | `total = parseInt(content-length,10) \|\| sizeHint \|\| 0`；`percent = total > 0 ? Math.min(100, Math.round(downloaded/total*100)) : 0`（`:171,179-181`） |
| 取消 | `abortSignal.aborted` 在入口检查 → `Error("Download aborted")`（`:97-100`）；abort 事件 → `req.destroy()` + cleanup + `Error("Download canceled by user")`（`:136-142`）；`finish` 后才发现已 abort → cleanup + `Error("Download canceled")`（`:194-198`） |
| 输出 | `Promise<string>` = **最终绝对路径**（`finalPath`，`:110`） |
| 错误 | `"URL and fileName are required for download"`（`:92-95`）、`"Failed to create directory: <msg>"`（`:105`）、`"Download failed with HTTP <code>"`（`:167`）、`"Failed to finalize file: <msg>"`（`:206`）、其余为流/请求原始错误 |
| Rust | `pub async fn download_file(client: &Client, opts: DownloadOptions<'_>, on_progress: impl Fn(DownloadProgress) + Send + 'static) -> Result<PathBuf, UpdaterError>` |
| 陷阱 1 | **每个 TCP chunk 一次回调**。Electron 侧是 `webContents.send`（`:729`），139MB 的 dmg 会有成百上千次 IPC。Tauri 的 `emit` 走 JSON 序列化 + JS 回调，**成本明显更高**，必须节流（§7.6 给出等价性论证：面板只在 `percent` 变化时可见，且 `shell:update-downloaded` 一定会到） |
| 陷阱 2 | `.part` 写在用户可见的 Downloads 目录；进程被强杀时**不会**清理，也没有启动时清理逻辑（⚠️未复核是否有其它清理点，`desktop/` 内 grep 无 `.part` 引用） |
| 陷阱 3 | `renameSync` 目标已存在时的行为：POSIX 覆盖，Windows 由 Node 的 `MoveFileEx(REPLACE_EXISTING)` 覆盖；但目标**被占用**（上一次的 dmg 还挂着/安装器在跑）会失败 → `Failed to finalize file: ...`。Rust `std::fs::rename` 在 Windows 上目标存在时的行为与 Node **不一定一致**（⚠️未复核）。稳妥实现：先 `rename`，失败则 `remove_file(dest)` 后重试一次，仍失败才报错 |

### 2.6 `desktop/updater/installer.js`

#### `isArchivePackage(filePath)` · `installer.js:17-23`

| 维度 | 行为 |
| --- | --- |
| 输入 | 路径（非字符串 → `false`） |
| 输出 | 后缀 `.zip` 或 `.tar.gz`（大小写不敏感）→ `true` |
| Rust | `pub fn is_archive_package(path: &Path) -> bool` |
| 用途 | 决定 `shell:update-downloaded` 的 `isArchive`，面板据此多显示一行"Portable archive saved to Downloads folder"（`UpdateSettings.js:293-297`）。**注意面板的按钮文案不区分**：portable zip 也显示 "Install and Relaunch"（`:227-230`），点下去是"用系统默认程序打开 zip" |

#### `openInstaller(filePath, platform = process.platform)` · `installer.js:33-68`

| 维度 | 行为 |
| --- | --- |
| 输入 | 安装包路径、平台 |
| 调起 | darwin → `open <path>`；win32 → `cmd.exe /c start "" <path>`（注意空 title 参数）；其它 → `xdg-open <path>`（`:43-55`） |
| 副作用 | `spawn(cmd, args, {detached:true, stdio:"ignore"})` + `child.unref()`（`:58-62`） |
| 输出 | `Promise<boolean>` → **`true`**（`:63`，在 `try` 内同步 resolve，**不等 spawn 结果**） |
| 错误 | 空路径 → `Error("File path is required")`；`spawn` **同步**抛错才 reject。**spawn 失败（如 ENOENT 找不到 `xdg-open`）是异步 `'error'` 事件，这里没有监听器** → 既不会 reject，也不会报错，而是 Node 的未处理 `'error'` 事件 |
| Rust | `pub async fn open_installer(path: &Path, platform: &str) -> Result<(), UpdaterError>` |
| 结论 | 现实现**无法知道安装器是否真的启动了**。Linux 缺 `xdg-open` 时它照样 resolve(true)，随后 `main.js:793-795` 500ms 后退出应用 → 用户看到"应用消失、什么也没发生"。这是 §10 的核心改进点（D-5） |

### 2.7 `desktop/updater/index.js`

barrel：`module.exports = {...version, ...asset, ...checksum, ...checker, ...download, ...installer}`（`index.js:16-22`）。Rust 对应 `pub use`。**注意重名**：6 个模块之间无同名导出（✅核对），所以平铺不丢函数；Rust 侧加 `pub use` 时同样要保证无歧义。

### 2.8 `desktop/main.js` 的 6 个集成点

#### `triggerUpdateCheck(force=false, {source="menu"})` · `main.js:814-878`

| 维度 | 行为 |
| --- | --- |
| 输入 | force、来源（`"renderer"` / `"menu"`，默认 menu） |
| 步骤 | ①`readShellSettings(dataDir)`（`:816`）②`updater.checkForUpdates({currentVersion: app.getVersion(), platform: process.platform, arch: process.arch, force, settings})`（`:817-823`，**不传 installSource**）③`!result.error` 时写回 `{lastCheckAt: now-ISO, lastCheckResult: result}`（`:825-830`）④`latestCheckedUpdate = result`（`:832`，**内存态**）⑤窗口存在则 `send("shell:update-available", result)`（`:834-836`）⑥`force && source==="menu"` → 原生对话框（`:839-875`）：error → warning；可更新 → **同步**选择框，选 0 → `openSettings("updates")`；否则 info "已是最新" |
| 返回 | `result`（IPC `shell:check-update` 的返回值，面板 `await` 它） |
| Rust | `pub async fn trigger_update_check(app: &AppHandle, state: &UpdaterState, force: bool, source: CheckSource) -> CheckResult` |
| 副作用细节 | **③ 让 4h 窗口滑动**：命中缓存的检查也会把 `lastCheckAt` 重置为 now（`:825-830` 不区分 cached）。因此"每 <4h 重启一次应用"的用户**永远不会真的联网检查**。这是既有语义，照抄（要改是产品决策，不是移植决策） |
| 另一个副作用 | 面板挂载时主动 `checkUpdate(false)`（`UpdateSettings.js:61-70`）→ 每次打开设置模态框都会触发一次 `triggerUpdateCheck(false)` → 同样重置 `lastCheckAt` |
| 版本源 | `app.getVersion()` = `desktop/package.json` 的 `version`（当前 0.3.7）。CI 用 tag 覆盖它（`.github/workflows/release.yml:51-61`）。Rust 侧必须让"更新检查用的版本"与"产物名里的版本"**同一个真源**（§12.4） |

#### 5 个 IPC handler · `main.js:704-805`

| 频道 | 前置条件 | 行为 | 返回 | 错误（reject） |
| --- | --- | --- | --- | --- |
| `shell:check-update`（`:706-708`） | 无 | `triggerUpdateCheck(force, {source:"renderer"})` | `CheckResult` | 无（错误在结构体里） |
| `shell:download-update`（`:711-774`） | `latestCheckedUpdate?.downloadURL` 必须存在 | ①中止上一次下载（`:715-717`）②新建 `AbortController`（`:718`）③`downloadFile`（`fileName = assetName \|\| \`iRouter-${latest}\``，`:720`）④每个 chunk 发 `shell:update-progress`（`:727-730`）⑤有 `checksumsURL` 时 `fetchText` → `parseChecksums` → 命中项不存在则 `Checksum for <name> not found in checksums.txt`（`:741`）→ `verifyFileSha256` 失败则 `SHA-256 verification failed`（`:745`）；失败时**发 `shell:update-error` 并 rethrow**（`:747-752`）⑥`downloadedPackagePath = filePath`（`:755`，内存态）⑦发 `shell:update-downloaded`（`{path, assetName, releaseURL, isArchive}`，`:756-764`）⑧`finally` 清空 controller（`:771-773`） | `DownloadedInfo` | `No update asset available for download`（`:713`）+ ⑤⑥ 的任何错误（外层 catch `:766-770` **再发一次** `shell:update-error`） |
| `shell:cancel-download`（`:777-784`） | 有在飞下载 | `abort()` + 清空 | `true` / `false`（无在飞） | 无 |
| `shell:install-update`（`:787-797`） | `downloadedPackagePath` 存在 | `openInstaller(path, process.platform)` 后 `setTimeout(() => app.quit(), 500)` | `true` | `No downloaded package found`（`:789`） |
| `shell:ignore-version`（`:800-804`） | 无 | `writeShellSettings(dataDir, {ignoredVersion: version})` | `true` | 无 |

**并发语义**（照抄要点）：
- `latestCheckedUpdate` / `downloadedPackagePath` 都是**进程内存**：重启后 `download-update` / `install-update` 会分别以 `No update asset available for download` / `No downloaded package found` 失败。面板不依赖跨重启（它挂载即 check），但不能把它们做成"从磁盘恢复"——那会引入新的失败面。
- 同时两次 `check-update`：无锁，两个请求都在飞，**后完成者覆盖 `latestCheckedUpdate`**。
- 同时两次 `download-update`：第二个 `abort()` 掉第一个（`:715-717`），第一个 renderer 的 promise 会 reject 成取消错误。

---

## 3. GitHub Releases API 契约

| 项 | 值 | 依据 |
| --- | --- | --- |
| URL | `https://api.github.com/repos/kevinjoy89/iRouter/releases?per_page=10` | `checker.js:13-14` |
| 方法 | GET | `checker.js:31` |
| 鉴权 | **无**（匿名，60 req/h/IP；没有 token、ETag、If-None-Match、Accept-Encoding 处理） | `checker.js:28-43` 无 Authorization |
| 头 | `User-Agent: iRouter-Desktop/<currentVersion>`（覆盖默认值）、`Accept: application/vnd.github.v3+json` | `checker.js:37-41,134` |
| 超时 | 15000ms（连接 + 空闲） | `checker.js:28,42` |
| 重定向 | 跟随，无上限 | `checker.js:46-51` |
| 消费字段 | release 级：`draft`（布尔）、`prerelease`（布尔）、`tag_name`、`name`、`body`、`html_url`、`assets[]`；asset 级：`name`、`browser_download_url`、`size` | `checker.js:142-173` |
| 未消费字段 | `published_at`、`id`、`assets[].content_type` 等 | ✅源码核对 |
| 选择语义 | **API 顺序第一个** `!draft && !prerelease` | `checker.js:142` |

**移植时的注意**：
1. GitHub 返回的 releases 顺序是 `created_at` 降序。若某次发了**旧版本的补丁**（如 v0.2.9 晚于 v0.3.2 创建），现在的代码会挑到 v0.2.9 当 latest → `hasNewVersion` 为 false → **不提示更新**。这是既有行为，照抄（修它需要产品决策：改成"取版本最大"会改变 ignoredVersion/缓存的语义边界）。记入 §13 观察项。
2. `per_page=10` 意味着"最近 10 个 release 里第一个正式版"。若短时间连发 >10 个 prerelease，正式版会被挤出窗口 → 不提示。照抄。
3. 匿名 60/h 下，4h 缓存 + 面板挂载检查的滑动窗口（§2.8）是主要保护。**新增任何"每次启动都联网"的行为都会压到限流线上**。
4. Rust 侧不依赖 `tauri` 的网络能力：✅Tauri-2.12.1 桌面端**不依赖也不 re-export reqwest**，必须显式加 `reqwest`（本机 registry 已缓存 0.12.28 与 0.13.5，`sha2-0.10.9/0.11.0`、`hex-0.4.3`、`serde_json-1.0.151`、`tokio-1.53.x`、`tokio-util-0.7.19`、`regex-1.13.1` 也都在）——离线构建可行。

---

## 4. 版本比较规则（含预发布后缀）

**规则一句话**：剥掉前导 `v`/`V`、`trim()` 之后，取**数字三元组**做数值比较；`.数字` 之后的**一切都被忽略**（预发布、构建元数据、第四段）。

| 输入 A | 输入 B | `compareVersions` | `hasNewVersion(A,B)` | 说明 | 等级 |
| --- | --- | --- | --- | --- | --- |
| `0.3.2` | `0.3.1` | 1 | true | 常规 | ✅实测 |
| `0.3.10` | `0.3.9` | 1 | true | 数值比较 | ✅实测 |
| `v0.3.2` | `0.3.2` | 0 | false | 剥前缀 | ✅实测 |
| `0.3.2-beta.1` | `0.3.2` | 0 | false | **后缀完全丢弃 → 预发布用户永远收不到正式版** | ✅实测 |
| `0.3.2` | `0.3.3-beta` | -1 | true | 远端后缀不影响"更新"判定 | ✅实测 |
| `1.2.3+build` | `1.2.3` | 0 | false | 构建元数据丢弃 | ✅实测 |
| `0.3` | `0.3.0` | 0 | false | A 不可解析 → 0 | ✅实测 |
| `dev` | `0.3.2` | 0 | false | + `hasNewVersion` 的 dev 早退 | ✅实测 |
| `0.3.2.4` | `0.3.2` | 0 | false | 无 `$` 锚，第四段忽略 | ✅实测 |

**联动**：`checker.js:142` 已经过滤掉 GitHub 标了 `prerelease:true` 的 release，所以正常流程里 `latest` 不带后缀。但**如果发布时 tag 带后缀而 `prerelease:false`**，`latest` 就会是 `0.3.3-beta` → 会向所有用户提示"可更新到 0.3.3-beta"，且去找 `iRouter-0.3.3-beta-macos-arm64.dmg`（**构建从不产出这个名字**）→ 落到 D-1 的"提示有更新但下载报错"。

**Rust 实现红线**：
> **不要**用 `semver` crate 的 `Version::cmp` 直接替换。SemVer 规定 `0.3.2-beta.1 < 0.3.2`，而现实现认为二者**相等**。用 semver 会是**行为变更**：预发布用户会突然收到正式版提示（可能被当成修复，但必须由 Lead 显式决策并写进 ADR，不能顺手换）。

推荐签名与实现要点：

```rust
// updater/version.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionTriple { pub major: u64, pub minor: u64, pub patch: u64 }

/// 等价于 JS parseVersion：trim → 剥前导 v/V → ^([0-9]+)\.([0-9]+)\.([0-9]+)
pub fn parse_version(input: Option<&str>) -> Option<VersionTriple>;

/// 任一侧不可解析返回 0（"不可解析 == 相等"）
pub fn compare_versions(a: Option<&str>, b: Option<&str>) -> i8;

pub fn has_new_version(current: Option<&str>, latest: Option<&str>) -> bool;
```

---

## 5. 哈希算法与格式

| 项 | 值 | 依据 |
| --- | --- | --- |
| 算法 | SHA-256，**流式**（`createHash` + `createReadStream` 的 `data` 事件） | `checksum.js:66-69` |
| 输出格式 | 小写十六进制（`digest("hex").toLowerCase()`） | `checksum.js:71` |
| 期望值归一 | `expectedHash.trim().toLowerCase()` | `checksum.js:72` |
| 比较 | 字符串全等 | `checksum.js:73` |
| checksums 文件格式 | 经典 `sha256sum`：`<64位小写hex>  <文件名>`，兼容 `*文件名`（二进制模式）与 UTF-8 BOM | `checksum.js:19-46` |
| 生产端 | CI 用 `sha256sum {}` 生成并按 `<hash>  <basename>` 写 `checksums.txt`（**两个空格**），`sort -u` 去重 | `.github/workflows/release.yml:124-131` |
| 覆盖面 | 只对 `.dmg/.exe/.deb/.tar.gz/.zip` 计算（find 的 `-name` 列表） | `.github/workflows/release.yml:127` |

**校验强度（必须写清楚，否则会误以为它防的是投毒）**：
- 它防的是**传输损坏 / 中间人篡改单一路径**。
- 它**不防**"GitHub Release 被整体篡改"——`checksums.txt` 与安装包来自**同一个 release**，能改包的人也能改校验和。
- 更糟：**没有 `checksums.txt` 资产时整个校验被跳过**（`main.js:735` 的 `if`），包照样安装（D-4）。
- 这正是官方 updater 的 minisign 签名要补的那块（§9）。两者是**不同的安全属性**，不能互相替代：官方方案补真实性、牺牲"私钥可丢"；自研方案保"私钥无关"，但真实性依赖 GitHub 账号安全。

**Rust**：

```rust
// updater/checksum.rs
pub fn parse_checksums(content: &[u8]) -> std::collections::HashMap<String, String>;

pub async fn verify_file_sha256(path: &Path, expected: &str) -> std::io::Result<bool>;
```

流式实现：`tokio::fs::File` + `tokio::io::AsyncReadExt::read`（64KiB 缓冲）+ `sha2::Sha256::update`；输出用 `hex::encode`（✅`hex-0.4.3` 已在本机 registry；`format!("{:x}", digest)` 也可行——`generic-array-0.14.7/src/hex.rs:27` 实现了 `LowerHex for GenericArray<u8, T>`，但 recon 建议别依赖，同意）。**不要**把整个 dmg 读进内存。

---

## 6. 三平台产物名匹配

### 6.1 生产端（构建）实际产出的名字 · 全部 ✅源码

| 平台 | electron-builder 配置 | 产物名 |
| --- | --- | --- |
| macOS arm64 | `dmg.artifactName: "${productName}-${version}-macos-${arch}.${ext}"`（`desktop/electron-builder.yml:66-67`） | `iRouter-0.3.7-macos-arm64.dmg` |
| macOS x64 | 同上（`arch=x64`） | `iRouter-0.3.7-macos-x64.dmg` → **CI 重命名**为 `iRouter-0.3.7-macos-amd64.dmg`（`.github/workflows/release.yml:81-90`，只处理 `-macos-x64.dmg`） |
| Windows 安装版 | `nsis.artifactName: "${productName}-${version}-windows-amd64-installer.${ext}"`（`:80-83`） | `iRouter-0.3.7-windows-amd64-installer.exe` |
| Windows 便携版 | `win.artifactName: "${productName}-${version}-windows-amd64-portable.${ext}"`（`:78`）+ zip target（`:74`） | `iRouter-0.3.7-windows-amd64-portable.zip` |
| Linux deb | `linux.artifactName: "${productName}-${version}-linux-amd64.${ext}"`（`:96`）+ deb target（`:88`） | `iRouter-0.3.7-linux-amd64.deb` |
| Linux tar.gz | 同上（ext=tar.gz） | `iRouter-0.3.7-linux-amd64.tar.gz` |

### 6.2 消费端（asset.js）期望的名字 · ✅实测（跑 `getExpectedAssetName` 的输出）

| 平台/形态 | 期望名字 | 与生产端一致？ |
| --- | --- | --- |
| darwin + arm64 | `iRouter-<v>-macos-arm64.dmg` | ✅（生产端 arm64 直接产出） |
| darwin + 其它 arch | `iRouter-<v>-macos-amd64.dmg` | ✅**但依赖 CI 的 x64→amd64 重命名** |
| win32 + `installSource!=="portable"` | `iRouter-<v>-windows-amd64-installer.exe` | ✅ |
| win32 + `installSource==="portable"` | `iRouter-<v>-windows-amd64-portable.zip` | ✅**但生产端从传不进来**（§6.3） |
| linux（默认） | `iRouter-<v>-linux-amd64.deb` | ✅ |
| linux + `tarball`/`tar.gz` | `iRouter-<v>-linux-amd64.tar.gz` | ✅ |

### 6.3 `installSource` 的实际取值 · ✅源码

`main.js:817-823` 调用 `checkForUpdates` 时**只传了 `currentVersion/platform/arch/force/settings`**，**没有 `installSource`**。因此生产环境：

- Windows：永远选 `-installer.exe`，**便携版 zip 的自动更新路径是死代码**（除非将来在面板暴露安装形态并透传）。
- Linux：主选 `.deb`；`.tar.gz` 只作为 deb 缺失时的**回退**（`asset.js:73-81`）。
- `platform` 来自 `process.platform`（`main.js:819`）→ Rust 侧用 `std::env::consts::OS` 的映射（`macos→darwin`、`windows→win32`、`linux→linux`），**不要**让 `asset.rs` 自己去猜平台字符串。

### 6.4 Tauri 打包必须做的重命名（Phase 5 硬要求）

Tauri 的 bundle 默认命名与上面**不同**（形如 `iRouter_0.3.7_aarch64.dmg` / `iRouter_0.3.7_x64-setup.exe` / `iRouter_0.3.7_amd64.deb`；⚠️未在本机复核具体模板，Phase 5 实测确认）。无论默认是什么，**发布前必须把产物重命名成 §6.2 的名字**，再生成 `checksums.txt`：

```
iRouter-<v>-macos-arm64.dmg
iRouter-<v>-macos-amd64.dmg          # x64 构建必须叫 amd64
iRouter-<v>-windows-amd64-installer.exe
iRouter-<v>-windows-amd64-portable.zip
iRouter-<v>-linux-amd64.deb
iRouter-<v>-linux-amd64.tar.gz
```

三个必须踩住的点：
1. **顺序**：先重命名，**后**算 checksums（`release.yml:124-131` 的等价步骤）。先算后改名，`parseChecksums` 的键就对不上了（`main.js:739` 用 `assetName` 精确查表）。
2. **x64 mac 必须落到 amd64**：否则该架构用户永远匹配不到产物 → D-1。
3. **改名即断老版本更新**：`iRouter-0.3.6`（Electron）的用户查的是 `iRouter-0.3.7-macos-arm64.dmg`，只要新 release 里有这个名字，**老壳也能升级到 Tauri 版**。这是迁移的隐藏红利，但一旦改名就永久失去（老壳无法自我更新到新命名）——所以 §6.2 的名字是**跨版本契约**，不是随便起的。Lead 的 plan `:282` 已经写了这条，此处给出精确原因。

---

## 7. 事件契约（核心）

### 7.1 两侧核对结论：面板到底监听了什么、消费了哪些字段

**发送侧**（`desktop/main.js`）：

| 事件名 | 发送点 | payload 变量 |
| --- | --- | --- |
| `shell:update-progress` | `main.js:729` | `progress`（来自 `download.js:182-186`） |
| `shell:update-available` | `main.js:835` | `result`（`checkForUpdates` 的返回） |
| `shell:update-downloaded` | `main.js:763` | `downloadInfo`（`main.js:756-761` 字面量） |
| `shell:update-error` | `main.js:749`（校验失败）、`main.js:768`（下载失败/二次） | `err.message`（**字符串**） |

**中间侧**（`desktop/preload.js:39-61`）——只做转发，不做变换：

| preload 暴露 | 订阅的事件 | 回调实参 |
| --- | --- | --- |
| `onUpdateProgress(cb)`（`:39-43`） | `shell:update-progress` | `progress` 原样 |
| `onUpdateAvailable(cb)`（`:45-49`） | `shell:update-available` | `result` 原样 |
| `onUpdateDownloaded(cb)`（`:51-55`） | `shell:update-downloaded` | `downloaded` 原样 |
| `onUpdateError(cb)`（`:57-61`） | `shell:update-error` | `err` 原样（**字符串**） |

每个 `onX` 都返回**取消订阅函数**（`:42,48,54,60`），面板在 `useEffect` 清理里调用（`UpdateSettings.js:72-77`）。Rust shim **必须**返回可用的 unlisten（Tauri `listen()` 返回 `Promise<UnlistenFn>`，✅Tauri-2.12.1）。

**消费侧**（面板唯一消费者：`src/shared/components/settings/UpdateSettings.js` —— ✅`grep -rn onUpdate* src/` 只有这一个文件命中）：

| 字段 | 消费点 | 用途（缺了会怎样） |
| --- | --- | --- |
| `res.updateAvailable` | `:33-40` | 决定 state = available / idle；**这是"有没有更新"的唯一判据** |
| `res.error` | `:35-37` | 非空 → state=error + 显示文案 |
| `res.latest` | `:132-133`（`ignoreVersion`）、`:247`（显示版本号） | 忽略版本、标题 |
| `res.assetSize` | `:108`（进度条初值）、`:249-253`（`Number.isFinite && >0` 才显示大小） | 大小时显示 |
| `res.releaseURL` | `:138-139` | "Release Notes" 按钮的 `window.open` |
| `progress.percent` | `:274,280` | 进度条百分比 |
| `downloadInfo.isArchive` | `:293-297` | 多显示一行"Portable archive saved to Downloads folder" |
| `errorMsg`（来自 `onUpdateError` 的字符串） | `:53-56,303-305` | 直接渲染 |

**面板没有读、但 payload 里存在的字段**（✅逐字段核对）：`res.current`、`res.releaseName`、`res.releaseNotes`、`res.downloadURL`、`res.checksumsURL`、`res.cached`、`downloadInfo.path`、`downloadInfo.assetName`、`downloadInfo.releaseURL`、`progress.downloaded`、`progress.total`。

> **建议**：即使面板不读，也要**原样发出**。理由：面板是**独立的 Next.js 构建**，可以比壳新（这正是更新的意义），未来的面板可能读这些字段。少发一个字段 = 给未来埋一个静默失败。

### 7.2 payload 精确形状

```jsonc
// shell:update-progress   ← download.js:182-186
{ "downloaded": 12345678, "total": 157000000, "percent": 8 }
//   total 可能是 0（无 content-length 且 assetSize 为 0）→ percent 恒为 0
//   percent = min(100, round(downloaded/total*100))

// shell:update-available  ← checker.js:101-114（全 12 字段，字段名必须 camelCase）
{ "current": "0.3.1", "latest": "0.3.2", "updateAvailable": true,
  "releaseName": "...", "releaseNotes": "...", "releaseURL": "https://...",
  "assetName": "iRouter-0.3.2-macos-arm64.dmg", "downloadURL": "https://...",
  "assetSize": 157000000, "checksumsURL": "https://...", "cached": false,
  "error": null }

// shell:update-downloaded ← main.js:756-761
{ "path": "/Users/x/Downloads/iRouter-0.3.2-macos-arm64.dmg",
  "assetName": "iRouter-0.3.2-macos-arm64.dmg",
  "releaseURL": "https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.2",
  "isArchive": false }

// shell:update-error  ← main.js:749,768
"Download canceled by user"     // ← 裸字符串，不是对象！
```

**Rust 侧对应结构**（字段名用 `camelCase`，这是硬要求）：

```rust
// updater/checker.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub current: Option<String>,       // JS 里是 undefined 时 IPC 保留 undefined；JSON 化后为 null
    pub latest: Option<String>,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    pub release_url: String,
    pub asset_name: String,
    pub download_url: String,
    pub asset_size: u64,
    pub checksums_url: String,
    pub cached: bool,
    pub error: Option<String>,         // ⚠️ 不要加 skip_serializing_if，保持键存在且为 null
}

// updater/download.rs
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress { pub downloaded: u64, pub total: u64, pub percent: u32 }

// updater/commands.rs
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedInfo { pub path: String, pub asset_name: String, pub release_url: String, pub is_archive: bool }
```

`shell:update-error` **不要**建模成 struct：直接 `app.emit("shell:update-error", msg)` 发 `String`（✅Tauri-2.12.1：payload 满足 `Serialize + Clone`，`String` 可以）。

### 7.3 IPC 调用契约（面板 `await` 的返回值也要等价）

| shim 方法 | 参数 | Rust command（名字取自函数名，✅Tauri-2.12.1） | 返回 | 面板消费 |
| --- | --- | --- | --- | --- |
| `checkUpdate(force=false)`（`preload.js:29`） | `force` | `shell_check_update(force: bool) -> Result<CheckResult, String>` | `CheckResult` | `UpdateSettings.js:62`（挂载同步）、`:88`（手动） |
| `downloadUpdate()`（`:31`） | 无 | `shell_download_update() -> Result<DownloadedInfo, String>` | `DownloadedInfo` | `:110`（只 await + catch） |
| `cancelDownload()`（`:33`） | 无 | `shell_cancel_download() -> bool` | `bool` | `:120` |
| `installUpdate()`（`:35`） | 无 | `shell_install_update() -> Result<bool, String>` | `true` | `:127`（**没有 try/catch**，见下） |
| `ignoreVersion(v)`（`:37`） | `v` | `shell_ignore_version(version: String) -> Result<bool, String>` | `true` | `:133` |

**注意**：`installUpdate` 在面板里**没有 try/catch**（`UpdateSettings.js:124-128`）→ 失败会成为未处理的 promise rejection，用户看不到任何提示（应用也不退出）。Rust 侧返回 `Err` 与 `Err` 字符串不会让它变好；如果 Lead 想让"安装失败"可见，需要动面板（**超出本设计范围**，登记为 D-6）。

**参数命名**：Tauri 命令参数默认按 **camelCase** 从 JS payload 取值（✅Tauri-2.12.1，`tauri-macros` `ArgumentCase::Camel` 默认；本机 `tauri-macros-2.6.3/src/command/wrapper.rs:51` 同）。我们的 shim 自己调 `invoke`，所以两侧一致即可；用单参数名（`force`/`version`）不会踩到 snake_case 转换。

### 7.4 触发条件矩阵（"什么时候必须发哪条"）

| 场景 | `update-available` | `update-progress` | `update-downloaded` | `update-error` | 命令返回值 |
| --- | --- | --- | --- | --- | --- |
| 自动检查（3s 后，`main.js:2127-2135`） | ✅（即使无更新/命中缓存/出错） | — | — | — | —（无调用方） |
| 面板挂载 `checkUpdate(false)` | ✅ | — | — | — | `CheckResult` |
| 手动 `checkUpdate(true)` | ✅ | — | — | — | `CheckResult` |
| 菜单/托盘检查（`source:"menu"`） | ✅ + 原生对话框 | — | — | — | — |
| 检查失败（网络/JSON/HTTP） | ✅（`error` 字段非 null） | — | — | ❌**不发** | `CheckResult.error` |
| 下载中 | — | ✅（每 chunk） | — | — | — |
| 校验失败 | — | — | ❌ | ✅**发两次**（D-2） | reject |
| 下载失败（HTTP/写盘） | — | — | ❌ | ✅一次 | reject |
| 用户取消 | — | —（已发的留着） | — | ✅（"Download canceled by user"） | reject |
| 下载+校验成功 | — | — | ✅ | — | `DownloadedInfo` |
| 安装 | — | — | — | ❌（失败也不发） | reject 或 true |

**结论（最容易漏的一条）**：`shell:update-error` **不覆盖"检查失败"**。检查失败只走 `shell:update-available` 的 `error` 字段（`main.js:825-836` 只在 `!result.error` 时写设置，但**总是**发送 `update-available`）。Rust 实现若把检查失败也 emit 成 `update-error`，面板会**同时**收到两条 → `setState` 竞态（先 error 后 idle，取决于到达顺序），用户可能看到"没有更新"却又有报错。**必须按上表实现**。

### 7.5 `window.irouterShell` 的存在性契约（换壳最大的单点风险）

面板三处读它：

| 位置 | 读法 | 缺失后果 |
| --- | --- | --- |
| `ShellSettingsModal.js:66-70` | `useSyncExternalStore(noop, () => Boolean(window.irouterShell), () => false)` | `isShell=false` → `:99` 过滤掉 `shellOnly` 分段 → **「软件更新」整段消失**；`:127` 兜底显示 "Loading shell settings…" |
| `ShellSettingsHost.js:37-38` | `api?.onOpenSettings?.(onOpen)` | 菜单/托盘"设置…"打不开模态框（非更新，但在同一个对象上） |
| `UpdateSettings.js:28,80` | `window.irouterShell` + 4 个 `onUpdate*` / 5 个动作 | 全部 `?.` 可选链 → **静默不订阅、静默不动作**（不报错！） |

因此 Rust 壳必须**在面板脚本运行前**注入一个真值对象：

```js
window.irouterShell = {
  getSettings, setSetting, onOpenSettings,      // 设置/模态（Phase 3 Step 5 的范畴）
  platform: "<darwin|win32|linux>",             // 保留：当前面板无消费者（✅grep 全 src/ 仅命中无关的 platform.iflow.cn），但成本为零
  checkUpdate, downloadUpdate, cancelDownload, installUpdate, ignoreVersion,
  onUpdateProgress, onUpdateAvailable, onUpdateDownloaded, onUpdateError,
};
```

**注入机制（✅Tauri-2.12.1）**：`WebviewWindowBuilder::initialization_script(impl Into<String>)`，可多次调用；远端 URL 也执行；文档承诺在 document 解析前、任何页面脚本前运行。**但"init 脚本 vs `__TAURI_INTERNALS__` 注入的先后顺序"官方无承诺（recon 标 UNVERIFIED）** → shim **不要**在脚本顶层直接 `listen()`/`invoke()`，写成"就绪后桥接"：

```js
// 伪代码：不依赖顺序的桥接
window.irouterShell = { /* 方法先占位：把调用排队 */ };
const ready = () => window.__TAURI__?.event && window.__TAURI__?.core;
(function boot() {
  if (!ready()) return setTimeout(boot, 0);          // 或 DOMContentLoaded
  // 用 window.__TAURI__.core.invoke / window.__TAURI__.event.listen 填充真实实现
  // 并回放排队的调用
})();
```

`listen` 的返回必须被包装成同步可用的 unlisten（Tauri 的 `listen()` 是 async，返回 `Promise<UnlistenFn>`）。面板的清理逻辑（`UpdateSettings.js:72-77`）假定 `onX()` **同步返回函数**（`unsubAvail?.()`）——若 shim 返回 Promise，`?.()` 会**静默不执行**（Promise 不是函数）→ 监听器泄漏 + 每次重挂载多一份回调（用户反复打开设置会出问题）。**必须**：`onUpdateProgress(cb) { let off = null; listen(...).then(f => off = f); return () => off ? off() : pending = true; }`（并处理"还没 resolve 就 unlisten"的竞态，或干脆用一个稳定的分发器：只 `listen` 一次，把回调放进本地 Set，`onX` 返回的取消函数只从 Set 移除）。

> **强烈建议采用"一次 listen + 本地分发器"**：它把 unlisten 语义变成完全同步，绕开 async 竞态，也顺手解决 Tauri `listen` 在 webview 重建后失效的问题。

**远端能力（ACL）**：`window.__TAURI_INTERNALS__` 会注入远端页面（✅recon：`manager/webview.rs:120-210` 无条件注入），但**能不能真跑由 ACL 决定**：IPC 请求的 `Origin` 被解析为 `ExecutionContext::Remote{url}`，再与 capability 的 `remote.urls`（URLPattern）匹配；`plugin:event|listen` 就是普通 IPC 命令，所以 remote capability 必须显式包含 `core:event:allow-listen` + `core:event:allow-unlisten` + 我们自己的命令权限（✅recon；权限标识 ✅本机 `tauri-2.11.6/permissions/event/autogenerated/reference.md:76,102` 与 recon 的 2.12.1 一致）。

> ⚠️ **端口是自适应的**（`main.js:28` `PORT_SCAN_SPAN=50`，`:127-160` 探测占用）→ 面板 origin 可能是 `20128`…`20177`。把 capability 的 `remote.urls` **写死成 `http://127.0.0.1:20128` 会在端口漂移时让整个更新通道（以及设置读写）静默失效**。用 `Manager::add_capability(CapabilityBuilder…remote(url)…)` 在 `setup` 里按**实际端口**动态添加（recon 指出 `dynamic-acl` 在 tauri 默认 features 内）。这是本设计里仅次于 shim 本身的第二个高风险项。

### 7.6 Rust 侧 emit 实现（✅Tauri-2.12.1）

```rust
use tauri::{Emitter, EventTarget};

// 广播（所有 webview）：
app.emit("shell:update-progress", DownloadProgress { .. })?;

// 只发主窗口（更贴近 Electron 的 mainWindow.webContents.send 语义）：
app.emit_to(EventTarget::webview_window("main"), "shell:update-downloaded", info)?;

// 事件名合法字符：字母数字 + '-' '/' ':' '_'；'shell:update-progress' 合法
```

- Electron 侧发送前有 `mainWindow && !mainWindow.isDestroyed()` 守卫（`main.js:728,748,762,767`）。Rust 侧对应"窗口句柄还在才 emit"，`emit` 返回 `Err` 时**吞掉并记日志**（不能 panic、不能中断下载流程）。
- **进度节流**（必须做）：建议"`percent` 变化 ≥1 或 `downloaded` 增长 ≥1 MiB 时 emit，且**最后一次一定 emit**"。等价性论证：面板只把 `percent` 用于渲染（`UpdateSettings.js:274,280`），把 state 置为 `downloading` 的是**第一个**事件（`:43-46`），而"下载完成"由 `shell:update-downloaded` 保证；因此丢中间进度只影响刷新率，不影响任何状态迁移。⚠️ 如果将来有别的消费者依赖每个 chunk（目前没有），该论证失效。
- **错误路径也要考虑 emit 失败**：`shell:update-error` 发不出去时，至少要让 IPC 命令 reject，这样面板的 `catch`（`:111-114`）能显示错误。

### 7.7 "可以改 / 不可改"的判定规则（避免以后误改）

| 东西 | 可否改 | 为什么 |
| --- | --- | --- |
| 4 个**事件名** | 可改（本设计选择**不改**） | 面板不直接监听；只有我们自己的 shim 监听。保持同名 = 零成本 + 与文档/基线一致 |
| payload **字段名/形状** | **不可改** | 面板直接读（§7.1） |
| `window.irouterShell` 的**方法名/存在性** | **不可改** | `ShellSettingsModal.js:66` 的存在性判定 + `UpdateSettings.js` 的方法调用 |
| IPC 命令名（`shell_check_update`） | 可改 | 只在我们的 shim 里出现 |
| `shell:update-error` 的**类型**（string） | **不可改** | 面板把它当字符串渲染 |
| 面板传入的**参数个数/类型** | 不可改 | shim 需接受 `force` / `version` |

---

## 8. 壳侧状态机与并发

Rust 建议形状：

```rust
pub struct UpdaterState {
    pub latest_checked: Mutex<Option<CheckResult>>,   // ← main.js:46
    pub downloaded_path: Mutex<Option<PathBuf>>,      // ← main.js:47
    pub download: Mutex<Option<DownloadHandle>>,      // ← main.js:45（AbortController 的对应物）
    pub in_flight_check: Mutex<Option<...>>,          // 可选：合并并发检查（见下）
}
```

| 状态 | 生命周期 | Rust 对应 | 备注 |
| --- | --- | --- | --- |
| `latestCheckedUpdate` | 进程 | `Mutex<Option<CheckResult>>` | 重启即失；`download-update` 依赖它 |
| `downloadedPackagePath` | 进程 | `Mutex<Option<PathBuf>>` | 重启即失；`install-update` 依赖它 |
| 下载 controller | 单次下载 | `CancellationToken`（`tokio-util-0.7.19` 已缓存）或 `AbortHandle` | 第二次下载**先取消第一次**（`main.js:715-717`） |
| 取消语义 | — | drop/abort 后必须删 `.part`（`download.js:117-134`） | 照抄；Rust 用 `Drop` guard 最稳 |

**取消的竞态（D-3）**：`AbortController.abort()` 是同步派发，`downloadFile` 立即 reject；面板 `cancelDownload()` 先 `await cancelDownload()` 再 `setState("available")`（`UpdateSettings.js:117-122`），而 download 命令的 reject + `shell:update-error` 会让 `onUpdateError` 把 state 打回 `error`。最终落点取决于主进程两条消息的到达顺序（⚠️**未实测**，我们没有覆盖该路径的自动化测试）。用户观感：**点"取消"可能得到一个红色错误提示**。

**建议**（D-3）：Rust 侧把"用户取消"做成**正常结果**——`shell_download_update` 返回 `Ok(())`/或专门的 `Ok(None)`，**不** emit `shell:update-error`，`.part` 照删。这样面板停在 `available`，与按钮语义一致。这是行为变更，需 Lead 签字。

**并发检查合并（可选改进）**：自动检查（3s）+ 面板挂载检查可能同时进行，现在是两个匿名网络请求。建议 Rust 侧用 `in_flight_check` 合并（第二个调用 await 同一个 future）。⚠️注意：合并后**两次调用都会返回同一个 `CheckResult`**，面板逻辑不受影响（`UpdateSettings.js:61-70` 容忍任何结果），但会改变"`update-available` 发几次"（现在是 2 次，合并后仍应发 2 次——每次调用各发一次）。若不想引入这个不确定性，就照抄"无锁并发"。

---

## 9. 不采用 `tauri-plugin-updater`：可复核论证与改用判据

### 9.1 事实（可直接核对的引文）

官方文档 `https://v2.tauri.app/plugin/updater/`（2026-10-07 抓取，📄官方文档）：

> "Tauri's updater needs a signature to verify that the update is from a trusted source. **This cannot be disabled.** To sign your updates you need two keys: The public key, which will be set in the tauri.conf.json to validate the artifacts before the installation... The private key, which is used to sign your installer files. You should NEVER share this key with anyone. Also, **if you lose this key you will NOT be able to publish new updates to the users that have the app already installed**"

配套的、同样可核对的工程事实：

| # | 事实 | 引文/依据 |
| --- | --- | --- |
| F1 | 签名**不可关闭**；`pubkey` 必须内联写进配置（不是文件路径） | 上引 + `"pubkey" ... It cannot be a file path!` |
| F2 | 私钥丢失/泄露 → 已安装用户**永久无法再收到更新**（重新生成密钥对意味着旧客户端信任的 pubkey 作废） | 上引 |
| F3 | 它**不是**"下载现有安装包再交给系统安装器"，而是需要在打包时额外生成**签名过的 updater 产物**：macOS = `.app.tar.gz` + `.sig`（不是 dmg）、Linux = **AppImage** + `.sig`（deb/rpm 不在其列）、Windows = NSIS/MSI 安装器 + `.sig` | `createUpdaterArtifacts` 章节；`myapp.app.tar.gz.sig` / `myapp.AppImage.sig` / `myapp-setup.exe.sig` |
| F4 | 它消费的是**静态 `latest.json` 清单**（或自建动态更新服务器），**不是 GitHub Releases API**；清单必须包含 `version`（SemVer）、`platforms.<os-arch>.url`、`platforms.<os-arch>.signature`，且"Tauri 会先校验整个文件再比版本" | "Static JSON File" 章节 |
| F5 | 发布流程必须注入 `TAURI_SIGNING_PRIVATE_KEY`（+ 可选 `_PASSWORD`） | 文档的 Signing 章节 |
| F6 | 现有自研流程的全部逻辑等价物 = 检查 → 下载 → SHA-256 校验 → 调起系统安装器（`desktop/updater/*`，774 行中 ~446 行是纯逻辑） | `docs/adr/0007-tauri-bun-shell.md:47`；本文件 §2 |

### 9.2 结论段（可直接引用进 ADR/PR 描述）

> iRouter 的桌面更新通道**不采用** `tauri-plugin-updater`。理由是**它把"能不能发更新"绑定到一把必须长期保管的私钥上，而这条依赖无法关闭**：官方文档明确写"The signature ... cannot be disabled"，并明确写私钥丢失后"you will NOT be able to publish new updates to the users that have the app already installed"。对一个**分发到用户机器、无法远程修复已安装客户端**的桌面应用而言，这是把一个运维级单点故障（密钥保管）塞进了产品可用性路径：GitHub 仓库被删可以重发、CI 挂掉可以重跑，私钥丢了没有任何恢复手段——已安装用户永久断更。现有自研流程的依赖面小得多：HTTPS + GitHub Releases + `checksums.txt` 的 SHA-256，等价逻辑约 446 行纯逻辑（`checker/checksum/version/asset`），已由 4 个 vitest 文件（`tests/unit/updater-*.test.js`）钉住行为。**同时必须诚实记录这次选择的代价**：自研通道的 SHA-256 只防传输损坏与单点篡改，**不防"Release 被整体篡改"**（`checksums.txt` 与安装包同源，`release.yml:124-131`），真实性完全依赖 GitHub 账号安全（2FA）。官方 updater 的 minisign 签名补的正是这一块。因此这不是"自研更好"，而是"在 2026-10 这个时间点上，**密钥丢失风险 > 供应链篡改风险**"的显式取舍；一旦 §9.3 的判据成立，应当改用它。

### 9.3 改用官方 updater 的判据（三条全中才值得改）

**同时满足**才值得改（任一条不满足 = 收益补不上迁移成本）：

1. **密钥义务被真正消解**：私钥有 ≥2 人可恢复的托管（离线备份 + CI secret 分工），且 `TAURI_SIGNING_PRIVATE_KEY` 的自动签名**已经成功跑过 ≥3 次真实发版**（不是"配好了"，是"跑过三次"）。**并且**已经接受并写下"私钥丢失 = 全量用户断更、只能引导用户手动重装"的应急手册。
2. **产品侧实测判定自研调起不可接受**：三平台实测后，**macOS 的 dmg 挂载 → 手动拖拽**被判定为用户流失点（Lead 的 plan `:270` 已把这条设为 Phase 4 的实测门禁）。注意**只有 macOS 这一条成立才真的有收益**：Windows 的 NSIS 与 Linux 的 deb 在两条路径下都需要用户点系统安装器，官方 updater 并不消除这一步（F3）。
3. **产物面愿意为它改形**：愿意在每次发版额外产出并上传 `.app.tar.gz`（macOS）、**AppImage**（Linux），以及全部 `.sig`，并维护 `latest.json`（或自建更新服务器）。这意味着 **Linux 的 deb/tar.gz 自动更新要么另做一条路，要么放弃**（F3/F4）——目前 deb 是 Linux 的主选（§6.3）。

**反过来说，以下理由不足以支持切换**（避免被"官方=更好"带走）：
- ❌ "官方插件更省代码"：现自研逻辑 446 行纯逻辑 + 60 行壳胶水（`main.js:704-805,814-878`），官方路径要新增清单生成、签名、CI 密钥、产物改造与 `tauri-plugin-process`（relaunch），**净成本更高**。
- ❌ "官方更安全"：只在**真实性**这一个维度上成立，同时引入**可用性**新风险（F2）。两个维度必须一起算。
- ❌ "AppImage 就够了"：AppImage 不自带 webkit（`docs/adr/0007-tauri-bun-shell.md:53`），Linux 首启依赖宿主 `libwebkit2gtk-4.1-0`；把它选作唯一自动更新形态会把"缺系统依赖"从安装期问题变成**更新期问题**（用户更新完启动不了），比现在更糟。

---

## 10. 三平台调起与替换体验

### 10.1 现状逐平台（`installer.js:43-55` + 平台产物语义）

| 平台 | 命令 | 用户实际看到/要做什么 | 已知问题 |
| --- | --- | --- | --- |
| macOS | `open <dmg>`（`installer.js:45-46`） | dmg 挂载 → Finder 窗口（app + Applications 快捷方式）→ **用户手动拖拽替换**；应用在 500ms 后自行退出（`main.js:793-795`）。不拖 = 什么也没装，旧版还在原地 | ①不替换运行中的 app；②用户可能只关掉窗口而不拖；③`identity: "-"` 是 ad-hoc 签名（`electron-builder.yml:62`），未公证——dmg 由**我们自己**下载（不经浏览器）、代码里没有任何 quarantine/xattr 处理，⚠️**未复核** macOS 是否会给该文件打 `com.apple.quarantine`（若不打包，就不会有"文件已损坏"提示；若打，用户会看到打不开）。**必须实测**（Phase 4 门禁） |
| Windows | `cmd.exe /c start "" <nsis.exe>`（`installer.js:49-50`） | NSIS 交互式向导（`oneClick:false`、可选安装目录，`electron-builder.yml:80-83`）；安装器会尝试关掉正在运行的实例。应用 500ms 后退出 | ①用户取消向导 → 应用已退出但什么都没装（下载文件还在 Downloads，可手动再跑）；②`cmd /c start` 的引号/空格经典坑；③NSIS 用 `TerminateProcess` 杀进程 → **绕过任何退出钩子**（见 §10.3） |
| Linux | `xdg-open <deb>`（`installer.js:52-54`） | 取决于桌面环境与 MIME 关联：可能打开 GNOME Software / Discover（要授权）、可能打开归档管理器、**也可能什么都不发生**（无关联时 `xdg-open` 退出码非 0） | ①**最不可靠**；②`spawn` 失败（无 `xdg-open`）不会报错（`installer.js:57-66`：resolve(true) 在 try 内同步执行，子进程 `'error'` 事件无监听器）→ 用户看到"应用消失但什么也没发生"；③tar.gz 形态走同一路径 → 打开归档管理器，面板按钮却写 "Install and Relaunch"（`UpdateSettings.js:227-230`） |

### 10.2 三平台的"替换体验"差异（一句话）

- **macOS**：`open dmg` 只挂载，**不做替换**，替换靠用户拖拽；应用必须先退出，否则拖拽后新旧并存。
- **Windows**：NSIS 做**真正的替换**（覆盖安装 + 快捷方式 + 卸载项），但需要用户点完向导；安装器会主动终止运行中的实例。
- **Linux**：deb 走包管理器（**需要提权**，只对用户级安装免提权）；tar.gz 完全不解压、不安装，只是"打开归档管理器"——**它不是安装器**。

因为三者语义差异这么大，**"应用自动退出"这个动作在三平台的风险是不同的**：macOS 退出是必需（否则拖不进去）、Windows 退出是配合安装器、Linux 退出则是**纯风险**（很可能什么都不会发生，用户却丢了应用）。这支持 D-5：**先确认调起成功，再退出**。

### 10.3 退出与 sidecar 孤儿回收（与 Phase 3 的接口）

现状：`openInstaller` → `setTimeout(app.quit, 500)`（`main.js:791-795`）。

Rust 侧三条硬约束：

1. **必须用 `AppHandle::exit(0)`，不能用 `std::process::exit(0)`**。✅Tauri-2.12.1：`AppHandle::exit` 经 `request_exit` → `RunEvent::ExitRequested` → `RunEvent::Exit`，在 Exit 分支会调用 `App::cleanup_before_exit()`；`std::process::exit` **什么都不跑**。更新器退出正是"必须跑清理"的场景（sidecar 网关进程）。
2. **⚠️ `Plugin::cleanup_before_exit` 在 2.12.1 不存在**（recon 按 sha256 校验过的 crate 源码全树 grep 无命中；docs.rs 2.12.1 的 `Plugin` trait 页无此方法；3.0.0-alpha.4 才有）。**2.12.1 能挂的退出点只有 `RunEvent::Exit`。** 这和 Lead 的 plan `:23`/`:52` 写的"依赖 Tauri ≥2.12.1 的 sidecar 注册表 + `cleanup_before_exit`"直接冲突 → **需要 Lead 与 tauri-api-recon 对账**（可能 `cleanup_before_exit` 指的是 `tauri-plugin-shell` 自己的 sidecar 注册表机制，而不是 `Plugin` trait 方法；也可能版本判断有误）。我不改这条（不在我的写权限内），只标红。
3. **装安装器前先停 sidecar**（建议的顺序，理由如下）：

   ```
   shell_install_update:
     let path = downloaded_path ok_or("No downloaded package found")?;
     kill_gateway_sidecar().await;              // ← 新增：先回收孤儿
     open_installer(&path, platform)?;          // 失败 → 返回 Err，不退出（D-5）
     tokio::spawn(async { sleep(500ms); app.exit(0); });   // ← AppHandle::exit
     Ok(true)
   ```

   为什么先 kill 而不是等 `RunEvent::Exit`：Windows 安装器用 `TerminateProcess` 终止本进程，**不经过任何 Rust 退出钩子**（Lead 的 plan `:242` 把这条列为必测死亡路径）。若等到 Exit 才回收，孤儿网关进程会活着并占住端口（下次启动会自动换端口，但用户机器上留下常驻进程）。先 kill 的代价：安装向导期间（用户可能停留 30s+）面板已不可用——但应用本来就要退出，这个窗口期可以接受。
   **备选**（若 Lead 不接受 500ms 内网关即停）：保留"先退出、靠下次启动回收"的 PID 文件机制（plan `:308` 提到 `main.js:197,226-285` 已有等价实现可移植）。两条路都行，但**必须选一条**，不能两条都不做。

### 10.4 `installer.js` 的 Rust 移植建议（用官方 opener 而不是手写 spawn）

本机 registry 里有 `tauri-plugin-opener-2.5.5`，其 `open_path` 的实现是 `open::that_detached`（`tauri-plugin-opener-2.5.5/src/open.rs:9-14,54-60`），而 `open-5.4.4` 的平台策略是：

| 平台 | `open` crate 行为 | 对照现状 |
| --- | --- | --- |
| macOS | 调 `/usr/bin/open` 并**等待其返回**（`open-5.4.4/src/lib.rs:281-289` 明确说 `open` 自己会交给 LaunchServices 后返回，多余的双 fork 会留僵尸） | 等价于 `installer.js:45-46`，且不会留僵尸 |
| Windows | ShellExecute 路径（`insecure` feature 才回退到 `cmd /c start`，`lib.rs:96`），带 wine 检测与 explorer 选项加固（`windows.rs:23-60`） | **比 `cmd /c start` 更稳**（避开引号坑） |
| Linux | 依次尝试 `xdg-open` → `gio open` → `gnome-open` → `kde-open`（`unix.rs:34-47`） | **严格优于只试 `xdg-open`**（现状无 fallback、失败还静默） |

且 `open_path` 在 `with.is_none()` 时会先 `path.metadata()?`（`open.rs:56-60`）——**文件不存在会返回 Err**（现状 `openInstaller` 对不存在的路径也会 resolve(true)）。

**结论**：`open_installer` 用 `tauri_plugin_opener::open_path(&path, None::<&str>)`，把 `Err` 映射成 `UpdaterError::LaunchFailed`，并在 `shell_install_update` 里据此**决定是否退出**（D-5）。⚠️注意两点差异：
- Windows 的启动机制从 `cmd /c start` 变成 ShellExecute：**打开 .exe 的观感一致，但错误码语义不同**（ShellExecute 对"没有关联程序"返回错误码 31，比 `start` 的静默更可诊断）。
- `open` crate 在 Linux 上有 fallback 链 → 某个桌面环境下**可能比现状更容易成功**（这是改进，不是等价）。两者都属于可接受偏差，但要写进验收记录。

**手写版本**（若不想引插件）：`tokio::process::Command` + Unix `.process_group(0)` / Windows `CREATE_NEW_PROCESS_GROUP`（✅recon 建议），并**必须** `Command::spawn()` 的同步 `Err`（ENOENT）→ 直接失败；不要像现状那样吞掉。

### 10.5 `install-update` 的三平台验收清单（Phase 4 门禁落点）

| 平台 | 必须观测 |
| --- | --- |
| macOS | dmg 是否被 Gatekeeper/quarantine 拦（§10.1 ①③）；拖拽替换后**旧版本确认消失**；`AppHandle::exit` 是否真的回收了 sidecar（`ps` 查网关进程）；未拖拽时重开应用仍是旧版且功能正常 |
| Windows | NSIS 向导取消 → 应用**是否仍在运行**（D-5 判据）、下载文件是否可用于手动重跑；向导完成 → 覆盖安装成功 + 无重复卸载项；**杀进程后无孤儿**（`Get-Process` 查 bun 进程） |
| Linux | 无 `xdg-open`/无 MIME 关联时**是否报错并保持应用存活**（现状会静默退出）；deb 安装后启动无缺依赖问题；tar.gz 是否只打开归档管理器（确认这不是"安装"） |

---

## 11. `ignoreVersion` 语义

| 项 | 行为 | 依据 |
| --- | --- | --- |
| 写入 | `shell:ignore-version(v)` → `writeShellSettings(dataDir, { ignoredVersion: v })` | `main.js:800-804` |
| 存储 | `shell-settings.json`，键 `ignoredVersion`，**单个字符串**（不是列表、不是集合） | `desktop/settings.js:29-37,60-61` |
| 位置 | `getGatewayDataDir()` → `IROUTER_DATA_DIR` > `IROUTER_USER_DATA` > `~/.irouter-multi`（`--multi-instance`）> `~/.irouter` | `main.js:106-118` |
| 归一 | 非字符串 → `null`；读写都走 `normalize`（非法值回退默认，**绝不抛**） | `settings.js:44-63,76-90` |
| 读取点 | 唯一：`checker.js:178` `isNew && !force && settings.ignoredVersion === latestVersion` | ✅grep 全仓仅此一处 |
| 比较 | **字符串全等**，与 `latest`（已剥 `v`）比 → 大小写/前缀敏感 | `checker.js:147,178` |
| 生效范围 | **只影响非强制检查**。手动"Check now"（`force=true`）会照常提示 | `checker.js:178`；✅`updater-checker.test.js:112-138` 钉住了这条 |
| 面板动作 | 点"Ignore this version" → `ignoreVersion(result.latest)` → `setState("idle")`（**不重新检查**） | `UpdateSettings.js:130-135,257-259` |
| 缓存交互 | 忽略结果会被写进 `lastCheckResult`（因为 `!result.error`），并重置 `lastCheckAt` → 4h 内不会再联网 | `main.js:825-830` |
| 取消忽略 | **没有 UI**。只能等新版本出现（`ignoredVersion !== latest`）或手动改 JSON 或走 `setSetting("ignoredVersion", null)`（`shell:set-setting` 不校验键名，`main.js:684-689`） | ✅源码 |

**移植要求**：
- 保持"单值 + 字符串全等 + 只影响非 force"三条。
- 存储层是 Rust 侧 `read_shell_settings`/`write_shell_settings` 的范畴（Phase 4 设置任务），但**键名与归一规则必须一致**，否则升/降级会互相清空该字段（`settings.js:44-63` 的 normalize 是"非法即默认"，Rust 侧写宽一点也安全，但**写窄了**（例如只接受 `Option<String>` 且拒绝未知键）会在读旧文件时丢字段）。
- ⚠️**跨壳兼容**：Tauri 版必须读写**同一个** `shell-settings.json`（同一个 dataDir、同一个文件名 `shell-settings.json`、同样的字段名），否则从 Electron 升到 Tauri 后用户的 `ignoredVersion` 与 `lastCheckAt` 丢失 → 升级瞬间弹一次忽略过的版本（不致命，但没必要）。`SETTINGS_FILE_NAME` 定义在 `desktop/settings.js:27`。

---

## 12. `IROUTER_*` 自动化接缝与测试策略

### 12.1 现存的接缝清单（✅枚举 `desktop/` 下所有 `IROUTER_*`）

| 变量 | 用途 | 与更新器的关系 | Phase 4/5 是否必须保留 |
| --- | --- | --- | --- |
| `IROUTER_IMPORT_DECISION`（`main.js:1519-1521`） | 旧 CLI 数据导入的自动化接缝（`import`/`skip`），`desktop/scripts/test-import.mjs` 依赖 | 与更新无关 | **必须保留**（Lead 的 plan `:262,273` 已定，且端到端测试依赖） |
| `IROUTER_USER_DATA`（`main.js:54-61,111-113`） | 隔离 userData + **兜底 dataDir** | **间接相关**：决定了 `shell-settings.json`（含 `ignoredVersion`/`lastCheckAt`/`lastCheckResult`）落在哪 → 自动化隔离数据目录时，更新器状态也一起被隔离 | **必须保留**（否则 smoke/import/single-instance 三类脚本全部失效） |
| `IROUTER_DATA_DIR`（`main.js:107-109`） | 显式指定网关数据目录 | 同上（优先级更高） | **必须保留** |
| `IROUTER_LEGACY_DIR`（`main.js:102`） | 旧 9Router 目录 | 无关 | 保留（`smoke*.mjs` 依赖） |
| `IROUTER_KEEP_DIST`（`desktop/scripts/package.mjs:23-27`） | 打包时保留输出目录 | 无关（打包脚本） | Phase 5 的等价物由 Tauri 打包脚本决定 |
| `__IROUTER_THEME__` 等（`main.js:444-448,569-585`） | 不是环境变量，是 stdout 标记 | 无关 | — |

**结论**：**更新器自身没有任何环境变量接缝**——没有 `IROUTER_UPDATE_*`。这意味着：

> 今天**无法**在不联外网、不真发一个 Release 的情况下端到端测试更新通道（检查→下载→校验→调起）。

### 12.2 因此建议新增三个接缝（供 Phase 4 实现，需 Lead 签字）

| 接缝 | 作用 | 默认值 | 备注 |
| --- | --- | --- | --- |
| `IROUTER_UPDATE_API_BASE` | 覆盖 GitHub Releases API 的基址 | `https://api.github.com` | 未设置时**必须**拼出与 `checker.js:14` 逐字相同的 URL |
| `IROUTER_UPDATE_DOWNLOAD_DIR` | 覆盖下载目录 | `$HOME/Downloads` | 避免测试污染用户真实 Downloads；等价于 `destinationDir` 参数 |
| `IROUTER_UPDATE_FAKE_INSTALLER`（可选） | 覆盖 `open_installer`，只记录不真的调起 | 未设置 | 让"安装"步骤在 CI 上可断言（否则 CI 真去开 dmg/向导） |

**这三个接缝的价值**：让 Phase 6 的"三平台各跑一遍更新"（plan `:291`）中的**下载/校验/事件**部分进入 CI（本地 HTTP 夹具 + 假 Release），只剩"系统安装器真的弹出来"必须人工。今天连这一步都做不到。

**风险提示**：环境变量接缝是**攻击面**（能改 API base 就能让应用下载任意 URL 的"更新包"）。防护：①只在**非打包**构建（`cfg!(debug_assertions)`）或显式 `--smoke` 下生效；或②打包版也接受，但要求 URL 是 `http://127.0.0.1:*`（仅回环）。**建议 ①+② 同时**：debug 任意、release 仅回环。这条必须写进 Phase 3 Step 4 的"IPC 面最小化"同一份安全清单（ADR `:37` 已经确立"守卫令牌化"的同类思路）。

### 12.3 Rust 测试清单（对齐现有 4 个 vitest 文件）

| JS 测试（现有） | Rust 对照 | 必须覆盖的用例 |
| --- | --- | --- |
| `tests/unit/updater-version.test.js:18-78` | `version.rs` 单测 | 剥 `v`/`V`、`-beta.1`、`+meta`、`0.3`→None、`dev`→None、`0.3.10>0.3.9`、`compare` 不可解析→0、`hasNewVersion` 的 dev/local 早退 |
| `tests/unit/updater-asset.test.js:16-67` | `asset.rs` 单测 | §6.2 全部 6 个名字 + linux 回退 + 未知平台→None |
| `tests/unit/updater-checksum.test.js:20-67` | `checksum.rs` 单测 | BOM、`*` 前缀、`\r\n`、空内容、hash 大小写、真实文件的 true/false |
| `tests/unit/updater-checker.test.js:52-138` | `checker.rs` 单测（注入假 fetch） | 有更新/无更新、缓存命中（含 `cached:true`）、`ignoredVersion` 非 force 不提示 & force 提示、空 release 列表、缺 `tag_name`、**错误被 catch 成 `error` 字段且 `latest===current`** |
| （无） | `download.rs` 集成测试 | `.part` → rename、取消删 `.part`、HTTP 非 200、重定向、无 `content-length` 时用 `sizeHint`、percent 钳位到 100 |
| （无） | `installer.rs` 单测 | `isArchivePackage` 大小写、`open_installer` 对不存在路径返回 Err |
| （无） | 端到端（本地夹具） | 事件名与 payload 形状：断言 emit 出 4 个事件、`update-error` 的 payload 是 `Value::String` |

> **注意 Rust 测试不能替代 JS 测试的 CI 门禁**：`cargo test` 需要在 CI 里新增 job（Phase 5/6 工作），否则删掉 `desktop/` 之后这些行为**完全失去回归保护**（见 R1）。

---

## 13. 缺陷与决策清单

| ID | 现象 | 证据 | 移植建议 | 需要谁决定 |
| --- | --- | --- | --- | --- |
| **D-1** | `updateAvailable` 只看版本号，**与产物是否匹配无关** → 版本新但没匹配到产物时：面板显示"可更新"→ 点 Download → 报 `No update asset available for download` | `checker.js:176` vs `:161-165`；`main.js:712-714` | **照抄行为**（改它要动面板语义）。但 Phase 5 **必须**保住产物名（§6.4），并新增一条 CI 断言：release 的 asset 名单必须覆盖 §6.2 六个名字 | Lead 确认"照抄 + 加 CI 断言" |
| **D-2** | 校验失败会发**两次** `shell:update-error`（内层 catch 发一次并 rethrow，外层 catch 再发一次） | `main.js:747-752` + `:766-770` | Rust 侧**去重**（只发一次）。等价性论证：两条消息文案完全相同、面板 `setState(error)` + `setErrorMsg` 幂等，用户不可见差异 | 低风险，建议直接修 |
| **D-3** | 取消下载后，面板可能落进 `error` 态并显示 "Download canceled by user" | `download.js:136-142` + `main.js:767-769` + `UpdateSettings.js:117-122`；⚠️顺序未实测 | Rust 侧把取消当**正常结果**（不 emit error、命令返回 Ok），面板停在 available | Lead 签字（行为变更） |
| **D-4** | release 里没有 `checksums.txt` 时**整个校验被跳过**，包照样安装 | `main.js:735` 的 `if (latestCheckedUpdate.checksumsURL)` | **改为 fail-closed**（缺 checksums 资产 → 报错、不安装、不 emit `downloaded`）。理由：正常发版一定产出（`release.yml:124-131`），缺它说明发布流程坏了，此时"拒绝安装"比"装一个未校验的包"安全 | Lead 签字（行为变更，可能让某次坏发版无法自更新） |
| **D-5** | `openInstaller` 永远 resolve(true)，无法知道安装器是否真的起来了 → Linux 无 `xdg-open` 时应用静默退出、什么都没发生 | `installer.js:57-66` | `Err` 时**不退出应用**并返回错误（配合 §10.4 用 `tauri-plugin-opener` / 手写 spawn 检查） | 建议直接修（提升可用性，无副作用） |
| **D-6** | `install-update` 失败时面板无任何提示（`installUpdate` 没有 try/catch） | `UpdateSettings.js:124-128` | 移植期**不动面板**；登记为后续改进（需要面板配合加错误提示） | Lead 记 backlog |
| **D-7** | 预发布版本用户永远收不到对应的正式版（后缀被丢弃 → 比较为 0） | §4 ✅实测 | **照抄**（用 semver 会是行为变更，见 §4 红线）；登记为 backlog | Lead 记 backlog |
| **D-8** | "API 顺序第一个正式版"当 latest：若补发旧版本补丁，会挑到旧版 → 不提示更新 | `checker.js:142` | **照抄**；建议在发布流程里禁止"补发旧版本 tag" | Lead 记 backlog（发布纪律） |
| **D-9** | 4h 缓存窗口是**滑动**的（命中缓存也重置 `lastCheckAt`）→ 频繁重启的用户永不真正联网检查 | `main.js:825-830` | **照抄**（改它会影响 GitHub 匿名限流预算） | 无需决定，记录即可 |
| **D-10** | `.part` 残留不会被任何启动逻辑清理 | `download.js:109,117-134`；✅grep `desktop/` 无 `.part` 清理 | 照抄；可选：启动时清理**自己下载目录里匹配当前产物名前缀**的 `.part`（⚠️注意别删用户自己的文件） | 可选 |

---

## 14. Rust 模块布局与签名总览

### 14.1 布局

```
desktop-tauri/src-tauri/src/
  updater/
    mod.rs          // pub use，等价 index.js:16-22
    version.rs      // 3 fn   ← §2.1
    asset.rs        // 2 fn   ← §2.2
    checksum.rs     // 2 fn   ← §2.3
    checker.rs      // CheckResult/CheckOptions + check_for_updates + fetch_json ← §2.4
    download.rs     // 3 fn + DownloadProgress ← §2.5
    installer.rs    // 2 fn   ← §2.6
    error.rs        // UpdaterError（§14.2）
    state.rs        // UpdaterState（§8）
    commands.rs     // 5 个 #[tauri::command]（§7.3）+ trigger_update_check（§2.8）
    events.rs       // 4 个事件名常量 + emit 包装（含进度节流）
  shell_settings.rs // 不在本设计范围（Phase 4 设置任务），但 §11 的兼容要求对它生效
```

### 14.2 错误类型（文案稳定性）

```rust
#[derive(Debug, thiserror::Error)]
pub enum UpdaterError {
    #[error("No update asset available for download")]
    NoAssetAvailable,
    #[error("Checksum for {0} not found in checksums.txt")]
    ChecksumMissing(String),
    #[error("SHA-256 verification failed")]
    ChecksumMismatch,
    #[error("No downloaded package found")]
    NoDownloadedPackage,
    #[error("Update check timed out")]
    CheckTimeout,
    #[error("GitHub API HTTP {0}")]
    HttpStatus(u16),
    #[error("Invalid JSON response: {0}")]
    InvalidJson(String),
    #[error("Download failed with HTTP {0}")]
    DownloadHttp(u16),
    #[error("Download canceled by user")]
    Canceled,
    #[error("Failed to finalize file: {0}")]
    Finalize(String),
    // ... 见表格
}
```

**必须逐字复刻的文案**（面板直接渲染，`UpdateSettings.js:303-305`）：§2 各函数"错误"列里带引号的所有字符串。**无法逐字复刻的**：Node `.message` 透传类错误（fs/网络原始错误，如 `EACCES: permission denied, open '...'`）——Rust 用 `#[error("{0}")] Io(#[from] std::io::Error)` 会得到不同文案。**这是可接受偏差**（记入验收记录），但要在错误类型里明确注释"文案会与 Electron 版不同"。

### 14.3 事件发送包装（含节流与"窗口没了"守卫）

```rust
// updater/events.rs
pub const EV_PROGRESS:   &str = "shell:update-progress";
pub const EV_AVAILABLE:  &str = "shell:update-available";
pub const EV_DOWNLOADED: &str = "shell:update-downloaded";
pub const EV_ERROR:      &str = "shell:update-error";

/// 只发给主窗口；窗口已销毁时静默忽略（对齐 main.js:728 的 isDestroyed 守卫）
pub fn emit_progress(app: &AppHandle, p: &DownloadProgress);

/// 进度节流：percent 变化 >=1 或累计 >=1MiB 才发；finished=true 时强制发（§7.6）
pub struct ProgressThrottle { .. }

pub fn emit_error(app: &AppHandle, msg: &str);   // ← String payload，不是 struct
```

---

## 15. 测试与验收清单

### 15.1 跨任务的既有测试影响（R1，必须让 Lead 处理）

| 文件 | 对 `desktop/` 的依赖 | `desktop/` 删除后 |
| --- | --- | --- |
| `tests/unit/updater-version.test.js:14` | `import ... from "../../desktop/updater/version.js"` | **失败**（模块不存在） |
| `tests/unit/updater-asset.test.js:12-15` | 同上（asset.js） | **失败** |
| `tests/unit/updater-checksum.test.js:14-17` | 同上（checksum.js） | **失败** |
| `tests/unit/updater-checker.test.js:10` | 同上（checker.js） | **失败** |
| `tests/unit/version-consistency.test.js:39,47,49,56` | 读 `desktop/package.json` / `desktop/package-lock.json` / 根 `package.json` | **失败** |

这 5 个文件现在**是绿的**（它们不在 `tests/__baseline__/known-fails.txt` 里，需要 Lead 确认——我只确认了它们的依赖，未跑基线门禁）。若 Phase 6 直接删 `desktop/`，CI 的 `Regression Gate` 会因为"新出现的失败不在 known-fails 里"而红。

**三个选项**（Lead 定）：
- (a) 保留这些 JS 测试 → 必须保留 `desktop/updater/*.js` → 与"Phase 6 删除 desktop/"矛盾。
- (b) 迁移到 `cargo test` 并在 CI 新增 Rust job，同时**删除**这 5 个 vitest 文件（并同步清理 `known-fails.txt` 若曾登记）。
- (c) 把 Rust 侧行为表（本文件 §2/§4/§5/§6）当成**人工基准**，只删测试不建 Rust 测试 → **不推荐**：更新器的回归保护就此归零。

**推荐 (b)**，且 §12.3 的用例清单直接就是 Rust 测试的输入。

### 15.2 版本真源一致性（R1 的延续）

现状是**双版本号**：根 `package.json` = `0.5.95`（上游基线，`docs/adr/0004` 有意解耦），`desktop/package.json` = `0.3.7`（产品号），面板显示的是**产品号**（`src/shared/constants/config.js:2-10` 注释 + `desktop/scripts/build-server.mjs:99-107` 经 `NEXT_PUBLIC_APP_VERSION` 注入），而更新检查用的也是产品号（`main.js:818` `app.getVersion()`）。

Tauri 侧的等价物：`app.package_info().version`，来源是 `tauri.conf.json` 的 `version`，缺省回退 `CARGO_PKG_VERSION`（✅本机 `tauri-codegen-2.6.3/src/context.rs:273-277`）。

**Phase 5 必须做**：
1. 让"更新检查用的版本" = "产物名里的版本" = 面板显示的版本 = **一个真源**（建议 `tauri.conf.json` 的 `version`，由 release workflow 从 tag 写入，等价 `release.yml:51-61`）。
2. 若 `desktop/` 被删，`version-consistency.test.js` 要么改指向新真源、要么删（见 15.1）。
3. 面板构建仍必须注入产品号（`build-server.mjs:99-107` 的等价步骤搬到 Tauri 的网关构建流程），否则面板显示 0.3.7 而应用是 0.4.0。

### 15.3 端到端验收（Phase 6 用）

| # | 断言 | 怎么做 |
| --- | --- | --- |
| A1 | 设置里**存在**「Software Update」分段 | 打开设置，左栏有该项（`ShellSettingsModal.js:48-51`）；不存在 = shim 没注入（§7.5） |
| A2 | 4 个事件都能被面板收到，且 `update-error` 显示为**文案**而不是 `[object Object]` | 用 `IROUTER_UPDATE_API_BASE` 指向本地夹具（§12.2），造 ①有更新 ②校验和不匹配 ③网络 500 三种情形 |
| A3 | 下载进度条会动，且**最终 100%** | 夹具返回一个大文件 + `content-length`；检查节流没有吞掉最后一次 |
| A4 | 下载产物落在预期目录且**没有 `.part` 残留**；`isArchive` 与后缀一致 | `ls` 校验 |
| A5 | `ignoreVersion` 后自动检查不再提示，手动 Check now 仍提示 | 等价 `updater-checker.test.js:112-138` |
| A6 | 三平台安装器真的被调起，且**失败时应用不退出** | §10.5 |
| A7 | 安装后重启，侧车无孤儿（`ps`/`Get-Process` 查 bun/gateway） | §10.3 |
| A8 | **老版本可升级到新版本**：拿一个 0.3.x 的 Electron 包，指向新 release 检查更新 → 能下载并安装 Tauri 版 | §6.4；这是本次迁移唯一不可回退的用户可见契约 |

---

## 16. 未复核项清单（不许当既定事实）

| # | 项 | 影响 | 怎么补 |
| --- | --- | --- | --- |
| U1 | `initialization_script` 与 `__TAURI_INTERNALS__` 注入的**先后顺序** | shim 桥接写法（§7.5） | ✅已给出不依赖顺序的写法；实测确认 |
| U2 | Tauri bundle 的**默认产物名模板** | Phase 5 重命名脚本 | 跑一次 `tauri build` 看实际文件名（§6.4） |
| U3 | macOS 是否给自下载的 dmg 打 `com.apple.quarantine` | "文件已损坏"风险 | Phase 4 实测（`xattr -l` 检查） |
| U4 | `reqwest` 的重定向默认上限（我按"有默认策略"写） | §2.4 重定向等价性 | 读 reqwest 文档/源码 |
| U5 | Rust `std::fs::rename` 在 Windows 上目标存在/被占用的确切行为 | §2.5 陷阱 3 | 实测或读 std 文档 |
| U6 | "取消下载 → 面板落 error"的确切消息顺序 | D-3 | 三平台实测 |
| U7 | `desktop-tauri/` 里已有的骨架是否已注册 opener 插件、窗口 label 是否叫 `main` | §7.6/§10.4 的代码落地 | **我按纪律没有进入 `desktop-tauri/`**；由 Lead/实现者核对 |
| U8 | `tests/__baseline__/known-fails.txt` 是否含上述 5 个 JS 测试 | R1 的影响面 | Lead 跑一次基线门禁 |
| U9 | `tauri 2.12.1` 与 `tauri-macros 2.7.1` 之外，`tauri-plugin-opener 2.5.5`（本机缓存版本）对 2.12.1 的兼容性 | §10.4 选型 | `cargo tree` 确认 |

---

## 附：一页速查（实现时贴在手边）

1. 事件名 4 个，**`update-error` 发字符串**；检查失败**不发** `update-error`。
2. `window.irouterShell` 必须存在；`onUpdate*` **同步**返回取消函数（用单次 listen + Set 分发）。
3. capability 的 `remote.urls` **不能写死端口**（20128→20177）；用 `add_capability` 动态加，权限含 `core:event:allow-listen`/`allow-unlisten`。
4. 产物名：`iRouter-<v>-macos-{arm64|amd64}.dmg`、`-windows-amd64-installer.exe`、`-windows-amd64-portable.zip`、`-linux-amd64.{deb,tar.gz}`；**先改名，后算 checksums.txt**。
5. 版本比较 = 数字三元组，**不用 semver crate**；`\d` 在 Rust 里要写成 `[0-9]`。
6. SHA-256 流式 + `hex::encode`；`checksums.txt` 键 = 原始文件名。
7. 退出用 `AppHandle::exit(0)`；装安装器**前先回收 sidecar**；`open_installer` 失败**不退出**。
8. 进度 emit 要节流，但**最后一次必须发**。
9. 错误文案逐字复刻（除 Node 原始 fs/网络错误）。
10. 只读仓库、只写本文件；`desktop-tauri/` 一个字都没碰。
