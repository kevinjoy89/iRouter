#!/usr/bin/env node
/**
 * Phase 5 打包收尾：把 Tauri 的默认产物名改成 `desktop/updater/asset.js` 期望的名字，
 * 自研 zip / tar.gz 便携归档，逐字断言命名规则，最后生成 checksums.txt。
 *
 * 依据：docs/plans/2026-10-07-tauri-bun-sidecar-packaging.md
 *   §5.1 `desktop/updater/asset.js` 的逐字规则（`selectAsset` 用的是**字符串全等**）
 *   §5.3 Tauri 默认产物名（`iRouter_0.3.7_aarch64.dmg` / `_x64-setup.exe` / `_amd64.deb`）
 *   §5.4 重命名映射表
 *   §5.5 zip / tar.gz 的目录树
 *   §5.6 用 `getExpectedAssetName` 做全等断言，防「改名切断老版本更新」复发
 *   §6.1 Windows 便携 zip 只能有相对路径、不要 symlink
 *   §6.3 tar.gz 没有依赖元数据 → 顶层放 README-linux.txt
 *
 * 三条硬规则（都是踩过坑的）：
 *   1. **先改名、再算 checksums.txt**：校验和必须对应发布出去的文件名。
 *   2. **不猜**：某种产物找到 0 个或 >1 个 → exit 1（用 `--target` 消歧义）。
 *   3. **命名门禁**：每个产物的 basename 都要与 `getExpectedAssetName(...)` 全等，
 *      并且能被 `selectAsset([{name}], …)` 精确命中（那才是老版本真正走的代码路径）。
 *
 * 为什么不用 `zip` / `tar` 命令：三种 runner 上可用的实现与参数各不相同（GNU tar 不会
 * 无损造 zip、Windows 的 bsdtar 参数又不同）。这里用 Node 内置 zlib 自写 ZIP(store/deflate)
 * 与 ustar(+PAX 长路径) 写入器，三平台行为一致，还能显式控制执行位（§5.5 要求 tar 保留 +x）。
 *
 * 用法：
 *   node scripts/pack-artifacts.mjs [--target <triple>] [--out <dir>] [--dry-run | --verify]
 *
 *   --target   Tauri 构建时用的目标三元组（macOS 上必须给，因为一次 CI 会出两个 dmg）
 *   --out      产物输出目录，默认 `desktop-tauri/artifacts/`
 *   --dry-run  只打印映射与来源，不写任何文件（本地没构建时也能校验命名规则）
 *   --verify   发布侧 fail-closed 门禁：checksums.txt 必须存在、覆盖全部产物、哈希逐个复核
 *              （更新器在无清单时会跳过哈希校验，所以这个洞只能在发布侧堵）
 *
 * @author iRouter
 * @since 2026-10-08
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = resolve(HERE, ".."); // desktop-tauri/
const SRC_TAURI = join(SHELL_ROOT, "src-tauri");
const REPO_ROOT = resolve(SHELL_ROOT, "..");

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
};
const DRY_RUN = argv.includes("--dry-run");
const VERIFY = argv.includes("--verify");
const TARGET_TRIPLE = argOf("--target");
const OUT_DIR = resolve(argOf("--out") ?? join(SHELL_ROOT, "artifacts"));

const fail = (msg) => {
  console.error(`[pack] ✖ ${msg}`);
  process.exit(1);
};
const log = (msg) => console.log(`[pack] ${msg}`);

// ---------------------------------------------------------------- 版本与命名真源

/** 产品版本真源 = desktop-tauri/package.json（ADR-0004 修订版：Phase 6 把真源从旧壳目录搬到产物包）；
 *  `tauri.conf.json > version` 必须与它一致。 */
const productVersion = JSON.parse(
  readFileSync(join(REPO_ROOT, "desktop-tauri", "package.json"), "utf8"),
).version;

const tauriConf = JSON.parse(readFileSync(join(SRC_TAURI, "tauri.conf.json"), "utf8"));

// `<v>` 在任何产物名里都**不带 v 前缀**（asset.js:19 会剥掉 v，而 Tauri 的 version 本来就无前缀）。
const V = String(productVersion).replace(/^v/i, "");
if (!V || V !== String(tauriConf.version).replace(/^v/i, "")) {
  fail(
    `版本漂移：desktop-tauri/package.json=${productVersion}，tauri.conf.json=${tauriConf.version} —— 发版前必须同步（ADR-0004）`,
  );
}

