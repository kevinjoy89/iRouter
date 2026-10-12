#!/usr/bin/env node
/**
 * release:prepare —— 为一次发版做准备。
 *
 * 它做三件事（对应决策：一次发版 = 一个 commit + 一个 tag，tag 之后零提交）：
 *   ① 改全部在役版本号位置（6 处，含此前没有任何检查的 Cargo 侧与 CONTEXT.md）；
 *   ② 从 docs/release-notes/TEMPLATE.md 生成 vX.Y.Z.zh-CN.md 骨架；
 *   ③ 在 docs/release-notes/README.md 的版本表加一行，并把 `*(Latest)*` 挪过来。
 *
 * **不生成** vX.Y.Z.en.md：英文由人工从**定稿的中文**翻译（中文过审前翻等于白翻）。
 * 所以本脚本跑完还不能打 tag，顺序是：本脚本 → 写中文正文 → 人工审阅 → 定稿 →
 * 人工翻英文 → 一个 commit → tag。
 *
 * 用法：
 *   npm run release:prepare 0.4.3            # 准备 0.4.3
 *   npm run release:prepare -- --check       # 只报告 6 处版本号是否一致，**不写任何文件**
 *   npm run release:prepare 0.4.3 --force    # 允许覆盖已存在的说明文件（默认拒绝）
 *
 * 退出码：0 成功；1 用法/校验/一致性问题。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...seg) => join(REPO_ROOT, ...seg);

const PATH_PKG = "desktop-tauri/package.json";
const PATH_CONF = "desktop-tauri/src-tauri/tauri.conf.json";
const PATH_CARGO_TOML = "desktop-tauri/src-tauri/Cargo.toml";
const PATH_CARGO_LOCK = "desktop-tauri/src-tauri/Cargo.lock";
const PATH_CONFIG_JS = "src/shared/constants/config.js";
const PATH_CONTEXT = "CONTEXT.md";
const PATH_TEMPLATE = "docs/release-notes/TEMPLATE.md";
const PATH_NOTES_README = "docs/release-notes/README.md";

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};
const ok = (msg) => console.log(`✔ ${msg}`);
const info = (msg) => console.log(`  ${msg}`);

// ─────────────────────────────────────────────────────────────
// 读：当前 6 处在役版本号
// ─────────────────────────────────────────────────────────────

/** 每个位置一个 read 函数；读不到/形状变了就抛，绝不静默跳过（静默跳过＝又一次"漏改没人发现"）。 */
const LOCATIONS = [
  {
    file: PATH_PKG,
    label: "产品版本真源",
    read: () => JSON.parse(read(PATH_PKG)).version,
    write: (src, v) => src.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`),
  },
  {
    file: PATH_CONF,
    label: "Tauri 配置（CI 强制相等）",
    read: () => JSON.parse(read(PATH_CONF)).version,
    write: (src, v) => src.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`),
  },
  {
    file: PATH_CARGO_TOML,
    label: "Rust crate（此前无检查）",
    read: () => matchOrDie(read(PATH_CARGO_TOML), /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m, PATH_CARGO_TOML, "[package] version"),
    write: (src, v) => src.replace(/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${v}"`),
  },
  {
    file: PATH_CARGO_LOCK,
    label: "Cargo.lock（与 Cargo.toml 必须同步，否则 --locked 四平台全红）",
    read: () => matchOrDie(read(PATH_CARGO_LOCK), /\[\[package\]\]\nname = "irouter"\nversion = "([^"]+)"/, PATH_CARGO_LOCK, 'name = "irouter"'),
    write: (src, v) => src.replace(/(\[\[package\]\]\nname = "irouter"\nversion = )"[^"]*"/, `$1"${v}"`),
  },
  {
    file: PATH_CONFIG_JS,
    label: "面板回退字面量（CI 强制相等）",
    read: () => matchOrDie(read(PATH_CONFIG_JS), /process\.env\.NEXT_PUBLIC_APP_VERSION\s*\|\|\s*"([^"]+)"/, PATH_CONFIG_JS, "NEXT_PUBLIC_APP_VERSION || \"x.y.z\""),
    write: (src, v) => src.replace(/(process\.env\.NEXT_PUBLIC_APP_VERSION\s*\|\|\s*)"[^"]*"/, `$1"${v}"`),
  },
  {
    file: PATH_CONTEXT,
    label: "CONTEXT.md 词条「当前」（此前无检查）",
    read: () => matchOrDie(read(PATH_CONTEXT), /版本号（当前\s*`([^`]+)`）/, PATH_CONTEXT, "产品版本号（当前 `x.y.z`）"),
    write: (src, v) => src.replace(/(版本号（当前\s*`)[^`]*(`）)/, `$1${v}$2`),
  },
];

