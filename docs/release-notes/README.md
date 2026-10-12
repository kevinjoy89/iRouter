# iRouter Release Notes | 版本发布说明

本目录归档 iRouter 各正式发布版本的多语言详细发版说明（Release Notes）。
This directory archives detailed multi-language Release Notes for all official releases of iRouter.

---

## 📑 Versions / 版本列表

| Version / 版本 | Release Date / 发布日期 | Gateway Baseline / 网关基线 | Release Notes / 发版说明 |
| :--- | :---: | :---: | :--- |
| **Unreleased** *(待发布)* | — | 9router `v0.5.99` | [简体中文](unreleased.zh-CN.md) |
| **v0.4.3** *(Latest)* | 2026-10-12 | 9router `v0.5.99` | [English](v0.4.3.en.md) · [简体中文](v0.4.3.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.4.3) |
| **v0.4.2** | 2026-10-09 | 9router `v0.5.99` | [English](v0.4.2.en.md) · [简体中文](v0.4.2.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.4.2) |
| **v0.4.1** | 2026-10-09 | 9router `v0.5.99` | [English](v0.4.1.en.md) · [简体中文](v0.4.1.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.4.1) |
| **v0.4.0** | 2026-10-09 | 9router `v0.5.95` | [English](v0.4.0.en.md) · [简体中文](v0.4.0.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.4.0) |
| **v0.3.7** | 2026-10-07 | 9router `v0.5.95` | [English](v0.3.7.en.md) · [简体中文](v0.3.7.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.7) |
| **v0.3.6** | 2026-10-07 | 9router `v0.5.95` | [English](v0.3.6.en.md) · [简体中文](v0.3.6.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.6) |
| **v0.3.5** | 2026-10-01 | 9router `v0.5.91` | [English](v0.3.5.en.md) · [简体中文](v0.3.5.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.5) |
| **v0.3.4** | 2026-09-30 | 9router `v0.5.91` | [English](v0.3.4.en.md) · [简体中文](v0.3.4.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.4) |
| **v0.3.3** | 2026-09-29 | 9router `v0.5.91` | [English](v0.3.3.en.md) · [简体中文](v0.3.3.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.3) |
| **v0.3.2** | 2026-09-29 | 9router `v0.5.91` | [English](v0.3.2.en.md) · [简体中文](v0.3.2.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.2) |
| **v0.3.1** | 2026-09-24 | 9router `v0.5.86` | [English](v0.3.1.en.md) · [简体中文](v0.3.1.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.1) |
| **v0.3.0** | 2026-09-23 | 9router `v0.5.81` | [English](v0.3.0.en.md) · [简体中文](v0.3.0.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.0) |

---

## 📌 Release Policy / 版本规范

- **产品版本号 (Product Version)**：真源为 `desktop-tauri/package.json`，遵循语义化版本号（SemVer）。
  CI 会强制 `tauri.conf.json`、`src/shared/constants/config.js`、`Cargo.toml`（含 `Cargo.lock`）与 `CONTEXT.md` 跟它一致
  （`.github/workflows/desktop-tauri.yml` 的「Assert version invariants」）。
- **网关基线号 (Gateway Baseline)**：真源为根目录 `package.json`，与上游 [decolua/9router](https://github.com/decolua/9router) 保持一致，用于 HTTP User-Agent 与请求头对齐，两号解耦运作（详见 [ADR 0004](../adr/0004-version-decoupling.md)）。
- **未发布变更 (Unreleased)**：写在 [unreleased.zh-CN.md](unreleased.zh-CN.md)，**只记 v0.4.2 之后**的改动。仓库根原先的 `CHANGELOG.md` 已移除：它是**上游的产物**（v0.5.69…v0.5.99 全部历史），本仓只在它顶部累积过一个 `# Unreleased` 段，而那段里 v0.3.4–v0.4.2 时期的条目**早已随版本发布**（属重复记录），各版本真实记录以本目录的 `vX.Y.Z` 文件为准。

### 发版规矩（2026-10-12 起）

- **一次发版 = 一个 commit + 一个 tag，tag 之后零提交。** 版本号 bump、说明定稿、版本表新增行
  全在这一个 commit 里；由 `npm run release:prepare <version>` 起手（骨架见 [TEMPLATE.md](TEMPLATE.md)）。
- **正文不放尺寸与校验和表。** 校验和由 CI 生成 `checksums.txt` 并作为 Release 附件发布，
  正文只留一句指路句。安装包**文件名也不再列**——名字由代码定义（`tools/asset.js`），
  Release 页面按平台现成给出。
- **正文不许有占位符、不许有内部话术**（方案代号 / 阶段名 / task 编号 / 自夸）。
  「先发出去、事后回填或精简」这条路已经取消：中文定稿前**全文人工审阅**。
- **语言切换锚点钉 tag**（`blob/vX.Y.Z/…`），不钉 `main`、不用相对路径。英文由定稿中文翻译；
  中文一动，英文重译。
- **已发布的内容不回头**——错字也不改。历史版本（v0.3.0–v0.4.2）保持原样，包括其中的尺寸/SHA 表。
