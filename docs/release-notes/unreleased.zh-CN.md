# Unreleased（未发布变更）

> **只放 v0.4.2（2026-10-09）之后、尚未发布的改动。** 这里可以是写给自己的原始记录（详尽、
> 含证据与内部术语都行）——它**不是**发布物，整理成正文时再精炼。
>
> 仓库根原先的 `CHANGELOG.md` 已移除——它是上游 [decolua/9router](https://github.com/decolua/9router)
> 的产物（v0.5.69…v0.5.99 全部历史），本仓只在它顶部累积过一个 `# Unreleased` 段；
> 而那个段里 **v0.3.4–v0.4.2 时期的绝大多数条目其实早已发布**（例如「并行写入丢使用量记录」、
> 「`text-[Npx]` 失效」、「设置面板双栏」都在 `v0.3.4.zh-CN.md` 里），属于重复记录，
> 因此不再搬运——各版本的真实记录见本目录的 `vX.Y.Z` 文件。

---

## 发版流程（改动前请读完；骨架见 [TEMPLATE.md](./TEMPLATE.md)）

**一次发版 = 一个 commit + 一个 tag，tag 之后零提交。** 顺序如下：

1. `npm run release:prepare <version>`——改 6 处在役版本号（`desktop-tauri/package.json`、
   `tauri.conf.json`、`Cargo.toml` + 重新生成 `Cargo.lock`、`src/shared/constants/config.js`、
   `CONTEXT.md`）、生成 `vX.Y.Z.zh-CN.md` 骨架、在 [README](./README.md) 版本表加一行。
2. 把骨架里的 `<占位>` 换成真内容；中文**全文交人工审阅**，改到点头为止。
3. 按定稿中文翻译 `vX.Y.Z.en.md`（两份都要自足、可单独阅读）。
4. `chore(release): vX.Y.Z` 一个 commit → 打 tag → 推送。**此后不再有任何后续提交。**

### 正文的三条硬规矩

- **不许有占位符**：没有「构建完成后回填」、没有 `~47 MiB`、没有 `TODO`。
  正文里**不放尺寸与校验和表**——`checksums.txt` 已由 CI 生成并作为 Release 附件发布
  （`.github/workflows/release.yml` 里还有一道门禁保证清单覆盖全部产物），正文只留一句指路句。
- **不许有内部话术**：方案代号（「方案 A」）、阶段名、task 编号、以及「100% 保留」「零污染」
  「全绿」这类自夸，一律不写。只写用户可感知的变化。
- **锚点钉 tag，不钉 `main`**：语言切换链接写成
  `https://github.com/kevinjoy89/iRouter/blob/vX.Y.Z/docs/release-notes/vX.Y.Z.en.md`。
  `main` 上的文件随时会被后续版本改动，而 tag 上的就是**发布出去的那一份**。
  （历史遗留：v0.3.0/v0.3.1/v0.3.6/v0.3.7 用的是相对路径锚点，其中有死链——**已发布的不回头修**。）

### 已发布的内容不回头

发出去的说明就是归档：**错字也不改**，宁可留给下个版本。所以"回填""精简"这两个动作在流程里不存在——
它们的根因（正文要写 tag 之后才存在的数据、约束只写在脑子里）已经由上面三条规矩消掉了。
历史版本（v0.3.0–v0.4.2）一律不动，包括其中已经写进去的尺寸/SHA 表。

---

## Fixes

（暂无——v0.4.6 的改动已于 2026-10-30 发布，见 [v0.4.6.zh-CN.md](v0.4.6.zh-CN.md)。此后新增的未发布改动写在这里。）