function read(rel) {
  const abs = p(rel);
  if (!existsSync(abs)) die(`找不到 ${rel}（仓库根=${REPO_ROOT}）`);
  return readFileSync(abs, "utf8");
}

function matchOrDie(src, re, file, what) {
  const m = src.match(re);
  if (!m) die(`${file} 里找不到 ${what} —— 文件被改过形状？本脚本拒绝猜测，请人工确认后再跑`);
  return m[1];
}

function readAllVersions() {
  return LOCATIONS.map((loc) => ({ ...loc, value: loc.read() }));
}

// ─────────────────────────────────────────────────────────────
// --check：只报告一致性
// ─────────────────────────────────────────────────────────────

function cmdCheck() {
  const rows = readAllVersions();
  const product = rows[0].value;
  console.log(`\n产品版本真源 ${PATH_PKG} = ${product}\n`);
  let bad = 0;
  for (const r of rows) {
    const mark = r.value === product ? "✔" : "✖";
    if (r.value !== product) bad += 1;
    console.log(`  ${mark} ${r.value.padEnd(12)} ${r.file}  — ${r.label}`);
  }
  const baseline = JSON.parse(read("package.json")).version;
  console.log(`\n  ·  上游基线号（应与之解耦）      = ${baseline}`);
  const notes = rows[0].value;
  const zh = `docs/release-notes/v${notes}.zh-CN.md`;
  const en = `docs/release-notes/v${notes}.en.md`;
  console.log(`  ${existsSync(p(zh)) ? "✔" : "✖"} ${zh}`);
  console.log(`  ${existsSync(p(en)) ? "✔" : "✖"} ${en}`);
  if (bad) die(`${bad} 处版本号与真源不一致（见上）`);
  ok("6 处版本号一致");
}

// ─────────────────────────────────────────────────────────────
// prepare：改版本号 + 生成骨架 + 加索引行
// ─────────────────────────────────────────────────────────────

function cmdPrepare(version, { force }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(version)) {
    die(`非法版本号 ${JSON.stringify(version)}（期望 x.y.z，可带 -预发布段）`);
  }

  const rows = readAllVersions();
  const current = rows[0].value;
  if (current === version) die(`产品版本已经是 ${version}，无需准备（要重跑生成物请先 bump 到别的版本）`);

  const notesZh = `docs/release-notes/v${version}.zh-CN.md`;
  if (existsSync(p(notesZh)) && !force) {
    die(`${notesZh} 已存在。确认要覆盖请加 --force（覆盖会丢掉已写的中文正文）`);
  }

  const changed = [];
  for (const r of rows) {
    if (r.value === version) {
      info(`跳过（已是目标版本）：${r.file}`);
      continue;
    }
    const src = read(r.file);
    const next = r.write(src, version);
    if (next === src) die(`${r.file} 的版本号替换没有产生变化——正则没命中，拒绝写坏文件`);
    writeFileSync(p(r.file), next);
    changed.push(`${r.file}  ${r.value} → ${version}`);
  }

  // 骨架：从 TEMPLATE.md 的「<下面这段就是文件内容…>」标记之后取，逐字复制。
  const tpl = read(PATH_TEMPLATE);
  const marker = tpl.indexOf("<下面这段就是文件内容");
  if (marker < 0) die(`${PATH_TEMPLATE} 里找不到骨架起始标记（「<下面这段就是文件内容」那条引用行）`);
  const nl = tpl.indexOf("\n", marker);
  let body = tpl.slice(nl + 1).trimStart();
  body = body.split(`v<X.Y.Z>`).join(`v${version}`).split(`<X.Y.Z>`).join(version);
  if (/<X\.Y\.Z>/.test(body)) die("骨架里仍有未替换的 <X.Y.Z> 占位符——模板标记写法变了？");
  writeFileSync(p(notesZh), body);

  updateIndex({ version });

  console.log("");
  for (const c of changed) ok(c);
  ok(`生成 ${notesZh}（骨架，待写正文）`);
  ok(`在 ${PATH_NOTES_README} 版本表插入 v${version} 行并移动 *(Latest)*`);
  console.log(`
──────────────────────────────────────────────
下一步（顺序不能换）：
  1. 写 ${notesZh} 的正文（只写用户可感知的变化；不写尺寸/SHA、不写内部代号、不留占位符）
  2. 把中文全文交人工审阅，改到点头为止
  3. 按定稿中文翻译 docs/release-notes/v${version}.en.md（锚点已写成 blob/v${version}/…）
  4. 一个 commit：chore(release): v${version}
  5. git tag -a v${version} -m "v${version}" && git push origin v${version}
     打 tag 前可先跑便宜预检：Actions → Release → Run workflow（勾 full_build=false，约 1 分钟）
  ⚠️ tag 之后不再有任何提交（已发布的内容不回头）。
──────────────────────────────────────────────`);
}

