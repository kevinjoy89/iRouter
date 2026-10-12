# 发版说明模板（TEMPLATE）

> **这是骨架，不是说明文件。** 发版时用它生成 `vX.Y.Z.zh-CN.md`（`npm run release:prepare <version>`
> 会自动生成，把 `<占位>` 逐个替换掉）。**本文件本身永不发布、永不进 CI 正文。**
>
> 两条硬约束（写在 [unreleased.zh-CN.md](unreleased.zh-CN.md) 头部，此处只复述）：
> 1. **不许出现任何占位符或估算值**——没有「构建完成后回填」，没有 `~47 MiB`，没有 `TODO`。
>    尺寸与校验和**不进正文**：它们以 `checksums.txt` 附件形式随 Release 发布。
> 2. **只写用户可感知的变化**——不写内部方案代号、阶段名、task 编号，不写「100% 保留」「零污染」
>    「全绿」这类自夸。
>
> 中文定稿后由人工翻译成 `vX.Y.Z.en.md`；**中文一动，英文必须重译**（两份都必须自足、可单独阅读）。
>
> 另一条口径：**版本相关的描述里不再提上游项目**。首行只给 iRouter 自己的定位（见下方骨架第一句），
> 正文不要出现「基于 X 定制」「深度定制」这类表述——上游信息在仓库 README 里说一次就够了。

---

<下面这段就是文件内容，从 `# iRouter v` 开始逐字复制>

# iRouter v<X.Y.Z> 发版说明 (Release Notes)

[English Version](https://github.com/kevinjoy89/iRouter/blob/v<X.Y.Z>/docs/release-notes/v<X.Y.Z>.en.md) | [GitHub Release 页面](https://github.com/kevinjoy89/iRouter/releases/tag/v<X.Y.Z>)

> **iRouter** 是跨平台的大模型路由网关桌面客户端（Tauri v2 + Bun 轻量架构）。
> **v<X.Y.Z> 核心重点**：<一句话，说清这一版主要解决了什么。>

---

### 🌟 核心变化

<3～6 条，每条一句话，写"改了什么 + 对用户意味着什么"。这一节同时也是发给用户看的全部重点，
不要写实现细节；细节在 commit 与 diff 里。>

- **<模块>**：<用户能感知到的变化>；
- **<模块>**：<用户能感知到的变化>。

---

> **校验**：本页附件 `checksums.txt` 含各平台安装包的 SHA-256 校验和；下载后可比对。
> 支持平台：macOS（Apple Silicon / Intel）、Windows x64（安装版 / 便携版）、Linux x64（deb / tar.gz）。
