#!/usr/bin/env node
/**
 * 把锁定并校验过的 Bun 二进制 stage 成 Tauri `externalBin` 期望的文件名。
 *
 * 依据：docs/plans/2026-10-07-tauri-bun-sidecar-packaging.md §3.1 / §6
 *
 * 规则（Tauri 的实际行为，已核实）：
 *   - `bundle.externalBin` 写**不含三元组的基名**（这里用 `binaries/irouter-bun`），
 *     Tauri 自动补 `-<目标三元组>[.exe]`；
 *   - 单次构建只解析当前目标那一份，**缺失即 ResourcePathNotFound 硬失败**；
 *   - dev 下 `sidecar()` 解析的是 `target[ /<triple>]/debug/irouter-bun[.exe]`，
 *     所以既要 stage 到 `src-tauri/binaries/`（打包用），也要 stage 到 target 目录（dev 用）。
 *
 * 硬约束：**禁止任何回退**——不查 PATH、不用 latest、不降级到系统 bun、不 || true、
 * 不把哈希校验降级为 warning。映射表未命中即 exit 1。
 *
 * 用法：
 *   node scripts/stage-sidecar.mjs [--target <triple>] [--scope bin|target|both]
 *
 * @author iRouter
 * @since 2026-10-07
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = resolve(HERE, "..");
const SRC_TAURI = join(SHELL_ROOT, "src-tauri");
const REPO_ROOT = resolve(SHELL_ROOT, "..");
const PIN_JSON = join(REPO_ROOT, "tools", "bun-pin.json");
const VERIFY = join(REPO_ROOT, "tools", "verify-bun-pin.mjs");

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 目标三元组 → bun-pin.json 的平台键。映射表未命中即失败，不许就近猜。 */
const TRIPLE_TO_PIN_KEY = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-pc-windows-msvc": "win32-x64",
  "aarch64-pc-windows-msvc": "win32-arm64",
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
};

/** 宿主三元组：优先取 Tauri hook 注入的 TAURI_ENV_TARGET_TRIPLE（打包时最准），
 *  其次问 rustc，最后退到 platform/arch 推断。 */
function hostTriple() {
  const fromTauri = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (fromTauri) return fromTauri;
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const m = out.match(/^host:\s*(\S+)$/m);
    if (m) return m[1];
  } catch {
    /* rustc 不可用则退到推断 */
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

/** 已 stage 过就不重复下载：留下 <目标>.sha256 作为凭据，比对一致即跳过。
 *  打包方案 §3.2 要求脚本幂等（`--no-bundle` 时 hook 不跑，CI 会再显式跑一次）。 */
function stagedShaPath(dest) {
  return `${dest}.sha256`;
}

function alreadyStaged(dest, pinVersion) {
  if (!existsSync(dest)) return false;
  if (!existsSync(stagedShaPath(dest))) return false;
  try {
    const recorded = readFileSync(stagedShaPath(dest), "utf8").trim();
    const actual = createHash("sha256").update(readFileSync(dest)).digest("hex");
    if (recorded !== actual) return false;
    const v = execFileSync(dest, ["--version"], { encoding: "utf8" }).trim();
    return v === pinVersion;
  } catch {
    return false;
  }
}

/** 解压 zip：unzip → bsdtar（macOS/Windows 自带）→ PowerShell，逐级尝试，全败即失败。 */
function extractZip(zip, destDir) {
  const attempts = [
    ["unzip", ["-o", "-q", zip, "-d", destDir]],
    ["tar", ["-xf", zip, "-C", destDir]],
  ];
  if (process.platform === "win32") {
    attempts.push([
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zip}' -DestinationPath '${destDir}'`],
    ]);
  }
  const failures = [];
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return cmd;
    } catch (e) {
      failures.push(`${cmd}: ${e.code || e.message}`);
    }
  }
  throw new Error(`解压失败（尝试过 ${attempts.map((a) => a[0]).join(", ")}）：${failures.join(" | ")}`);
}

/** 在解压结果里找 bun 可执行文件（zip 内层是 <资产名>/bun[.exe]）。 */
function findBunBinary(dir) {
  const want = process.platform === "win32" ? "bun.exe" : "bun";
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.name === want) hits.push(p);
    }
  };
  walk(dir, 0);
  if (!hits.length) throw new Error(`解压结果里找不到 ${want}`);
  // 取最浅的那个（zip 根目录下的 <资产名>/bun）
  hits.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length);
  return hits[0];
}