/** 版本表：`| **vX.Y.Z** *(Latest)* | date | 9router \`baseline\` | links |`，插在表头下第一行。 */
function updateIndex({ version }) {
  const baseline = JSON.parse(read("package.json")).version;
  const date = new Date().toISOString().slice(0, 10);
  const gh = `https://github.com/kevinjoy89/iRouter/releases/tag/v${version}`;
  const newRow =
    `| **v${version}** *(Latest)* | ${date} | 9router \`v${baseline}\` | ` +
    `[English](v${version}.en.md) · [简体中文](v${version}.zh-CN.md) · [GitHub Release](${gh}) |`;

  const lines = read(PATH_NOTES_README).split("\n");
  if (lines.some((l) => l.startsWith(`| **v${version}**`))) {
    info(`版本表里已有 v${version} 行，跳过`);
  } else {
    // 插到 Unreleased 那一行**之后**（表格是「Unreleased 在上、版本按新→旧往下」）。
    // 早先写成「表头分隔行之后」，结果新版本行被插到了 Unreleased 之上——实测抓到。
    const anchor = lines.findIndex((l) => l.startsWith("| **Unreleased**"));
    const sep = lines.findIndex((l) => /^\|\s*:?-{3,}/.test(l));
    const at = anchor >= 0 ? anchor + 1 : sep + 1;
    if (at <= 0) die(`${PATH_NOTES_README} 里找不到版本表的插入点（既无 Unreleased 行也无表头分隔行）`);
    lines.splice(at, 0, newRow);
  }
  // 唯一化：(Latest) 只允许出现在最新那一行——旧行的去掉，重复版本行（同版本重跑）删掉。
  const seen = new Set();
  const out = [];
  let latestTaken = false;
  for (const line of lines) {
    const m = line.match(/^\| \*\*v([0-9][0-9A-Za-z.-]*)\*\*/);
    if (m) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
    }
    let l = line;
    if (m && m[1] !== version && l.includes("*(Latest)*")) l = l.replace(" *(Latest)*", "");
    if (m && m[1] === version) {
      if (latestTaken) l = l.replace(" *(Latest)*", "");
      latestTaken = true;
    }
    // 旧版本行的 `· [GitHub Release](…)` 此前每次发版都要手工补，这里一并补上（已有则不动）。
    if (m && m[1] !== version && !l.includes("[GitHub Release]")) {
      l = l.replace(/\s*\|\s*$/, "") + ` · [GitHub Release](https://github.com/kevinjoy89/iRouter/releases/tag/v${m[1]}) |`;
    }
    out.push(l);
  }
  writeFileSync(p(PATH_NOTES_README), out.join("\n"));
}

// ─────────────────────────────────────────────────────────────
// argv
// ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const force = argv.includes("--force");
if (argv.includes("--check")) {
  cmdCheck();
} else {
  const version = argv.find((a) => !a.startsWith("-"));
  if (!version) {
    die("用法：npm run release:prepare <version> ｜ npm run release:prepare -- --check");
  }
  cmdPrepare(version.replace(/^v/, ""), { force });
}
