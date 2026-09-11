# 版本号解耦：上游基线号与产品版本号各司其职

根 `package.json` / `cli/package.json` 保持上游基线号（当前 `0.5.75`，随上游同步推进），`desktop/package.json` 是产品版本号（当前 `0.1.0`）的**唯一真源**；`desktop/scripts/build-server.mjs` 构建网关时读它并以 `NEXT_PUBLIC_APP_VERSION` 注入，`src/shared/constants/config.js` 取该变量（缺省 `"0.1.0"`），因此面板侧栏与 Profile 页显示的可见版本号恒为产品号，与壳层 CSS 覆盖值（`desktop/main.js` 用 `app.getVersion()` 改写侧栏品牌/版本）及冒烟断言（`main.js` 校验「面板版本号 === `app.getVersion()`」）天然一致。基线号不外露，仅用于源码内部与上游对齐的标识：`open-sse/shared/clineAuth.js` 的 `User-Agent: 9Router/<version>`、`open-sse/config/appConstants.js` 的 `X-Msh-Version`、`src/lib/db/version.js` 写入 `_meta.appVersion` 与备份文件名——这三处若被改成产品号，就会偏离上游指纹。

Status: accepted

Considered Options:
- **统一为单一版本号**（根 `package.json` 改成 `0.1.0`）：会让 UA / `X-Msh-Version` 脱离上游指纹，且每次上游同步都要重新改写版本字符串，冲突面从 `.gitignore` 一个文件扩大到两个 `package.json`
- **`config.js` 回到上游写法 `version: pkg.version`**：面板将显示上游基线号 `0.5.75`，与壳层 CSS 覆盖的 `0.1.0` 同屏并存，且撞挂 `main.js:2189` 的相等断言；同时违背「用户可见版本号一律产品号」的口径
- **保留 `config.js` 硬编码 `"0.0.9"`**：无需构建期注入，但每次发版都要手改，且这次上游同步就已成为唯一会说谎的地方（面板显示 `0.0.9` 而实际基线已是 `0.5.75`）

Consequences:
- 同一界面上可能出现两个版本号语义：侧栏/Profile 页脚是产品号（`0.1.0`），来源为构建期注入；源码内与上游交互的标识是基线号（`0.5.75`）。**这不是不一致，不要"顺手统一"**
- 构建期注入是唯一可选路径：`config.js` 被客户端组件导入（`src/shared/components/Sidebar.js` 带 `"use client"`），运行时 `fs` 不可用；仓库已有 `NEXT_PUBLIC_CLOUD_URL` / `NEXT_PUBLIC_BASE_URL` 先例
- 未经 `build-server.mjs` 的裸 `npm run dev` / `npm run build`（如 CLI 形态、直接跑根目录）不注入该变量，面板回退显示 `"0.1.0"` 缺省值——桌面形态下不可见，符合预期
- 回退此决策需同时改动 `src/shared/constants/config.js`、`desktop/scripts/build-server.mjs`、`desktop/package.json` 三处，并重新打包验证冒烟断言
