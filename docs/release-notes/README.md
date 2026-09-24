# iRouter Release Notes | 版本发布说明

本目录归档 iRouter 各正式发布版本的多语言详细发版说明（Release Notes）。
This directory archives detailed multi-language Release Notes for all official releases of iRouter.

---

## 📑 Versions / 版本列表

| Version / 版本 | Release Date / 发布日期 | Gateway Baseline / 网关基线 | Release Notes / 发版说明 |
| :--- | :---: | :---: | :--- |
| **v0.3.1** *(Latest)* | 2026-09-24 | 9router `v0.5.86` | [English](v0.3.1.en.md) · [简体中文](v0.3.1.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.1) |
| **v0.3.0** | 2026-09-23 | 9router `v0.5.81` | [English](v0.3.0.en.md) · [简体中文](v0.3.0.zh-CN.md) · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.0) |

---

## 📌 Release Policy / 版本规范

- **产品版本号 (Product Version)**：真源为 `desktop/package.json`，遵循语义化版本号（SemVer）。
- **网关基线号 (Gateway Baseline)**：真源为根目录 `package.json`，与上游 [decolua/9router](https://github.com/decolua/9router) 保持一致，用于 HTTP User-Agent 与请求头对齐，两号解耦运作（详见 [ADR 0004](../adr/0004-version-decoupling.md)）。
