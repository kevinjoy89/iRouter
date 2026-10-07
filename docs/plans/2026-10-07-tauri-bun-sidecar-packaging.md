# Tauri v2 + Bun sidecar 打包与哈希锁定方案

> 本文件回答 `task-2` 的五个问题，是 `docs/plans/2026-10-07-tauri-bun-migration.md` Phase 3（壳骨架）与 Phase 5（三平台打包）的打包侧落地契约。决策依据是 `docs/adr/0007-tauri-bun-shell.md`。
>
> **纪律**：本文件在编写期间对仓库只读。涉及 `desktop-tauri/` 的路径均为**建议契约**（该目录由 Lead 脚手架），未读取、未修改。
>
> **引用约定**：
> - 形如 `源码·[文件#L起-L止](https://github.com/…/blob/<tag>/…)` = 该 GitHub tag 下的源码行，可逐行核对。**所有源码引用都锁定在 tag `tauri-v2.12.1`**（理由见 §1）。
> - 形如 `文档·<URL>` = 官方文档页面。
> - 查不到出处的推断一律写 **unverified**，见 §11。

---

## 0. 速览：五个问题的答案

| # | 问题 | 结论（一句话） | 落点字段 |
| :-- | :--- | :--- | :--- |
| 1 | `externalBin` 三元组命名与单次构建只带一份 | 配置写**不含三元组**的基名 `binaries/irouter-bun`，Tauri 自动补 `-<目标三元组>[.exe]`；三元组 = `--target` 或宿主 triple，**只读那一份，缺失即构建失败** | `bundle.externalBin` |
| 2 | 构建前下载校验 → 落到期望文件名 | 由 `build.beforeBundleCommand` 调用 staging 脚本：读 `bun-pin.json` → `verify-bun-pin.mjs --download` 校验 → 解压 → 落到 `src-tauri/binaries/irouter-bun-<triple>[.exe]`；**任一环节 exit≠0 即中止构建**（Tauri 的 hook 非零退出会 bail） | `build.beforeBundleCommand` |
| 3 | 59 MiB 网关负载放哪 / `tauri dev` 怎么找 | 放 **resource 目录**（map 形式 → `$RESOURCE/gateway/`），不能与 sidecar 同目录（`externalBin` 只能复制单文件）；dev 下用**显式 env `IROUTER_GATEWAY_DIR`**，不依赖 `resource_dir()` 在 dev 的语义 | `bundle.resources` |
| 4 | 三平台产物命名与 `desktop/updater/asset.js` 对齐 | Tauri 默认名（`iRouter_0.3.7_aarch64.dmg` / `iRouter_0.3.7_x64-setup.exe` / `iRouter_0.3.7_amd64.deb`）**一个都对不上**；必须脚本重命名为 `iRouter-<v>-macos-arm64.dmg` 等，且 **zip/tar.gz Tauri 没有对应 target**，要自研归档 | 无字段（打包脚本职责） |
| 5 | Windows 路径/引号、macOS 嵌套签名、Linux Depends | Windows：sidecar 走无 shell 的 `StdCommand`，但 **hook 是 `cmd /S /C` 解释执行的**，路径必须在脚本内处理；macOS：bundler 自动 inside-out 签 sidecar，但 `hardenedRuntime` **默认 true**，且 `minimumSystemVersion` 默认 10.13 低于 Bun 要求的 13.0；Linux：`Depends: libwebkit2gtk-4.1-0` **由 CLI 在 Linux 宿主上自动注入**，写进配置反而会重复 | `bundle.macOS.*` / `bundle.linux.deb.depends` |

---

## 1. 引用基线：必须按 tag，不能按 `dev` 分支

**踩到的坑（记录下来避免重演）**：本方案第一轮取证读了 `tauri-apps/tauri` 的 `dev` 分支，事后发现 **`dev` 已经是 v3 alpha**（`tauri-v3.0.0-alpha.4`，2026-10-01 发布）。v3 的 bundler/config 行为不保证向后一致。因此：

| 组件 | 本方案锁定的版本 | 依据 |
| :--- | :--- | :--- |
| Tauri 应用/CLI | **≥ 2.12.1**（本方案按 `tauri-v2.12.1` 核对） | `docs/adr/0007-tauri-bun-shell.md` 的 sidecar 孤儿回收硬下限 |
| tauri-bundler | `tauri-bundler-v2.10.1` | 与 `tauri-v2.12.1` 同批发布 |
| tauri-utils | `tauri-utils-v2.10.1` | 同上 |
| tauri-plugin-shell | 2.4.0（`plugins-workspace` 的 `v2` 分支） | sidecar 运行时路径解析 |
| Bun | **1.3.14** | `desktop/scripts/bun-pin.json` |
| 网关负载 | `desktop/build/gateway/server`，59 MiB（实测） | `docs/plans/2026-10-07-tauri-bun-migration.md` Phase 2 执行记录 |

发布列表核对（`api.github.com/repos/tauri-apps/tauri/releases`）：`tauri-v2.12.1`（2026-09-30）为 v2 线最新；`tauri-v3.0.0-alpha.4`（2026-10-01）**不是** v2 线。CI 里请显式 `@tauri-apps/cli@2.12.1`，不要用 `@latest`。

---

## 2. Q1：`externalBin` 的目标三元组命名规则与「单次构建只带一份」

### 2.1 命名规则（源码级）

`bundle.externalBin` 里写的是**基名**，Tauri 在解析时补三元组：

```rust
// 源码·crates/tauri-utils/src/resources.rs#L46-L61
let extension = if matches!(target_platform, TargetPlatform::Windows) { ".exe" } else { "" };
paths.push(format!("{curr_path}-{target_triple}{extension}"));
```

- 路径相对 **`tauri.conf.json` 所在目录**（`src-tauri/`）解析 —— `文档·https://v2.tauri.app/develop/sidecar/`
- 三元组 = `tauri build --target <triple>` 的值；未指定时 = 宿主 triple（`rustc --print host-tuple`，Rust ≥1.84）—— 同页文档

**基名建议用 `irouter-bun` 而不是 `bun`**：deb 会把 externalBin 装到 `/usr/bin/<产物内文件名>`（见 §2.3），叫 `bun` 就会**覆盖用户自己装的 `/usr/bin/bun`**，且 `dpkg -r` 卸载时会把用户那份删掉。`irouter-bun` 同时避开 Windows `$INSTDIR\bun.exe` 的歧义。迁移计划里若已按 `binaries/bun` 写了脚手架，改这一处字符串即可（`externalBin` 条目 + Rust 侧 `sidecar("irouter-bun")` 两处）。

### 2.2 pin 表 ↔ 三元组 ↔ 期望文件名（staging 脚本的权威映射）

| `bun-pin.json` key | Bun 资产 | rustc 目标三元组 | `externalBin` 期望文件（放 `src-tauri/binaries/`） | 产物内最终文件名 |
| :--- | :--- | :--- | :--- | :--- |
| `darwin-arm64` | `bun-darwin-aarch64.zip` | `aarch64-apple-darwin` | `irouter-bun-aarch64-apple-darwin` | `irouter-bun` |
| `darwin-x64` | `bun-darwin-x64.zip` | `x86_64-apple-darwin` | `irouter-bun-x86_64-apple-darwin` | `irouter-bun` |
| `win32-x64` | `bun-windows-x64.zip` | `x86_64-pc-windows-msvc` | `irouter-bun-x86_64-pc-windows-msvc.exe` | `irouter-bun.exe` |
| `linux-x64` | `bun-linux-x64.zip` | `x86_64-unknown-linux-gnu` | `irouter-bun-x86_64-unknown-linux-gnu` | `irouter-bun` |
| `linux-arm64` | `bun-linux-aarch64.zip` | `aarch64-unknown-linux-gnu` | `irouter-bun-aarch64-unknown-linux-gnu` | `irouter-bun` |

