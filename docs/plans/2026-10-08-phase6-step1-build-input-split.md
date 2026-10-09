# Phase 6 Step 1：把承重的构建输入从 `desktop/` 拆出去

> 本文件是**动手前的对照表**。依据是 2026-10-08 的全仓扫描（两种写法都抓：`desktop/` 与
> `join(REPO, "desktop", …)`——后者是第一遍扫描漏掉的，`stage-sidecar.mjs` / `dev.mjs` /
> 多个测试都是这种写法）。
>
> 结论先行：**`desktop/` 不是"旧壳目录"，它是构建输入目录。**删它之前必须先把下面 A 组的
> 东西搬走并改完所有引用方，否则打包、sidecar 锁定、产物命名、版本真源、发布流水线会一起断。

---

## A. 必须搬走的（承重件）

| # | 现在在哪 | 谁在用（功能性引用，非注释） | 建议新位置 |
| :-- | :--- | :--- | :--- |
| A1 | `desktop/scripts/build-server.mjs` | 产出网关负载；`dlp-artifact-shipping.test.js:34` 读它；注释里被 `dev.mjs` 提示 | `tools/build-gateway-server.mjs` |
| A3 | `desktop/scripts/bun-pin.json` | `stage-sidecar.mjs:34`、`ci.yml:100` | `tools/bun-pin.json` |
| A4 | `desktop/scripts/verify-bun-pin.mjs` | `stage-sidecar.mjs:35` | `tools/verify-bun-pin.mjs` |
| A5 | `desktop/scripts/bun-gateway-spike.mjs` | `ci.yml:109`（Phase 0 门禁） | `tools/bun-gateway-spike.mjs` |
| A6 | `desktop/scripts/oauth-loopback-e2e.mjs` | Phase 1 的端到端验收（`desktop/package.json` 的 script） | `tools/oauth-loopback-e2e.mjs` |
| A7 | `desktop/updater/asset.js` | **产物命名真源**：`pack-artifacts.mjs` 的三层断言靠它 | `tools/asset-naming.js` |
| A8 | `desktop/build/gateway/server`（**构建产出**） | `tauri.conf.json:20`（`resources`）、`dev.mjs:17`、`verify-guard-chain.mjs:31`、`verify-shell.mjs:45` | `build/gateway/server`（仓库根，gitignore） |
| A9 | `desktop/package.json` 的 **version 字段** | `build-server.mjs:30`（注入 `NEXT_PUBLIC_APP_VERSION`）、`pack-artifacts.mjs:78,87`、`release.yml:51,57`、`desktop-tauri/package.json` 的注释 | **`desktop-tauri/package.json`**（见下方决策 D1） |

## B. 随 Electron 壳一起删的

`desktop/main.js`、`preload.js`、`settings.js`、`electron-builder.yml`、`desktop/updater/*.js`
（**除 A7 的 `asset.js`**）、`desktop/scripts/{package,smoke-packaged}.mjs`、
`desktop/build/dist`（Electron 产物）。

## C. 需要改的引用方（与 A 组同一步完成，否则断链）

| 文件 | 改什么 |
| :--- | :--- |
| `desktop-tauri/src-tauri/tauri.conf.json:20` | `resources` 路径 → 新负载位置（A8） |
| `desktop-tauri/scripts/stage-sidecar.mjs:34-35` | pin 与校验器路径（A3/A4） |
| `desktop-tauri/scripts/dev.mjs:17` | 负载位置 + 提示文案里的 `npm --prefix desktop run build-server` |
| `desktop-tauri/scripts/pack-artifacts.mjs:76-94` | 版本真源路径（A9）与命名真源路径（A7） |
| `desktop-tauri/scripts/verify-guard-chain.mjs:31`、`verify-shell.mjs:45` | 负载位置（A8） |
| `.github/workflows/ci.yml:100,109` | pin 路径（A3）与 spike 路径（A5） |
| `.github/workflows/desktop-tauri.yml:14-16` | **触发路径**（`desktop/updater/**` 等三条会变哑路径 → 静默不再触发） |
| `.github/workflows/release.yml:51,57,86,97` | **见决策 D2** |
| `desktop-tauri/package.json` 注释 | 版本真源说明 |

## D. 两个需要拍板的决策

### 已核实的事实（避免把不存在的东西写进计划）

- `desktop/scripts/` 实际内容：**承重件** `build-server.mjs`、`bun-pin.json`、`verify-bun-pin.mjs`、
  `bun-gateway-spike.mjs`、`oauth-loopback-e2e.mjs`；**Electron 专属（随壳删）** `package.mjs`、
  `smoke-packaged.mjs`、`smoke.mjs`、`test-import.mjs`、`test-single-instance.mjs`、
  `fit-icon.jxa.js`、`mask-icon.jxa.js`。
- `build-server.mjs` 的 postbuild 提到的 `copy-standalone-assets.mjs` **不在 `desktop/scripts/`**
  （推测在根 `scripts/`，属上游侧）——搬迁时要确认它的位置，别按惯性以为跟着走。
- **根 `.gitignore:23` 已有 `/build`**，所以负载放仓库根 `build/gateway/server` 天然被忽略，不用新增规则。

### D1. 产品版本真源去哪？

现在真源是 `desktop/package.json`（ADR-0004），根 `package.json` 是**上游基线号**（0.5.95），
两者解耦是**有意为之**。

**建议：搬到 `desktop-tauri/package.json`。** 理由：它就是这个产物的包，`tauri.conf.json` 的
`version` 本来就必须与它一致（`pack-artifacts.mjs` 已在断言这一点）。代价：要**修订 ADR-0004**
并同步三处引用 + `config.js:10` 的回退字面量（那正是 `version-consistency.test.js` 的 VC1 不变量）。

### D2. `release.yml` 怎么办？

它现在**构建并发布 Electron 版**（`:86,97` 用 `desktop/build/dist/*.dmg`，`:51,57` 往
`desktop/package.json` 写版本）。删掉 `desktop/` = **发版流水线断掉**。

两条路：
- **D2-a：把 `release.yml` 改成跑 Tauri 产物**（即真正完成切换）。这是 Phase 6 的核心动作，
  风险在"发版"这条路径上——**而且它只能在真实打 tag 时才算验证过**。
- **D2-b：本次只做搬迁，`release.yml` 暂不动**，保留它到切换那天；此时 `desktop/` 里为它保留
  它需要的东西（或接受它在那天之前是坏的）。

**建议 D2-a，但分两步**：先把 `release.yml` 改到"能在 dry-run/手动触发下产出 Tauri 产物并校验"，
确认后再让它接管 tag 发版。

---

## E. 执行顺序（每步都要能独立验证）

1. **执行 A 组的搬迁 + C 组的引用更新**（一个提交；`tauri.conf.json` 与脚本必须同时改）。
   验证：`npm run verify:guard`、`npm run verify:shell`、`npm run verify:updater-shim`、
   `cargo test`、以及**一次 `npm run dev` 起得来**。
2. **处理 8 个受门禁看守的测试**（按 R1 的三种形态分别处置）。
   验证：跑一次完整 vitest + 回归门禁，确认没有"新失败"。
3. **改 `release.yml`**（按 D2 的结论）。
   验证：手动触发一次（或 dry-run），确认产物与命名断言通过。
4. **删 `desktop/` 剩下的部分**（B 组），跑四平台 CI + 完整门禁。
5. 修订 ADR-0004（版本真源）并在 ADR-0007 记录切换完成。

**回退**：每一步都是独立提交，任一步出问题就回退那一步；`desktop/` 在最后一步之前一直在，
所以第 1–3 步全程可回退。