const PRODUCT_NAME = tauriConf.productName;
if (PRODUCT_NAME !== "iRouter") {
  fail(
    `productName=${PRODUCT_NAME}，但 tools/asset.js 的规则硬编码 "iRouter-…#" 前缀；改名会切断老版本更新，拒绝继续`,
  );
}
// zip / tar.gz 的目录树（§5.5）按 mainBinaryName 命名，deb / NSIS 同源，所以必须是 iRouter。
const MAIN_BINARY_NAME = tauriConf.mainBinaryName ?? "irouter";
if (MAIN_BINARY_NAME !== "iRouter") {
  fail(
    `mainBinaryName=${MAIN_BINARY_NAME}，§5.5 的便携归档树要求 iRouter（与 deb 的 /usr/bin/iRouter 对齐）；请在 tauri.conf.json 里设 "mainBinaryName": "iRouter"`,
  );
}

// ------------------------------------------------------- §5.4 映射表（唯一的真相）

/**
 * kind → { 平台三元组, Tauri 默认产物名, 发布名 }
 * 默认产物名的格式逐条来自 tauri-bundler（tag tauri-v2.12.1）：
 *   dmg  `{productName}_{version}_{x64|aarch64|universal}.dmg`   bundle/macos/dmg/mod.rs#L41-L56
 *   nsis `{productName}_{version}_{arch}-setup.exe`              bundle/windows/nsis/mod.rs#L653-L669
 *   deb  `{productName}_{version}_{amd64}.deb`                   bundle/linux/debian.rs#L40-L66
 */
const KINDS = {
  "macos-arm64": {
    platform: "darwin",
    arch: "arm64",
    installSource: undefined,
    tauriDefault: (name) => `dmg/${PRODUCT_NAME}_${V}_aarch64.dmg`,
    canonical: () => `${PRODUCT_NAME}-${V}-macos-arm64.dmg`,
    action: "rename",
  },
  "macos-amd64": {
    platform: "darwin",
    arch: "x64",
    installSource: undefined,
    tauriDefault: () => `dmg/${PRODUCT_NAME}_${V}_x64.dmg`,
    canonical: () => `${PRODUCT_NAME}-${V}-macos-amd64.dmg`,
    action: "rename",
  },
  "windows-installer": {
    platform: "win32",
    arch: "x64",
    installSource: undefined,
    tauriDefault: () => `nsis/${PRODUCT_NAME}_${V}_x64-setup.exe`,
    canonical: () => `${PRODUCT_NAME}-${V}-windows-amd64-installer.exe`,
    action: "rename",
  },
  "windows-portable": {
    platform: "win32",
    arch: "x64",
    installSource: "portable",
    tauriDefault: null, // Tauri 没有 zip target（§5.3）
    canonical: () => `${PRODUCT_NAME}-${V}-windows-amd64-portable.zip`,
    action: "zip",
  },
  "linux-deb": {
    platform: "linux",
    arch: "x64",
    installSource: undefined,
    tauriDefault: () => `deb/${PRODUCT_NAME}_${V}_amd64.deb`,
    canonical: () => `${PRODUCT_NAME}-${V}-linux-amd64.deb`,
    action: "rename",
  },
  "linux-targz": {
    platform: "linux",
    arch: "x64",
    installSource: "tarball",
    tauriDefault: null, // Tauri 没有 tar.gz target（§5.3）
    canonical: () => `${PRODUCT_NAME}-${V}-linux-amd64.tar.gz`,
    action: "tar.gz",
  },
};

/** 本平台真正要产出的 kind（与 CI 的 `--bundles` 一一对应）。 */
function kindsForHost() {
  switch (process.platform) {
    case "darwin":
      return TARGET_TRIPLE === "x86_64-apple-darwin"
        ? ["macos-amd64"]
        : TARGET_TRIPLE === "aarch64-apple-darwin"
          ? ["macos-arm64"]
          : ["macos-arm64", "macos-amd64"]; // 不带 --target 时允许一次出两个（按 arch 各自匹配）
    case "win32":
      return ["windows-installer", "windows-portable"];
    case "linux":
      return ["linux-deb", "linux-targz"];
    default:
      fail(`不支持的宿主平台 ${process.platform}（打包方案只覆盖 macOS / Windows / Linux）`);
  }
}