// ------------------------------------------------------------------ 主流程

const triple = argOf("--target", hostTriple());
const scope = argOf("--scope", "both");
const pinKey = TRIPLE_TO_PIN_KEY[triple];
if (!pinKey) {
  console.error(`[stage] 三元组 ${triple} 不在映射表里——**不猜测**，请先把它登记进本脚本，并把对应平台补进 bun-pin.json`);
  process.exit(1);
}

const pin = JSON.parse(execFileSync("node", ["-p", `JSON.stringify(require(${JSON.stringify(PIN_JSON)}))`], { encoding: "utf8" }));
const entry = pin.artifacts[pinKey];
if (!entry) {
  console.error(`[stage] bun-pin.json 里没有平台键 ${pinKey}`);
  process.exit(1);
}

const exeSuffix = process.platform === "win32" ? ".exe" : "";
const stagedName = `irouter-bun-${triple}${exeSuffix}`;

// 落点先算出来，好做幂等短路
const targets = [];
if (scope === "bin" || scope === "both") {
  const binDir = join(SRC_TAURI, "binaries");
  mkdirSync(binDir, { recursive: true });
  targets.push(join(binDir, stagedName));
}
if (scope === "target" || scope === "both") {
  // dev 形态：sidecar() 解析 target[ /<triple>]/debug/irouter-bun[.exe]。
  // 注意显式 --target 时目录带三元组，写死 target/debug 会解析不到。
  const devDir = argv.includes("--target")
    ? join(SRC_TAURI, "target", triple, "debug")
    : join(SRC_TAURI, "target", "debug");
  mkdirSync(devDir, { recursive: true });
  targets.push(join(devDir, `irouter-bun${exeSuffix}`));
}

console.log(`[stage] 目标三元组 ${triple} → pin 平台键 ${pinKey}`);
console.log(`[stage] 锁定 Bun ${pin.version} / ${entry.asset}`);
console.log(`[stage] 期望 SHA-256 ${entry.sha256}${entry.verified ? "（该平台已实测）" : "（⚠ 该平台尚未实测，本次将实测并比对）"}`);

if (targets.every((t) => alreadyStaged(t, pin.version))) {
  console.log(`[stage] 全部落点已就位且哈希与版本一致，跳过下载（幂等）`);
  for (const t of targets) console.log(`[stage]   ${t}`);
  process.exit(0);
}

const workDir = mkdtempSync(join(tmpdir(), "irouter-stage-bun-"));
try {
  // 1. 下载 + 哈希校验（不符即 exit 1，脚本自身也会中止）
  const zip = join(workDir, entry.asset);
  console.log(`[stage] 下载并由 verify-bun-pin.mjs 校验…`);
  execFileSync("node", [VERIFY, "--platform", pinKey, "--download", "--out", zip], { stdio: "inherit" });

  // 2. 解压
  const unzipped = join(workDir, "unzipped");
  mkdirSync(unzipped, { recursive: true });
  const tool = extractZip(zip, unzipped);
  const bunBin = findBunBinary(unzipped);
  console.log(`[stage] 解压（${tool}）→ ${bunBin}`);

  // 3. 版本断言：解出来的必须是锁定版本，否则拒绝 stage
  const versionOut = execFileSync(bunBin, ["--version"], { encoding: "utf8" }).trim();
  if (versionOut !== pin.version) {
    console.error(`[stage] 版本不符：期望 ${pin.version}，实得 ${versionOut}`);
    process.exit(1);
  }
  console.log(`[stage] 版本断言通过：bun ${versionOut}`);

  // 4. 落盘；同时记录解压后二进制的 sha256，供下次幂等比对
  const binHash = createHash("sha256").update(readFileSync(bunBin)).digest("hex");
  for (const dest of targets) {
    copyFileSync(bunBin, dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);
    writeFileSync(stagedShaPath(dest), `${binHash}\n`);
    console.log(`[stage] 已落盘 ${dest}（${(statSync(dest).size / 1048576).toFixed(1)} MiB，sha256=${binHash.slice(0, 16)}…）`);
  }
  console.log(`[stage] 完成：Bun ${versionOut} / ${pinKey} / 落点 ${targets.length} 处`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