⚠️ **这张表必须硬编码在 staging 脚本里，不要用字符串推导**：pin 的 key 是 `win32-x64`、资产名是 `bun-windows-x64.zip`，而 Rust 三元组是 `x86_64-pc-windows-msvc` —— 三套命名互不相同。

产物内文件名 = 期望文件名去掉 `-<目标三元组>`（`.exe` 保留）：

```rust
// 源码·crates/tauri-bundler/src/bundle/settings.rs#L1200-L1216
let dest = path.join(src.file_name()...replace(&format!("-{}", self.target), ""));
```

### 2.3 各平台落点（决定 §4 的 resource 与 §6 的 Linux 命名坑）

| 平台 | sidecar 落点 | 证据 |
| :--- | :--- | :--- |
| macOS | `<App>.app/Contents/MacOS/<name>` | 源码·[macos/app.rs#L76-L105](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-bundler/src/bundle/macos/app.rs#L76-L105) |
| Windows (NSIS) | `$INSTDIR\<name>`（与主 exe 同级） | 源码·[windows/nsis/mod.rs#L860-L889](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L860-L889) + [installer.nsi#L651-L663](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L651-L663) |
| Linux (deb) | `/usr/bin/<name>` | 源码·[linux/debian.rs#L115-L132](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-bundler/src/bundle/linux/debian.rs#L115-L132) |

### 2.4 「单次构建只带目标平台那一份」的确切语义

1. `tauri build` 只解析**当前目标三元组**那一个文件（`{基名}-{triple}{.exe}`）。
2. 其它平台的文件即使同处 `src-tauri/binaries/` 目录也**不会被打包**（解析是逐个 entry 拼后缀，不是目录扫描）—— 见 §2.1 源码。
3. **缺失是硬失败**，不是静默跳过：`ResourcePaths` 对不存在的路径返回 `ResourcePathNotFound` 错误：

   ```rust
   // 源码·crates/tauri-utils/src/resources.rs#L205-L208
   if !path.exists() { return Err(crate::Error::ResourcePathNotFound(path)); }
   ```

4. 因此每台构建机/CI runner **只 stage 自己那一份**是安全的，也是推荐做法（避免 5 份 × 24–38 MiB 白白占盘）。
5. macOS 要出 arm64 + x64 两个 dmg，就得**跑两次 build，各自 stage 对应那一份**（`--target aarch64-apple-darwin` / `--target x86_64-apple-darwin`），文件名不同正好互不覆盖。
6. `--bundles` 用于按平台收敛 bundle 类型（下一节的平台配置更干净）：

   `文档·https://v2.tauri.app/reference/cli/#build`（`-t, --target`、`-b, --bundles`、`--no-bundle`、`--no-sign`、`-c, --config`）

### 2.5 需要写进 `tauri.conf.json` 的字段

```json
{ "bundle": { "externalBin": ["binaries/irouter-bun"] } }
```

**capability 不需要为它开口子**：从 Rust 侧 `app.shell().sidecar("irouter-bun")` 直接构造命令、**不经过 scope 校验**（

`源码·[plugins-workspace v2 plugins/shell/src/lib.rs#L71-L73](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/lib.rs#L71-L73)` → `Command::new_sidecar`）。

文档页里那段 `capabilities/default.json` 加 `shell:allow-execute` 的例子只对**从 JS 调用** `Command.sidecar(...)` 成立（`文档·https://v2.tauri.app/develop/sidecar/`）。本方案由壳进程持有网关子进程，所以**不要**为了它放开 shell 权限 —— 与 ADR-0007「IPC 面压到最小」一致。

---

## 3. Q2：构建前下载校验 → 落到 `externalBin` 期望文件名

### 3.1 步骤（每一步的失败都是**中止构建**）

| # | 动作 | 命令/接口 | 失败语义 |
| :-- | :--- | :--- | :--- |
| 1 | 确定目标三元组 | 优先 `TAURI_ENV_TARGET_TRIPLE`（hook 环境里必有），否则 `rustc --print host-tuple` | 取不到 → exit 1 |
| 2 | 三元组 → pin key | §2.2 硬编码映射表 | 未登记 → exit 1（**不猜**） |
| 3 | 下载并校验 Bun | `node desktop/scripts/verify-bun-pin.mjs --download --platform <key> --out <cache>/<asset>` | 脚本自身：HTTP≠200 / 字节数不符 / SHA-256 不符 → `exit 1`；**校验通过才继续** |
| 4 | 解压出可执行 | `unzip -o <zip> -d <tmp>`，取 `<asset 去 .zip>/bun[.exe]` | 目标文件不存在 → exit 1（**不 fallback 到 PATH 里的 bun**） |
| 5 | 落到期望文件名 | `cp` → `desktop-tauri/src-tauri/binaries/irouter-bun-<triple>[.exe]`，`chmod 755`（非 Windows） | 目标目录不可写 → exit 1 |
| 6 | 二次校验（防解压/复制损坏） | `node desktop/scripts/verify-bun-pin.mjs --file <zip>`（校验的是 zip，见 §3.4 说明） + `<staged> --version` 断言输出 `1.3.14` | 任一不符 → exit 1 |
| 7 | 记录证据（可选但推荐） | 写 `.cache/bun-stage-<triple>.json`：pin 版本、三元组、zip SHA-256、stage 后文件 SHA-256、时间戳 | CI 作为 artifact 上传 |

`verify-bun-pin.mjs` 的 `--platform` 取值就是 §2.2 第一列（脚本里 `argOf("--platform", platformKey())`）。

### 3.2 挂在 `tauri.conf.json` 的哪个字段上

```json
{
  "build": {
    "beforeBundleCommand": "node scripts/stage-sidecar.mjs"
  }
}
```

- 该 hook 在**编译完成、生成 bundle 之前**执行：`源码·[tauri-cli/src/bundle.rs#L199-L209](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-cli/src/bundle.rs#L199-L209)`。
- **非零退出会中止整个 `tauri build`**：`源码·[tauri-cli/src/helpers/mod.rs#L108-L115](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-cli/src/helpers/mod.rs#L108-L115)`
  ```rust
  if !status.success() { crate::error::bail!("{} `{}` failed with exit code {}", …); }
  ```
  这就是「失败即中止」的机制保证，不需要我们再包一层。
- hook 拿得到 `TAURI_ENV_TARGET_TRIPLE` / `TAURI_ENV_ARCH` / `TAURI_ENV_PLATFORM` / `TAURI_ENV_FAMILY`：`源码·[interface/rust.rs#L293-L300](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-cli/src/interface/rust.rs#L293-L300)` + `源码·[helpers/mod.rs#L84-L85](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-cli/src/helpers/mod.rs#L84-L85)`
- 用 hook 而不用「手动跑一遍脚本」的好处：**忘记 stage 时 Tauri 自己会报 `ResourcePathNotFound`**（§2.4 第 3 条），双保险。
- 为什么不是 `beforeBuildCommand`：那个在 `cargo build` 之前跑，任何改动都会让 cargo 重新编译（hook 里动 `binaries/` 不影响 cargo，但放 `beforeBundleCommand` 语义更准：**打包才需要它**）。
- ⚠️ `--no-bundle` 时不跑 bundle 阶段 → 该 hook 也不跑。CI 里请**再显式跑一次** `stage-sidecar.mjs`（脚本必须幂等：已存在且哈希一致就直接返回 0）。

### 3.3 失败语义（写死，不许软化）

1. **禁止**任何形式的回退：不查 `PATH`、不用 `latest`、不降级到系统 `bun`、不 `|| true`、不把哈希校验降级成 warning。
2. **禁止**在 `bun-pin.json` 里没有登记的平台/三元组上「就近猜一个」—— 映射表未命中即 exit 1。
3. `bun-pin.json` 里 `"verified": false` 的平台（darwin-x64 / win32-x64 / linux-x64 / linux-arm64）：**Phase 5 首次在该平台构建时必须实际校验并回填 `verified: true`**（pin 文件 `notes` 已约定）。本方案落地时已顺手补验一条，见 §3.5。
4. 系统 `bun`（例如本机 Homebrew 那份）**只允许开发期手动 spike 用**，绝不进产物；`bun-pin.json` 的 `notes` 已写明。
5. staging 脚本必须打印：pin 版本、期望 SHA-256、实测 SHA-256、stage 目标路径 —— 让 CI 日志本身成为证据。

### 3.4 `verify-bun-pin.mjs` 的两个语义边界（别误用）

- `--file <zip>` 校验的是 **zip 包**的哈希，不是解压后的可执行文件 —— 所以步骤 6 的「二次校验」用它复查 zip 缓存，**不能**用它给 staged 二进制背书。staged 二进制的正确断言是 `<staged> --version` 输出 `1.3.14`（Bun 支持该参数，`文档·https://bun.com/docs/installation`）。
- `--download` 会按 `--out` 落盘、再校验；PIN 的 `bytes` 与实际不一致同样 exit 1（实测：darwin-arm64 23,586,433 字节通过；linux-x64 35,969,274 字节通过）。

### 3.5 本次顺手补的实测证据（2026-10-07）

| pin key | 资产 | 结果 | zip 内部结构 |
| :--- | :--- | :--- | :--- |
| `darwin-arm64` | `bun-darwin-aarch64.zip` | ✅ 一致（23,586,433 B） | `bun-darwin-aarch64/bun` |
| `linux-x64` | `bun-linux-x64.zip` | ✅ 一致（35,969,274 B）**本次新验** | `bun-linux-x64/bun` |

两条 zip 内部结构都是「目录名 = 资产名去掉 `.zip`，内含 `bun`」。另外三份（darwin-x64 / win32-x64 / linux-arm64）按同一约定推定，**标记 unverified**：staging 脚本必须显式断言该路径存在，不做 glob 兜底（否则会把「结构变了」误判成「拿到了」。

---

## 4. Q3：59 MiB 网关负载放哪 + `tauri dev` 怎么定位

### 4.1 决策：放 **resource 目录**，不与 sidecar 同目录

| 方案 | 判定 | 理由（含证据） |
| :--- | :--- | :--- |
| 与 sidecar 同目录（塞进 `externalBin`） | ❌ 根本做不到 | `externalBin` 的每一项最终是 `fs_utils::copy_file`（`源码·settings.rs#L1200-L1216`），**只复制单个文件**；而且解析时会拼 `-<triple>` 后缀，目录名对不上 |
| 放 macOS `Contents/MacOS/` | ❌ | 该目录是放可执行的地方，bundler 会把里面的每个 sidecar 当可执行逐个 `codesign`（§6.2）；59 MiB JS 树没必要进签名面 |
| 放 Linux `/usr/bin/` | ❌ | 那是放可执行的地方；59 MiB 的 JS + `node_modules` 塞进 `/usr/bin` 会被 lintian/用户当成事故 |
| **放 resource 目录（选定）** | ✅ | 三平台统一 API `resource_dir()`；保留目录结构；不参与代码签名；map 形式能精确控制目标子目录 |

### 4.2 需要的字段（map 形式，目标 `gateway/`）

```json
{
  "bundle": {
    "resources": { "../../desktop/build/gateway/server/": "gateway/" }
  }
}
```

- key 相对 `tauri.conf.json`（即 `desktop-tauri/src-tauri/`）；仓根 = `../../`。
- **必须用相对路径**：绝对路径的根会被替换成 `_root_`（`文档·https://v2.tauri.app/develop/resources/`）。
- **目录形式要带尾斜杠**（`some-folder/`）才保留原有目录结构；glob 形式（`dir/**/*`）会把文件拍平到目标目录 —— 同页文档。我们要保留结构，所以用目录形式。
- 目录遍历是允许的：`ResourcePaths::from_map(map, true)`（`源码·settings.rs#L1176-L1186`）。
- 目标目录为空串（`""`）等价于「直接铺在 `$RESOURCE` 下」；这里用 `"gateway/"` 明确占一个子目录，避免以后加别的 resource 时撞名。

### 4.3 各平台最终落点（sidecar 与负载各在哪）

| 平台 | 壳可执行 | sidecar | 网关负载 | 运行时 `resource_dir()` |
| :--- | :--- | :--- | :--- | :--- |
| macOS dmg | `iRouter.app/Contents/MacOS/iRouter` | `Contents/MacOS/irouter-bun` | `Contents/Resources/gateway/**` | `Contents/Resources` |
| Windows NSIS | `$INSTDIR\iRouter.exe` | `$INSTDIR\irouter-bun.exe` | `$INSTDIR\gateway\**` | 主 exe 所在目录 |
| Linux deb | `/usr/bin/iRouter` | `/usr/bin/irouter-bun` | `/usr/lib/iRouter/gateway/**` | `/usr/lib/iRouter` |
| Linux tar.gz（自研归档，见 §5.5） | `<root>/usr/bin/iRouter` | `<root>/usr/bin/irouter-bun` | `<root>/usr/lib/iRouter/gateway/**` | `<root>/usr/lib/iRouter` |

前两列证据 = §2.3；第三列证据：macOS `settings.copy_resources(&resources_dir)`（`源码·macos/app.rs#L97`）、deb `data_dir/usr/lib/<product_name>`（`源码·debian.rs#L327-L331`）、NSIS `SetOutPath $INSTDIR` + `resources` 模板（`源码·installer.nsi#L640-L663`）。

`resource_dir()` 的平台语义（`文档·https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html#method.resource_dir`）：Windows = 主 exe 所在目录；macOS = `${exe_dir}/../Resources`；Linux = `/usr/lib/${exe_name}`，AppImage = `${APPDIR}/usr/lib/${exe_name}`。Linux 侧的资源目录名取 **`PackageInfo.name`**，而它是 `productName`（`源码·[tauri-codegen/src/context.rs#L250-L253](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-codegen/src/context.rs#L250-L253)`）→ 与 deb 的 `/usr/lib/<product_name>` **一致**，所以 `productName` 定为 `iRouter` 时是 `/usr/lib/iRouter`。

### 4.4 `tauri dev` 下的定位（本方案里最容易踩空的一环）

**事实**：`tauri dev` **不会**把 `bundle.resources` 或 `externalBin` 复制到 `target/debug`。CLI 的 dev 分支只做「cargo build + 按 `mainBinaryName` 重命名主程序」（`源码·[interface/rust/desktop.rs#L162-L204](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-cli/src/interface/rust/desktop.rs#L162-L204)`），全仓没有任何 dev 期复制资源的代码路径。

**推论**：dev 下 `resource_dir()` 指向 `src-tauri/target/debug`，但**那里没有 `gateway/`**；sidecar 同理 —— 运行时它是按**当前 exe 所在目录**拼文件名找的：

```rust
// 源码·plugins-workspace v2 plugins/shell/src/process/mod.rs#L120-L147
let base_dir = if exe_dir.ends_with("deps") { exe_dir.parent()… } else { exe_dir };
let mut command_path = base_dir.join(command);   // → target/debug/irouter-bun[.exe]
```

顺带说明：`resource_dir()` 在 dev 下到底返回什么，**文档与源码不完全一致** —— `docs.rs` 说从 `src-tauri/target/(debug|release)/` 运行时 Linux 是 `${exe_dir}/../lib/${exe_name}`；而 v2.12.1 源码是「路径里含 `target` 且该目录有 `.cargo-lock` → 返回 `exe_dir` 本身」（`源码·[tauri-utils/src/platform.rs#L300-L310](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-utils/src/platform.rs#L300-L310)` + `#L240-L242`）。**结论：不要把 dev 行为押在 `resource_dir()` 上**，用显式 env。

**推荐做法（两行代码换掉不确定性）**：

```rust
// 生产：$RESOURCE/gateway；开发/CI：IROUTER_GATEWAY_DIR 显式覆盖
fn gateway_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    match std::env::var_os("IROUTER_GATEWAY_DIR") {
        Some(dir) => std::path::PathBuf::from(dir),
        None => app.path().resource_dir().expect("resource_dir").join("gateway"),
    }
}
// 入口即今天 npm run start:bun 跑的那一个
let entry = gateway_dir(app).join("custom-server.js");
```

配套的 dev 脚本（`desktop-tauri/scripts/dev.mjs`）做三件事，全部幂等：

1. 跑一次 §3.1 的 stage（把 `irouter-bun` 同时复制到 `src-tauri/target/debug/irouter-bun[.exe]` 供 `sidecar()` 解析，以及 `src-tauri/binaries/…-<triple>[.exe]` 供打包）；
2. 设 `IROUTER_GATEWAY_DIR=<repo>/desktop/build/gateway/server`（不存在就先 `npm --prefix desktop run build-server`）；
3. 再 `tauri dev`。

这样 dev 与生产走**同一份**负载、**同一份校验过的** Bun，只是解析路径的来源不同；也顺带关掉了迁移计划 Phase 0 Step 4 记的那条偏差（「能力面验证跑的是 Homebrew 的 bun，不是校验过哈希的那份」）—— dev 也改成用校验过的产物。

替代方案（不推荐）：dev 脚本把 59 MiB 负载复制/硬链进 `target/debug/gateway/` 来迎合 `resource_dir()`。缺点是每次 clean/切 target 都要重拷，且 Windows 上建符号链接要开发者模式权限。

### 4.5 网关子进程的参数与环境（与今天一致）

参数与环境沿用 Phase 3 Step 2 已定的契约（`--port`、`DATA_DIR=~/.irouter`、`HOSTNAME=127.0.0.1`、`IR_PANEL_GUARD`），全部用 `.arg()` / `.env()` 传，不做字符串拼接（理由见 §6.1）。

---

## 5. Q4：三平台产物命名必须与 `desktop/updater/asset.js` 逐字对齐

### 5.1 `desktop/updater/asset.js` 的规则（逐字读出，行号为该文件当前内容）

```js
// :18-47  getExpectedAssetName(version, platform, arch, installSource)
const cleanVersion = String(version || "").trim().replace(/^v/i, "");   // :19  去掉 v 前缀
if (!cleanVersion) return "";                                          // :20-22
if (platform === "darwin")                                             // :25-28
  return `iRouter-${cleanVersion}-macos-${arch === "arm64" ? "arm64" : "amd64"}.dmg`;
if (platform === "win32") {                                            // :30-36
  if (installSource === "portable")
    return `iRouter-${cleanVersion}-windows-amd64-portable.zip`;
  return `iRouter-${cleanVersion}-windows-amd64-installer.exe`;
}
if (platform === "linux") {                                            // :38-44
  if (installSource === "tarball" || installSource === "tar.gz")
    return `iRouter-${cleanVersion}-linux-amd64.tar.gz`;
  return `iRouter-${cleanVersion}-linux-amd64.deb`;
}
return "";                                                             // :46 其它平台无规则
```

`selectAsset`（:59-83）的语义（决定「改名就失效」）：

- **精确匹配** `assets.find(a => a.name === expectedName)`（:68）—— 是字符串全等，不是包含/正则。
- Linux 独有兜底：精确未命中时取**对等形态**（`deb` ↔ `tarball`）再精确匹配一次（:73-81）。
- 其它平台没有兜底；未命中 → `null` → 面板显示「无更新产物」（`checker.js:161-165` 只在命中时填 `assetName`）。

### 5.2 规则表（三平台 × 两种安装形态）

| 平台 | `platform` | `arch` | `installSource` | **期望资产名（逐字）** | 是否被当前发货版命中 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| macOS arm64 | `darwin` | `arm64` | 任意（忽略） | `iRouter-<v>-macos-arm64.dmg` | ✅ |
| macOS x64 | `darwin` | `x64` | 任意（忽略） | `iRouter-<v>-macos-amd64.dmg` | ✅（`x64`→`amd64` 特例） |
| Windows 安装版 | `win32` | `x64` | 非 `portable` | `iRouter-<v>-windows-amd64-installer.exe` | ✅（`installSource` 实际为 `undefined`） |
| Windows 便携版 | `win32` | `x64` | `portable` | `iRouter-<v>-windows-amd64-portable.zip` | ❌ 死分支（无调用点传 `portable`） |
| Linux deb | `linux` | `x64` | 非 `tarball`/`tar.gz` | `iRouter-<v>-linux-amd64.deb` | ✅（默认形态） |
| Linux tar.gz | `linux` | `x64` | `tarball`/`tar.gz` | `iRouter-<v>-linux-amd64.tar.gz` | ⚠️ 仅作为 **deb 缺失时的兜底**（`selectAsset` :73-81） |

> 「是否被当前发货版命中」依据：全仓 `installSource` 只有 `asset.js` / `checker.js` 两处引用，**`desktop/main.js:817-823` 的调用点没有传 `installSource`**（`grep -rn installSource desktop --include=*.js` 的完整结果）。所以 `undefined` 走的是各平台的默认分支。
> 结论：**便携 zip / tar.gz 不是死资产**（tar.gz 是 Linux 兜底、zip 是用户手动下载形态），仍然要按名发布；但自动更新实际只走 dmg / installer.exe / deb 三条。
> 另：`<v>` = 去掉 `v` 前缀的版本号（`:19`），Tauri 的 `settings.version_string()` 本身就是无前缀版本（`源码·tauri-bundler settings.rs#L1229-L1231`）→ 天然一致，**不要**在任何产物名里加 `v`。

### 5.3 Tauri 的默认产物名（源码推导，与期望名**全部不符**）

| 类型 | 命名格式（源码） | 0.3.7 的实际结果 |
| :--- | :--- | :--- |
| dmg | `{productName}_{version}_{arch}.dmg`，arch ∈ `x64`/`aarch64`/`universal`（`源码·macos/dmg/mod.rs#L41-L56`） | `iRouter_0.3.7_aarch64.dmg` / `iRouter_0.3.7_x64.dmg` |
| NSIS | `{productName}_{version}_{arch}-setup.exe`（`源码·windows/nsis/mod.rs#L653-L669`） | `iRouter_0.3.7_x64-setup.exe` |
| deb | `{productName}_{version}_{arch}.deb`，arch = debian 架构（`x86_64`→`amd64`，`aarch64`→`arm64`）（`源码·linux/debian.rs#L40-L66`） | `iRouter_0.3.7_amd64.deb` |
| AppImage | `{productName}_{version}_{arch}.AppImage`（`源码·linux/appimage/linuxdeploy.rs#L86-L89`） | `iRouter_0.3.7_x86_64.AppImage`（**用不到**，见下） |
| zip / tar.gz | **不存在**（`BundleType` = `deb`/`rpm`/`appimage`/`msi`/`nsis`/`app`/`dmg`，`源码·tauri-utils config.rs#L132-L147`；`文档·https://v2.tauri.app/reference/config/#bundletype`） | — |

三点差异必须靠脚本抹平：分隔符（`_` → `-`）、架构词（`aarch64`→`arm64`、`x64`→`amd64`）、Windows 的 `-setup` → `-installer`。

### 5.4 重命名映射表（打包脚本 `pack-artifacts.mjs` 的权威表）

| 平台 | Tauri 产出（`target/<triple>/release/bundle/…`） | **发布名（必须逐字）** | 动作 |
| :--- | :--- | :--- | :--- |
| macOS arm64 | `dmg/iRouter_<v>_aarch64.dmg` | `iRouter-<v>-macos-arm64.dmg` | rename |
| macOS x64 | `dmg/iRouter_<v>_x64.dmg` | `iRouter-<v>-macos-amd64.dmg` | rename |
| Windows | `nsis/iRouter_<v>_x64-setup.exe` | `iRouter-<v>-windows-amd64-installer.exe` | rename |
| Windows 便携 | （Tauri 无） | `iRouter-<v>-windows-amd64-portable.zip` | 自研归档（§5.5） |
| Linux | `deb/iRouter_<v>_amd64.deb` | `iRouter-<v>-linux-amd64.deb` | rename |
| Linux 便携 | （Tauri 无） | `iRouter-<v>-linux-amd64.tar.gz` | 自研归档（§5.5） |

参照物：现有 Electron 配置把同样的名字写成 `artifactName`（`desktop/electron-builder.yml:67,78,83,96`），CI 还有一条把 `-macos-x64.dmg` 规范化成 `-macos-amd64.dmg` 的步骤（`.github/workflows/release.yml:81-90`）。Tauri 侧没有 `artifactName` 这类字段（config schema 里不存在，只有上面那几处硬编码格式串），所以**重命名只能发生在打包之后**。

脚本要求：
- 以 `<v>` = `desktop/package.json` 的 `version`（产品版本真源，ADR-0004）为唯一版本输入，并断言它等于 `tauri.conf.json > version`（防漂移）；
- 输入目录用 glob 找，不要写死绝对路径；找到 0 个 → exit 1，找到 >1 个 → exit 1（**不猜**）；
- 重命名前 `stat` 体积并断言 > 0；重命名后打印最终列表；
- 产物落 `desktop-tauri/dist/`（与 `desktop/build/dist` 平行），供 `release.yml` 的 glob 收集。

### 5.5 zip / tar.gz 自研归档的目录树（这两种形态决定了「首次启动不需要额外下载」）

**Windows 便携 zip**（与 NSIS 装出来的目录同构，这样 `resource_dir()`=exe 目录的假设成立）：

```
iRouter-0.3.7-windows-amd64-portable.zip
├── iRouter.exe                 # target/<triple>/release/iRouter.exe（或 mainBinaryName 指定的名字）
├── irouter-bun.exe             # src-tauri/binaries/irouter-bun-x86_64-pc-windows-msvc.exe（去掉三元组）
└── gateway/**                  # = desktop/build/gateway/server/**
```

**Linux tar.gz**（镜像 deb 的 `usr/` 树，`exe_dir/../lib/iRouter` 才能 canonicalize 成功）：

```
iRouter-0.3.7-linux-amd64.tar.gz
└── usr/
    ├── bin/iRouter             # 壳可执行（+x）
    ├── bin/irouter-bun         # sidecar（+x）
    ├── lib/iRouter/gateway/**  # 负载
    └── share/…                 # 可选：applications/*.desktop、icons/hicolor/**
```

tar 里必须保留执行位（`tar -czf` 会保留；用 Node 手写 tar 流时要显式设 mode 0755），且**不要**写入绝对路径/`..`。

### 5.6 版本号与文件名的一致性门禁（CI 里跑，防「改名失效」复发）

直接复用既有纯函数，不重写规则：

```js
// release.yml 的一个新步骤（三平台通用）
// asset.js 是 CommonJS，ESM 脚本里请先 const require = createRequire(import.meta.url);
const { getExpectedAssetName } = require("./desktop/updater/asset.js");
const cases = [
  ["darwin", "arm64",  undefined,  `iRouter-${V}-macos-arm64.dmg`],
  ["darwin", "x64",    undefined,  `iRouter-${V}-macos-amd64.dmg`],
  ["win32",  "x64",    undefined,  `iRouter-${V}-windows-amd64-installer.exe`],
  ["win32",  "x64",    "portable", `iRouter-${V}-windows-amd64-portable.zip`],
  ["linux",  "x64",    undefined,  `iRouter-${V}-linux-amd64.deb`],
  ["linux",  "x64",    "tarball",  `iRouter-${V}-linux-amd64.tar.gz`],
];
// 断言 released files 里逐字存在，并断言 getExpectedAssetName(...) 与文件名全等
```

这一步的价值：**把「名字对不对」变成每次发版都跑的机器断言**，而不是靠人记。它同时也反向保护 `asset.js` —— 谁改了规则，CI 立刻红。

### 5.7 Phase 5 不需要 AppImage / rpm / msi

- `asset.js` 没有对应分支，产出即浪费构建时间与发布噪音（`bundle.targets` 默认 `"all"` 会连带产出 rpm 和 AppImage，`文档·https://v2.tauri.app/reference/config/#bundleconfig`）。
- 用**平台配置文件**收敛（Tauri 默认就会合并 `tauri.macos.conf.json` / `tauri.linux.conf.json` / `tauri.windows.conf.json`，`文档·https://v2.tauri.app/reference/cli/#build` 的 `--config` 说明）：
  - `tauri.macos.conf.json`：`{"bundle":{"targets":["dmg"]}}`
  - `tauri.windows.conf.json`：`{"bundle":{"targets":["nsis"]}}`
  - `tauri.linux.conf.json`：`{"bundle":{"targets":["deb"]}}`
- 备选：CI 传 `--bundles dmg|nsis|deb`。

---

## 6. Q5：三平台各自的坑

### 6.1 Windows：路径与引号

| 坑 | 事实/证据 | 做法 |
| :--- | :--- | :--- |
| sidecar 路径含空格/非 ASCII | 默认 `installMode: "currentUser"` → `$INSTDIR = %LOCALAPPDATA%\iRouter`（`文档·https://v2.tauri.app/reference/config/#nsisconfig`；`源码·installer.nsi#L515`），用户名可能是 `John Doe` | 运行时路径**只走** `StdCommand` + `.arg()`（无 shell 参与）：`源码·plugins-workspace v2 process/mod.rs#L120-L147`。**绝不**把路径拼进字符串命令 |
| `.exe` 后缀 | Windows 下 `externalBin` 期望文件名带 `.exe`（§2.1 源码）；运行时若命令名不带 `.exe`，插件会自动补（同文件 `#L136-L144`） | `externalBin` 基名不带后缀，交给 Tauri；Rust 侧 `sidecar("irouter-bun")` |
| **hook 是 shell 解释执行的** | `beforeBuildCommand`/`beforeBundleCommand` 在 Windows 走 `cmd /S /C <script>`，Unix 走 `sh -c`（`源码·helpers/mod.rs#L89-L107`） | hook 命令保持**单条、无参数化路径**；所有路径运算放进 Node 脚本。推荐对象写法 `{"script":"node scripts/stage-sidecar.mjs","cwd":"…"}`（`HookCommand::ScriptWithOptions`，同文件 `#L75-L80`） |
| 环境变量传路径 | `DATA_DIR` 等经 `.env()` 传，Rust 侧是 `OsString`，空格/中文都安全 | 不要为了「省事」拼进命令行参数 |
| 长路径（>260） | 负载是 Next standalone + `node_modules`，嵌套较深；`$INSTDIR` 前缀已经不短 | 构建机上把工作目录放在短路径（如 `C:\b\iRouter`）或启用长路径支持；Phase 5 用一条命令实测树内最长路径 |
| UAC / 提权 | 默认 per-user 安装**不弹 UAC** | 保持 `installMode` 默认；不要改 `perMachine` |
| WebView2 | 默认 `webviewInstallMode = {type:"downloadBootstrapper", silent:true}`（`源码·tauri-utils config.rs#L1001-L1005`） | 与迁移计划一致（**不塞离线包**）；离线环境用户需自备 WebView2 |
| 便携 zip 的路径 | zip 内**只能有相对路径**；解压后 exe 与其同级目录必须有 `gateway/` 与 `irouter-bun.exe` | §5.5 的树；用 `Compress-Archive`/`zip -r` 时以目录为根，不要带盘符 |
| 便携 zip 与符号链接 | Windows 建符号链接需开发者模式/管理员 | 归档用真实文件，不要 symlink |

### 6.2 macOS：嵌套可执行、签名与最低系统版本

| 坑 | 事实/证据 | 做法 |
| :--- | :--- | :--- |
| sidecar 是嵌套可执行 | bundler 把 externalBin 复制进 `Contents/MacOS/` 并**加入签名列表**（`SignTarget{is_an_executable:true}`），注释明确「Sign frameworks and sidecar binaries first, per apple, signing must be done inside out」：`源码·macos/app.rs#L98-L132` | 不需要手工签 sidecar —— 只要配置了签名身份，bundler 会先把 sidecar 签了再签 .app |
| 无身份 = 完全跳过签名 | `keychain(None)` 返回 `None` → 整个签名块跳过（`源码·macos/sign.rs#L19-L44`） | **必须**给 `signingIdentity`，否则产物回到「从浏览器下载后被 macOS 判为已损坏」的老问题 |
| ad-hoc 签名 | `signingIdentity: "-"` → `keychain(Some("-"))` → `codesign --force -s - <path>`（`源码·tauri-macos-sign/src/keychain.rs#L42-L45`、`#L213-L241`） | 与今天 Electron 的 `identity: "-"`（`desktop/electron-builder.yml:62`）等价，继续保持 |
| **`hardenedRuntime` 默认 `true`** | `MacConfig::default()` 里 `hardened_runtime: true`（`源码·tauri-utils config.rs#L675-L692`），且签名时对**可执行目标（含 sidecar）**追加 `--options runtime`（`源码·macos/sign.rs#L46-L72`） | 建议显式 `"hardenedRuntime": false`（与今天 Electron 的 `hardenedRuntime: false` 一致）。若坚持开启，**必须**给 Bun 配 `com.apple.security.cs.allow-jit` 等 entitlements（`文档·https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit`）——JSC 需要 JIT。**「硬化运行时会让 Bun 起不来」这一点本地未实测，标记 unverified**，Phase 5 必须在真机验证（见 §10） |
| 最低系统版本 | Tauri 默认 `minimumSystemVersion = "10.13"`（`源码·config.rs#L694-L696`）；**Bun 官方要求 macOS 13.0+**（`文档·https://bun.com/docs/installation` 的 "Bun requires macOS 13.0 or later"） | 必须显式 `"minimumSystemVersion": "13.0"`；否则 10.13–12.x 用户能装上但 sidecar 起不来 = 迁移计划要避免的「静默失败」 |
| universal | 体积翻倍（ADR/计划已否） | per-arch 两次 build（§2.4 第 5 条），`--target` 显式指定 |
| dmg 命名 | Tauri 用 `_`+`aarch64`/`x64`（§5.3） | §5.4 重命名 |
| `xattr` 残留导致签名失败 | bundler 自己会先清（`源码·macos/app.rs#L127-L130` 调 `remove_extra_attr`） | 无需额外处理 |

### 6.3 Linux：`Depends` 与运行时基线

| 坑 | 事实/证据 | 做法 |
| :--- | :--- | :--- |
| `Depends: libwebkit2gtk-4.1-0` 从哪来 | **CLI 在 Linux 宿主上编译时自动注入**：`depends_deb = config.linux.deb.depends.unwrap_or_default()` 之后**无条件 push** `libwebkit2gtk-4.1-0`、`libgtk-3-0`（`源码·tauri-cli/src/interface/rust.rs#L1364,1391-L1425`），最终 `depends: Some(…)`（`#L1544-L1547`）；bundler 只在非空时输出 `Depends:` 行（`源码·linux/debian.rs#L204-L206`） | **不要**在 `bundle.linux.deb.depends` 里再写一遍 webkit/gtk —— 注入是 push 且**不去重**，会得到重复项。该字段只用来**追加**额外依赖 |
| 托盘依赖 | 若 cargo feature `tray-icon` 打开，还会追加 `libayatana-appindicator3-1`（或 `libappindicator3-1`，按 pkg-config 探测；`源码·rust.rs#L1378-L1410`） | 我们的壳有托盘 → deb 会自动带上；**验证方式**：`dpkg -I *.deb` 打印 `Depends` 行做冒烟断言 |
| 跨平台构建 deb | 注入逻辑在 `#[cfg(target_os = "linux")]` 块内 | deb **必须在 Linux 上构建**（本来就如此，`release.yml` 用 `ubuntu-22.04`） |
| deb 包名 ≠ 资源目录名 | `Package: heck::AsKebabCase(productName)` → `i-router`（`源码·debian.rs#L172-L174`）；资源在 `/usr/lib/iRouter`（productName 原样，`#L330`） | 文档里写清卸载命令是 `sudo apt remove i-router`；排查问题时别去 `/usr/lib/i-router` 找 |
| sidecar 装进 `/usr/bin` | `copy_binaries(&bin_dir)`，`bin_dir = data/usr/bin`（`源码·debian.rs#L118-L131`） | 用 `irouter-bun` 命名，避免覆盖用户 `/usr/bin/bun` |
| tar.gz 没有依赖元数据 | tar.gz 是自研归档（§5.5），没有任何包管理器语义 | `libwebkit2gtk-4.1-0` 这条**唯一被批准的例外**必须在 release notes / README 里显式写；再在 tar.gz 顶层放一个 `README-linux.txt` 更好 |
| glibc 基线 | Tauri 官方建议「用你打算支持的最老基系统构建」（`文档·https://v2.tauri.app/distribute/debian/`），Ubuntu 22.04 / Debian 12 提供 webkit2gtk-4.1 | 现有 `release.yml` 已用 `ubuntu-22.04`（`.github/workflows/release.yml:27`）→ 保持不变即可；Bun 另有内核 5.6+ 的建议（`文档·https://bun.com/docs/installation`） |
| AppImage（不产） | 仍依赖宿主 webkit，体积也大 | 不需要；`bundle.targets` 收敛掉（§5.7） |

---

## 7. 可直接抄的 `tauri.conf.json` 片段

> 路径以 `desktop-tauri/src-tauri/tauri.conf.json` 为基准；`productName`/`identifier` 与现有 `desktop/electron-builder.yml:2-3` 对齐。

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "iRouter",
  "version": "0.3.7",
  "identifier": "com.irouter.desktop",
  "mainBinaryName": "iRouter",
  "build": {
    "frontendDist": "http://127.0.0.1:20128",
    "beforeBuildCommand": "npm --prefix .. run build",
    "beforeBundleCommand": "node scripts/stage-sidecar.mjs"
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "nsis", "deb"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.icns", "icons/icon.ico"],
    "externalBin": ["binaries/irouter-bun"],
    "resources": { "../../desktop/build/gateway/server/": "gateway/" },
    "macOS": {
      "signingIdentity": "-",
      "hardenedRuntime": false,
      "minimumSystemVersion": "13.0"
    },
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper", "silent": true },
      "nsis": { "installMode": "currentUser" }
    },
    "linux": {
      "deb": { "depends": [] }
    }
  }
}
```

几点说明（都能对上字段与出处）：

1. `bundle.targets` 的三项由平台配置文件分派（§5.7）；写在一起也不会互相影响（各自平台只认自己的类型）。
2. `build.frontendDist` 可以是 **URL**：`FrontendDist::Url(Url)`（`源码·tauri-utils config.rs#L3699-L3706`）—— 面板由 sidecar 提供，不需要前端产物目录。若脚手架选的是 Directory 形态，注意 CLI 会在 `frontendDist` 不存在时直接 bail（`源码·tauri-cli/src/build.rs#L214-L222`）。
3. `mainBinaryName`（可选，建议）：默认用 cargo 产物名，设成 `iRouter` 后 deb 的 `/usr/bin/iRouter`、NSIS 的 `$INSTDIR\iRouter.exe`、便携 zip 里的 exe 名都统一（`文档·https://v2.tauri.app/reference/config/#mainbinaryname`）。打包脚本仍应 glob 实际 exe 名，不要假定。
4. `"depends": []` 与不写等价（`unwrap_or_default()`）；写成空数组只是把「我们确认由 CLI 自动注入」这件事显式化。**不要**填 webkit/gtk（§6.3）。
5. `version` 必须与 `desktop/package.json` 同步（产品版本真源，ADR-0004）；CI 里由发版流程改写并断言一致。
6. hook 的**默认工作目录 = 前端目录**（即 `tauri.conf.json` 的上一级，本项目为 `desktop-tauri/`）：`源码·[tauri-cli/src/helpers/app_paths.rs#L22-L27](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-cli/src/helpers/app_paths.rs#L22-L27)` + `源码·[helpers/mod.rs#L80](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-cli/src/helpers/mod.rs#L80)`。所以 `npm --prefix .. run build`（= 仓根）与 `node scripts/stage-sidecar.mjs`（= `desktop-tauri/scripts/`）都按这个基准写；要换目录就用对象写法的 `cwd`（`HookCommand::ScriptWithOptions`）。

---

## 8. 脚本契约（`desktop-tauri/scripts/`，只列职责，不含实现）

| 脚本 | 职责 | 输入 | 退出码 |
| :--- | :--- | :--- | :--- |
| `stage-sidecar.mjs` | §3.1 全流程：解析三元组 → pin key → `verify-bun-pin.mjs --download` → 解压 → 落 `binaries/irouter-bun-<triple>[.exe]`（幂等：哈希一致即跳过） | `TAURI_ENV_TARGET_TRIPLE` 或 `rustc --print host-tuple`、`desktop/scripts/bun-pin.json` | 0 成功；1 任一环节不符；2 用法错误 |
| `dev.mjs` | stage sidecar 到 `target/debug/` + 确保 `desktop/build/gateway/server` 存在 + 设 `IROUTER_GATEWAY_DIR` + 起 `tauri dev` | 同上 | 透传 |
| `pack-artifacts.mjs` | §5.4 重命名 + §5.5 zip/tar.gz 归档 + §5.6 命名断言；输出到 `desktop-tauri/dist/` | `target/<triple>/release/bundle/**`、`binaries/**`、`desktop/build/gateway/server/**` | 0/1（0 个或多个匹配 = 1） |
| `assert-gateway.mjs`（可选） | 打包前断言负载存在且 `custom-server.js` 在内、体积在 55–65 MiB 区间（防「负载没构建」被打成空包） | — | 0/1 |

复用既有资产，**不要复制粘贴校验逻辑**：`desktop/scripts/verify-bun-pin.mjs` 是唯一的 Bun 哈希校验入口（`--file` / `--download` / `--list` / `--platform`），`desktop/updater/asset.js` 是唯一的产物命名规则来源。

---

## 9. CI 接法（`release.yml` 的 Tauri 版）

| 步骤 | macOS runner | Windows runner | Linux runner |
| :--- | :--- | :--- | :--- |
| 装 Tauri CLI | `npm i -D @tauri-apps/cli@2.12.1`（**锁版本**） | 同左 | 同左 |
| Rust target | `aarch64-apple-darwin` + `x86_64-apple-darwin` | `x86_64-pc-windows-msvc`（默认） | `x86_64-unknown-linux-gnu`（默认） |
| stage | 每次 build 前跑 `stage-sidecar.mjs`（两种三元组各一次） | 1 次 | 1 次 |
| 构建 | `tauri build --target aarch64-apple-darwin` + `--target x86_64-apple-darwin` | `tauri build` | `tauri build` |
| 归档 + 重命名 | `pack-artifacts.mjs` | 同左 | 同左 |
| 命名门禁 | §5.6 用 `asset.js` 断言 | 同左 | 同左 |
| 上传 | `desktop-tauri/dist/*.{dmg,exe,zip,deb,tar.gz}` | 同左 | 同左 |
| 发版 | 现有 `release` job 的 glob 已覆盖这 5 种扩展名（`.github/workflows/release.yml:149-155`），`checksums.txt` 生成逻辑无需改 | | |

发版流程的其它既有约束保持不变：tag `v*` 触发、版本号先同步进产品版本真源、`docs/release-notes/<tag>.zh-CN.md` 必须存在（`release.yml:135-142`）。

---

## 10. 验收清单（Phase 5 出口条件，逐条可执行）

1. **产物名**：三平台 6 个资产名与 §5.2 表逐字一致，§5.6 的门禁步骤在 CI 里为绿。
2. **哈希链**：`stage-sidecar.mjs` 的日志含期望/实测 SHA-256；五平台 `verified` 回填为 `true`（未构建的平台保持 `false` 并在报告里点名）。
3. **sidecar 真在包里**：`dmg` 挂载后 `Contents/MacOS/irouter-bun` 存在且 `codesign -dv` 可读；deb `dpkg -c` 里有 `/usr/bin/irouter-bun`；zip 解压后有 `irouter-bun.exe`。
4. **负载真在包里**：`Contents/Resources/gateway/custom-server.js`（macOS）、`$INSTDIR\gateway\custom-server.js`（Windows）、`/usr/lib/iRouter/gateway/custom-server.js`（deb）。
5. **`Depends`**：`dpkg -I iRouter-<v>-linux-amd64.deb` 的 `Depends` 含 `libwebkit2gtk-4.1-0`（且**无重复项**），有托盘时含 `libayatana-appindicator3-1`。
6. **最低系统版本**：`defaults read …/Info.plist LSMinimumSystemVersion` = `13.0`。
7. **签名**：`codesign -vvv --deep --strict iRouter.app` 通过；`hardenedRuntime` 的取舍（§6.2）在真机上以「Bun 能起、面板 200」为准**实测后写回本文件**，未测完之前保持 unverified 标注。
8. **dev 一致性**：`npm run dev`（Tauri 版）用的 Bun 与负载与打包版**同源**（`bun-pin.json` 校验过的产物 + `desktop/build/gateway/server`）。
9. **老版本不被切断**：把上一版（Electron v0.3.x）装好，指向新的 Release 做一次「检查更新 → 下载 → 调起安装器」，确认 `selectAsset` 命中（这条是 §5 的最终验收，前面所有命名工作都为它服务）。

---

## 11. unverified 清单（明确不知道的，不许当成已知）

| # | 项 | 为什么没验证 | 谁在什么时候验 |
| :-- | :--- | :--- | :--- |
| 1 | `bun-darwin-x64.zip` / `bun-windows-x64.zip` / `bun-linux-aarch64.zip` 的**内部结构**（是否为 `<资产名>/bun[.exe]`） | 只实测了 darwin-arm64 与 linux-x64 两份 | staging 脚本用显式断言兜住；Phase 5 首次构建时确认 |
| 2 | `bun-pin.json` 中 darwin-x64 / win32-x64 / linux-arm64 的 SHA-256 | 只实测了 darwin-arm64 与 linux-x64（后者为本次新增证据，§3.5） | Phase 5 首次在对应平台构建时按 pin 文件的 `notes` 回填 |
| 3 | `hardenedRuntime: true` 是否真的会让 Bun（JSC）在 macOS 上起不来 | 只是源码推断（`--options runtime` 会加到 sidecar 上）+ Apple 的 JIT 权限要求；本机未实测 | Phase 5 真机：一次 `hardenedRuntime: true` 的对照构建 |
| 4 | 跨架构（arm64 机器上出 x64 dmg）时 DMG 制作的完整可用性 | Tauri CLI 支持 `--target x86_64-apple-darwin`（官方 CLI 文档），但本方案未实跑 | Phase 5 macOS runner |
| 5 | Windows 负载树的最长路径是否触及 260 限制 | 未测量 | Phase 5 在 Windows runner 上量一次 |
| 6 | Tauri v3（当前 `dev` 分支）是否会改变 §2–§6 的任何行为 | 本方案刻意只引用 v2.12.1 | 迁移到 v3 时重读本文件 |
| 7 | `tauri-plugin-shell` 在 Rust 侧 `sidecar()` 不走 scope 校验这一条在 shell 插件 >2.4.0 是否仍成立 | 依据 `plugins-workspace` `v2` 分支（2.4.0）源码 | 升级插件时复看 `lib.rs` 的 `sidecar()` |

---

## 12. 出处汇总

**官方文档**

- Sidecar（externalBin 语义、三元组、capability 例子）：https://v2.tauri.app/develop/sidecar/
- Resources（list/map 两种写法、`_root_`/`_up_`、目录尾斜杠保留结构）：https://v2.tauri.app/develop/resources/
- 配置参考（`bundleconfig` / `externalbin` / `debconfig` / `nsisconfig` / `windowsconfig` / `macconfig` / `bundletype` / `mainbinaryname`）：https://v2.tauri.app/reference/config/
- CLI 参考（`build` 的 `--target` / `--bundles` / `--no-bundle` / `--no-sign` / `--config` 与平台配置合并）：https://v2.tauri.app/reference/cli/#build
- macOS 签名（`signingIdentity`、`APPLE_SIGNING_IDENTITY`、CI 证书）：https://v2.tauri.app/distribute/sign/macos/
- Windows 安装器（NSIS/MSI、交叉编译）：https://v2.tauri.app/distribute/windows-installer/
- Debian（stock deb 会指定 webkit2gtk/gtk 依赖、glibc 基线建议）：https://v2.tauri.app/distribute/debian/
- `resource_dir()` 平台语义：https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html#method.resource_dir
- Apple entitlements（`com.apple.security.cs.allow-jit`）：https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit
- Bun 安装与平台要求（macOS 13.0+、SSE4.2、内核建议）：https://bun.com/docs/installation

**源码（tag `tauri-v2.12.1`）**

- `crates/tauri-utils/src/resources.rs`（三元组拼接 `#L46-L61`；缺失即 `ResourcePathNotFound` `#L205-L208`）
- `crates/tauri-utils/src/platform.rs`（`resource_dir` 平台分支 `#L257-L340`；`.cargo-lock` 判定 `#L240-L242`）
- `crates/tauri-utils/src/config.rs`（`BundleType` `#L132-L147`；`MacConfig::default` `#L675-L696`；`WebviewInstallMode::default` `#L1001-L1005`；`FrontendDist` `#L3699-L3706`）
- `crates/tauri-bundler/src/bundle/settings.rs`（`copy_binaries` 去三元组 `#L1200-L1216`；`resource_files` `#L1176-L1186`；`version_string` `#L1229-L1231`）
- `crates/tauri-bundler/src/bundle/macos/app.rs`（sidecar→`Contents/MacOS`、解析 sidecar 签名、签名顺序 `#L76-L132`）
- `crates/tauri-bundler/src/bundle/macos/sign.rs`（`keychain(None)`→跳过 `#L19-L44`；entitlements/hardened runtime `#L46-L72`）
- `crates/tauri-bundler/src/bundle/linux/debian.rs`（`Package` 名 `#L172-L174`；`Depends` 输出 `#L204-L206`；`usr/bin` 与 `usr/lib/<productName>` `#L115-L132`、`#L327-L331`）
- `crates/tauri-bundler/src/bundle/windows/nsis/mod.rs`（NSIS 产物名 `#L653-L669`；`install_mode` 默认 `currentUser` `#L340-L343`；externalBin 去三元组 `#L860-L889`）
- `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`（`$INSTDIR` 默认 `$LOCALAPPDATA\…` `#L500-L515`；资源与 sidecar 都装进 `$INSTDIR` `#L640-L663`）
- `crates/tauri-bundler/src/bundle/macos/dmg/mod.rs`（dmg 名 `#L41-L57`）
- `crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs`（AppImage 名 `#L86-L89`）
- `crates/tauri-cli/src/interface/rust.rs`（deb `/usr/bin` 与自动依赖注入 `#L1364-L1425`、`#L1544-L1547`；hook 环境变量 `#L293-L300`；版本来源 `#L1072-L1078`）
- `crates/tauri-cli/src/helpers/mod.rs`（hook 的 shell 执行与非零退出 bail `#L68-L115`）
- `crates/tauri-cli/src/bundle.rs`（`beforeBundleCommand` 调用点 `#L199-L209`）
- `crates/tauri-cli/src/build.rs`（`beforeBuildCommand` `#L203-L210`；`frontendDist` 缺失 bail `#L214-L222`）
- `crates/tauri-cli/src/interface/rust/desktop.rs`（dev 只 build+重命名，不复制资源 `#L162-L204`）
- `crates/tauri-codegen/src/context.rs`（`PackageInfo.name = productName` `#L250-L253`）
- `crates/tauri-macos-sign/src/keychain.rs`（`with_signing_identity` `#L42-L45`；`codesign --force -s <id>` `#L213-L241`）

**源码（`tauri-apps/plugins-workspace` 分支 `v2`，tauri-plugin-shell 2.4.0）**

- `plugins/shell/src/lib.rs#L71-L73`（Rust 侧 `sidecar()` 直接构造命令，不过 scope）
- `plugins/shell/src/process/mod.rs#L120-L147`（按当前 exe 目录解析 sidecar、Windows 自动补 `.exe`）、`#L167-L175`（`CREATE_NO_WINDOW`）

**仓库内既有资产（只读引用）**

- `desktop/scripts/bun-pin.json`、`desktop/scripts/verify-bun-pin.mjs`
- `desktop/updater/asset.js`、`desktop/updater/checker.js`、`desktop/main.js:817-823`
- `desktop/electron-builder.yml:22-31,67,78,83,96`
- `.github/workflows/release.yml:81-90,149-155`
- `docs/adr/0007-tauri-bun-shell.md`、`docs/plans/2026-10-07-tauri-bun-migration.md`