/** 目标三元组：CI 显式传，本地按宿主推断。 */
function targetTriple() {
  if (TARGET_TRIPLE) return TARGET_TRIPLE;
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

// --------------------------------------------- §5.6 复用 asset.js，不重写命名规则

const require = createRequire(import.meta.url);
const assetRulesPath = join(REPO_ROOT, "tools", "asset.js");
const { getExpectedAssetName, selectAsset } = require(assetRulesPath);

/** 全等断言：规则表本身、以及「老版本 selectAsset 能不能精确命中这个名字」。 */
function assertRulesCase(platform, arch, installSource, expected) {
  const got = getExpectedAssetName(V, platform, arch, installSource);
  if (got !== expected) {
    fail(
      `asset.js 规则漂移：getExpectedAssetName(${V}, ${platform}, ${arch}, ${installSource}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`,
    );
  }
  // selectAsset 走的是 `assets.find(a => a.name === expectedName)`（asset.js:68），是**字符串全等**。
  const picked = selectAsset([{ name: expected }], V, platform, arch, installSource);
  if (!picked || picked.name !== expected) {
    fail(
      `selectAsset 未能精确命中 ${expected}（平台 ${platform}/${arch}，installSource=${installSource}）—— 老版本会显示「无更新产物」`,
    );
  }
}

/** §5.2 六种形态的逐字期望名。CI 每次跑，等于把「名字对不对」变成机器断言。 */
function assertRuleTable() {
  const cases = [
    ["darwin", "arm64", undefined, `${PRODUCT_NAME}-${V}-macos-arm64.dmg`],
    ["darwin", "x64", undefined, `${PRODUCT_NAME}-${V}-macos-amd64.dmg`],
    ["win32", "x64", undefined, `${PRODUCT_NAME}-${V}-windows-amd64-installer.exe`],
    ["win32", "x64", "portable", `${PRODUCT_NAME}-${V}-windows-amd64-portable.zip`],
    ["linux", "x64", undefined, `${PRODUCT_NAME}-${V}-linux-amd64.deb`],
    ["linux", "x64", "tarball", `${PRODUCT_NAME}-${V}-linux-amd64.tar.gz`],
  ];
  for (const [platform, arch, installSource, expected] of cases) {
    assertRulesCase(platform, arch, installSource, expected);
  }
  log(`命名规则门禁通过：asset.js 的 6 条规则与 §5.2 逐字一致（V=${V}）`);
}

// --------------------------------------------------------------- 输入：Tauri 产物

/** 递归列目录（返回相对 bundle 根的 POSIX 路径）。 */
function walkFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, base));
    else if (entry.isFile()) out.push({ abs, rel: relative(base, abs).split(sep).join("/") });
  }
  return out;
}

/** 只在 `target[/<triple>]/release/bundle` 下找，绝不扫 target/ 全树（那里有成千上万个中间产物）。 */
function bundleFiles() {
  const bundleDir = TARGET_TRIPLE
    ? join(SRC_TAURI, "target", TARGET_TRIPLE, "release", "bundle")
    : join(SRC_TAURI, "target", "release", "bundle");
  const files = walkFiles(bundleDir);
  log(`扫描 ${relative(REPO_ROOT, bundleDir)}：${files.length} 个文件`);
  return files;
}

/** 某个 kind 的 Tauri 默认产物：0 个 / >1 个都不猜。 */
function findOne(kind, files) {
  const spec = KINDS[kind];
  if (!spec.tauriDefault) return undefined; // 自研归档，没有 Tauri 来源
  const wanted = spec.tauriDefault();
  const wantBase = wanted.split("/").pop();
  const hits = files.filter((f) => f.rel.split("/").pop() === wantBase);
  if (hits.length > 1) {
    fail(
      `${kind}：找到 ${hits.length} 个 ${wantBase}（${hits.map((h) => relative(REPO_ROOT, h.abs)).join(", ")}）—— 用 --target 指定三元组，或清理旧构建`,
    );
  }
  return hits[0];
}

/** 主程序：mainBinaryName 生效后 tauri-cli 会把 cargo 产物 rename 成它（desktop.rs rename_app）。 */
function mainBinary() {
  const releaseDir = TARGET_TRIPLE
    ? join(SRC_TAURI, "target", TARGET_TRIPLE, "release")
    : join(SRC_TAURI, "target", "release");
  const exe = process.platform === "win32" ? ".exe" : "";
  const path = join(releaseDir, `${MAIN_BINARY_NAME}${exe}`);
  if (!existsSync(path)) {
    fail(`找不到主程序 ${path}（检查 tauri.conf.json 的 mainBinaryName 与 --target 是否与构建一致）`);
  }
  return path;
}

/** 已 stage 的 sidecar：stage-sidecar.mjs 落盘在 binaries/irouter-bun-<triple>[.exe]。 */
function stagedSidecar() {
  const triple = targetTriple();
  const exe = process.platform === "win32" ? ".exe" : "";
  const path = join(SRC_TAURI, "binaries", `irouter-bun-${triple}${exe}`);
  if (!existsSync(path)) {
    fail(`找不到 sidecar ${path} —— 先跑 node scripts/stage-sidecar.mjs --target ${triple}`);
  }
  return path;
}

const GATEWAY_DIR = join(REPO_ROOT, "desktop", "build", "gateway", "server");

function assertGateway() {
  const entry = join(GATEWAY_DIR, "custom-server.js");
  if (!existsSync(entry)) {
    fail(`网关负载缺失：${entry}（先跑 npm --prefix desktop run build-server）`);
  }
  const files = walkFiles(GATEWAY_DIR);
  const bytes = files.reduce((n, f) => n + statSync(f.abs).size, 0);
  const mib = bytes / 1048576;
  if (mib < 10) {
    fail(`网关负载只有 ${mib.toFixed(1)} MiB（实测约 50 MiB 文件字节 / du 报 59 MiB）—— 疑似空包，拒绝归档`);
  }
  // 注意口径：这里统计的是文件字节总和（50.0 MiB），方案 §8 的 55–65 MiB 是 `du -sh` 的块级读数。
  // 两端都不做硬断言，只提示——真正的「负载是不是半成品」由 custom-server.js 存在 + 启动冒烟判定。
  if (mib < 40 || mib > 70) {
    console.warn(`[pack] ⚠ 网关负载 ${mib.toFixed(1)} MiB（文件字节）超出 40–70 MiB 的经验区间，请确认不是半成品`);
  }
  log(`网关负载：${files.length} 个文件 / ${mib.toFixed(1)} MiB`);
  return files;
}

// ----------------------------------------------------- 自研归档：ZIP（store/deflate）

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 时间（固定成 1980-01-01 会让某些工具报警，用构建时刻即可）。 */
function dosDateTime(d = new Date()) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

/**
 * 写 ZIP。entries: [{ name, data: Buffer, mode }]
 * 只用到 store(0) 与 deflate(8) 两种方法，外部属性写 unix 权限位（解压后执行位正确）。
 */
function writeZip(outPath, entries) {
  const { time, date } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const store = deflated.length >= entry.data.length;
    const payload = store ? entry.data : deflated;
    const method = store ? 0 : 8;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // version made by: unix / 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((entry.mode & 0xffff) << 16) >>> 0, 38); // external attrs = unix mode
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outPath, Buffer.concat([...localParts, centralBuf, eocd]));
}

// ------------------------------------------------- 自研归档：tar.gz（ustar + PAX）

function tarOctal(value, length) {
  const s = value.toString(8);
  return `${"0".repeat(Math.max(0, length - 1 - s.length))}${s}\0`;
}

/** 512 字节 ustar 头；name 过长时由调用方先写 PAX 扩展头。 */
function tarHeader({ name, prefix, mode, size, mtime, type }) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf8");
  buf.write(tarOctal(mode & 0o7777, 8), 100, 8, "ascii");
  buf.write(tarOctal(0, 8), 108, 8, "ascii"); // uid
  buf.write(tarOctal(0, 8), 116, 8, "ascii"); // gid
  buf.write(tarOctal(size, 12), 124, 12, "ascii");
  buf.write(tarOctal(mtime, 12), 136, 12, "ascii");
  buf.write("        ", 148, 8, "ascii"); // 校验和先填空格
  buf.write(type, 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  buf.write("root", 265, 32, "ascii");
  buf.write("root", 297, 32, "ascii");
  if (prefix) buf.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(`${tarOctal(sum, 7)} `, 148, 8, "ascii");
  return buf;
}

/** 把长路径拆成 ustar 的 prefix+name；拆不动返回 null（调用方改用 PAX）。 */
function splitUstarName(path) {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  return null;
}

/** PAX 扩展头（typeflag 'x'）：长度前缀的记录格式 `"%d %s=%s\n"`，长度含自身。 */
function paxHeader(recordKey, recordValue, name) {
  let body = `${recordKey}=${recordValue}\n`;
  let length = Buffer.byteLength(body, "utf8") + 3; // ' ' + '\n' 之外还要算上数字本身
  while (Buffer.byteLength(`${length} ${body}`, "utf8") !== length) {
    length = Buffer.byteLength(`${length} ${body}`, "utf8");
  }
  const payload = Buffer.from(`${length} ${body}`, "utf8");
  const headerName = `PaxHeaders/${name}`.slice(0, 100);
  const header = tarHeader({
    name: headerName,
    prefix: "",
    mode: 0o644,
    size: payload.length,
    mtime: Math.floor(Date.now() / 1000),
    type: "x",
  });
  return Buffer.concat([header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512)]);
}

/**
 * 写 tar.gz。entries: [{ name, data: Buffer, mode }]
 * 目录项自动补齐（取每个条目的所有上级目录），执行位从 mode 带过去。
 */
function writeTarGz(outPath, entries) {
  const mtime = Math.floor(Date.now() / 1000);
  const dirs = new Map();
  for (const entry of entries) {
    const parts = entry.name.split("/");
    for (let i = 1; i < parts.length; i++) dirs.set(parts.slice(0, i).join("/"), true);
  }
  const all = [
    ...[...dirs.keys()].sort().map((name) => ({ name, isDir: true, mode: 0o755 })),
    ...[...entries].sort((a, b) => a.name.localeCompare(b.name)),
  ];

  const chunks = [];
  for (const item of all) {
    const name = item.isDir ? `${item.name}/` : item.name;
    const data = item.isDir ? Buffer.alloc(0) : item.data;
    const split = splitUstarName(name);
    if (!split) chunks.push(paxHeader("path", name, name.split("/").pop().slice(0, 80)));
    chunks.push(
      tarHeader({
        name: split ? split.name : name.slice(0, 100),
        prefix: split ? split.prefix : "",
        mode: item.mode,
        size: data.length,
        mtime,
        type: item.isDir ? "5" : "0",
      }),
    );
    if (data.length) {
      chunks.push(data);
      chunks.push(Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  chunks.push(Buffer.alloc(1024)); // 两个全零块收尾
  writeFileSync(outPath, zlib.gzipSync(Buffer.concat(chunks), { level: 9 }));
}

// ------------------------------------------------------------------ 归档内容树

function gatewayEntries(prefix) {
  const files = assertGateway();
  return files.map((f) => ({
    name: `${prefix}${f.rel}`,
    data: readFileSync(f.abs),
    mode: 0o644,
  }));
}

/** §5.5 Windows 便携 zip：与 NSIS 装出来的目录同构（exe 同级有 irouter-bun.exe 与 gateway/）。 */
function zipEntriesForWindows() {
  return [
    { name: `${MAIN_BINARY_NAME}.exe`, data: readFileSync(mainBinary()), mode: 0o755 },
    { name: "irouter-bun.exe", data: readFileSync(stagedSidecar()), mode: 0o755 },
    ...gatewayEntries("gateway/"),
  ];
}

/** §5.5 Linux tar.gz：镜像 deb 的 usr/ 树（exe_dir/../lib/iRouter 才能 canonicalize 成功）。 */
function tarEntriesForLinux() {
  return [
    { name: `usr/bin/${MAIN_BINARY_NAME}`, data: readFileSync(mainBinary()), mode: 0o755 },
    { name: "usr/bin/irouter-bun", data: readFileSync(stagedSidecar()), mode: 0o755 },
    ...gatewayEntries("usr/lib/iRouter/gateway/"),
    // §6.3：tar.gz 没有依赖元数据，这条唯一被批准的例外必须写在包里。
    {
      name: "README-linux.txt",
      data: Buffer.from(
        [
          "iRouter (Linux tar.gz 便携包)",
          "",
          "运行依赖（tar.gz 没有包管理器元数据，需自行安装）：",
          "  libwebkit2gtk-4.1-0  libgtk-3-0        # 运行时必需",
          "  libayatana-appindicator3-1            # 托盘图标需要",
          "",
          "安装：把 usr/ 的内容按原样放到系统根目录，例如",
          "  sudo tar -xzf <本包> -C / --strip-components=0",
          "  iRouter",
          "",
          "目录树：usr/bin/iRouter（壳）、usr/bin/irouter-bun（网关运行时）、",
          "        usr/lib/iRouter/gateway/**（网关负载）",
          "",
        ].join("\n"),
        "utf8",
      ),
      mode: 0o644,
    },
  ];
}

// ------------------------------------------------------------------------ 主流程

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * `--verify`：发布侧的 fail-closed 门禁。
 *
 * 为什么单独存在：更新器在**拿不到 `checksums.txt` 时会跳过哈希校验**（与 Electron 版行为对齐），
 * 所以「清单必须存在且完整」只能在**发布侧**强制。任何一条不满足即 exit 1，坏发版上不了架。
 *   1. `checksums.txt` 必须存在且非空；
 *   2. 目录里的每个产物都必须且只被清单覆盖一次，哈希与磁盘一致（重新计算，不信任写入时的值）；
 *   3. 清单里不得有磁盘上不存在的条目；
 *   4. 本平台应有的产物名（§5.4 映射表）必须全在清单里。
 */
function verifyManifest(plan) {
  const manifestPath = join(OUT_DIR, "checksums.txt");
  if (!existsSync(manifestPath)) {
    fail(
      `缺少 ${relative(REPO_ROOT, manifestPath)} —— 发布物必须带 checksums.txt：客户端在无清单时会跳过哈希校验（供应链风险），因此这里 fail-closed`,
    );
  }
  const text = readFileSync(manifestPath, "utf8").trim();
  if (!text) fail("checksums.txt 是空的");

  const manifest = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) fail(`checksums.txt 行格式不是 "<sha256>  <文件名>"：${line}`);
    if (manifest.has(m[2])) fail(`checksums.txt 里 ${m[2]} 重复出现`);
    manifest.set(m[2], m[1]);
  }

  const onDisk = readdirSync(OUT_DIR)
    .filter((name) => name !== "checksums.txt")
    .sort();
  for (const name of onDisk) {
    const declared = manifest.get(name);
    if (!declared) fail(`产物 ${name} 不在 checksums.txt 里（清单与发布物不一致）`);
    const actual = sha256(join(OUT_DIR, name));
    if (actual !== declared) {
      fail(`产物 ${name} 的 SHA-256 与清单不符：清单 ${declared}，实测 ${actual}`);
    }
  }
  for (const name of manifest.keys()) {
    if (!onDisk.includes(name)) fail(`checksums.txt 声明的 ${name} 在磁盘上不存在`);
  }

  const expected = plan.map((item) => item.canonicalName);
  const alternativeDefaults = process.platform === "darwin" && !TARGET_TRIPLE;
  if (alternativeDefaults) {
    if (!expected.some((name) => manifest.has(name))) {
      fail(`清单里一个 dmg 都没有（期望 ${expected.join(" 或 ")}）`);
    }
  } else {
    for (const name of expected) {
      if (!manifest.has(name)) fail(`清单缺少本平台应有的产物 ${name}`);
    }
  }

  log(`--verify 通过：checksums.txt 覆盖 ${manifest.size} 个产物，哈希全部复核一致`);
  for (const [name, hash] of [...manifest.entries()].sort()) log(`  ${hash}  ${name}`);
}

function main() {
  log(`版本 ${V}（desktop/package.json ↔ tauri.conf.json 一致）`);
  log(`目标三元组 ${targetTriple()}｜宿主 ${process.platform}/${process.arch}`);
  assertRuleTable();

  const kinds = kindsForHost();
  const files = DRY_RUN || VERIFY ? [] : bundleFiles();

  const plan = []; // { kind, spec, sourceAbs|null, canonicalName }
  for (const kind of kinds) {
    const spec = KINDS[kind];
    const found = DRY_RUN || VERIFY ? undefined : findOne(kind, files);
    const canonicalName = spec.canonical();
    // 逐字对齐：发布名必须与 asset.js 算出来的名字全等（防「改名切断老版本更新」）。
    assertRulesCase(spec.platform, spec.arch, spec.installSource, canonicalName);
    plan.push({ kind, spec, sourceAbs: found ? found.abs : undefined, canonicalName });
  }

  if (VERIFY) {
    verifyManifest(plan);
    return;
  }

  if (DRY_RUN) {
    log("--dry-run：只打印映射，不写文件");
    for (const item of plan) {
      const from = item.spec.tauriDefault
        ? item.spec.tauriDefault()
        : item.spec.action === "zip"
          ? "（自研归档）iRouter.exe + irouter-bun.exe + gateway/**"
          : "（自研归档）usr/bin/{iRouter,irouter-bun} + usr/lib/iRouter/gateway/**";
      log(`  ${item.kind.padEnd(18)} ${from}  →  ${item.canonicalName}`);
    }
    log(`输出目录（未写入）：${relative(REPO_ROOT, OUT_DIR)}`);
    return;
  }

  // 0 个 = 该 kind 压根没构建出来；>1 个 = 已经在 findOne 里失败。都不猜。
  // 例外：macOS 不带 --target 时只出宿主架构那一个 dmg，所以两个 dmg 是「至少命中一个」。
  const alternativeDefaults = process.platform === "darwin" && !TARGET_TRIPLE;
  const missing = plan.filter((item) => item.spec.tauriDefault && !item.sourceAbs);
  if (alternativeDefaults) {
    if (missing.length === plan.filter((i) => i.spec.tauriDefault).length) {
      fail(
        `一个 dmg 都没找到（期望 ${plan.filter((i) => i.spec.tauriDefault).map((m) => m.spec.tauriDefault()).join(" 或 ")}）—— 先跑 tauri build，或用 --target 指定三元组`,
      );
    }
  } else if (missing.length) {
    fail(
      `以下产物未找到：${missing.map((m) => `${m.kind}（期望 ${m.spec.tauriDefault()}）`).join("、")} —— 先跑 tauri build，或用 --target 指定正确三元组`,
    );
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // 1) 改名（Tauri 没有 artifactName 之类的字段，只能打包后改）
  for (const item of plan) {
    const dest = join(OUT_DIR, item.canonicalName);
    if (item.spec.action !== "rename") continue;
    const size = statSync(item.sourceAbs).size;
    if (size <= 0) fail(`${item.kind}：源文件 ${item.sourceAbs} 体积为 0`);
    copyFileSync(item.sourceAbs, dest);
    log(`改名 ${item.spec.tauriDefault()} → ${item.canonicalName}（${(size / 1048576).toFixed(1)} MiB）`);
  }

  // 2) 自研归档（Tauri 没有 zip / tar.gz target）
  for (const item of plan) {
    const dest = join(OUT_DIR, item.canonicalName);
    if (item.spec.action === "zip") {
      const entries = zipEntriesForWindows();
      writeZip(dest, entries);
      log(`归档 ${item.canonicalName}（${entries.length} 项，${(statSync(dest).size / 1048576).toFixed(1)} MiB）`);
    } else if (item.spec.action === "tar.gz") {
      const entries = tarEntriesForLinux();
      writeTarGz(dest, entries);
      log(`归档 ${item.canonicalName}（${entries.length} 项，${(statSync(dest).size / 1048576).toFixed(1)} MiB）`);
    }
  }

  // 3) 全部落盘后**才**算校验和：名字已经定稿，checksums.txt 才对得上发布物。
  const produced = readdirSync(OUT_DIR)
    .filter((name) => name !== "checksums.txt")
    .sort();
  const lines = produced.map((name) => `${sha256(join(OUT_DIR, name))}  ${name}`);
  writeFileSync(join(OUT_DIR, "checksums.txt"), `${lines.join("\n")}\n`);
  log(`checksums.txt（${lines.length} 项，改名/归档之后计算）`);
  for (const line of lines) log(`  ${line}`);

  // 4) 收尾自检：计划里的每个文件都真在盘上（含自研归档）
  for (const item of plan) {
    const path = join(OUT_DIR, item.canonicalName);
    if (!existsSync(path) || statSync(path).size === 0) {
      fail(`产物缺失或为空：${path}`);
    }
  }
  log(`完成：${produced.length} 个产物 + checksums.txt → ${relative(REPO_ROOT, OUT_DIR)}`);
  log("上传/发版请只认这些逐字名字（asset.js 用的是字符串全等匹配）。");
}

// 只有直接被 `node scripts/pack-artifacts.mjs` 调用时才跑主流程；被 import 时只导出
// 归档写入器，便于用 unzip / tar 在本地独立复核它们产出的字节（CI 之外的第二双眼睛）。
export { writeZip, writeTarGz, crc32 };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
