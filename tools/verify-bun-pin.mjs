#!/usr/bin/env node
/**
 * 按 desktop/scripts/bun-pin.json 校验 Bun 产物（Phase 4/5 的构建期门禁）
 *
 * 用法：
 *   node desktop/scripts/verify-bun-pin.mjs --file <已下载的 zip>      # 校验本地文件
 *   node desktop/scripts/verify-bun-pin.mjs --download                # 下载并校验（需网络）
 *   node desktop/scripts/verify-bun-pin.mjs --download --out <路径>   # 下载到指定位置
 *   node desktop/scripts/verify-bun-pin.mjs --list                    # 打印锁定表
 *
 * 任一环节不符即 exit 1 —— 构建必须因此中止，不许降级到系统 bun 或 latest。
 *
 * @author iRouter
 * @since 2026-10-07
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN = JSON.parse(readFileSync(resolve(HERE, "bun-pin.json"), "utf8"));

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

/** 当前平台 → pin 表里的键 */
function platformKey() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "win32") return `win32-${arch}`;
  return `linux-${arch}`;
}

function url(template, asset) {
  return template.replace("{version}", PIN.version).replace("{asset}", asset);
}

if (argv.includes("--list")) {
  console.log(`Bun ${PIN.version}`);
  for (const [key, a] of Object.entries(PIN.artifacts)) {
    console.log(`  ${key.padEnd(14)} ${a.asset.padEnd(26)} ${a.sha256}  ${a.verified ? "已实测" : "未实测"}`);
  }
  process.exit(0);
}

const key = argOf("--platform", platformKey());
const entry = PIN.artifacts[key];
if (!entry) {
  console.error(`[pin] 不支持的目标平台：${key}`);
  process.exit(2);
}

async function sha256Of(path) {
  const hash = createHash("sha256");
  const stream = Readable.from(await readFile(path));
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function check(actual, label) {
  const ok = actual === entry.sha256;
  console.log(`[pin] Bun ${PIN.version} / ${key} / ${basename(entry.asset)}`);
  console.log(`[pin]   期望 ${entry.sha256}`);
  console.log(`[pin]   实测 ${actual}  (${label})`);
  console.log(`[pin]   ${ok ? "✅ 校验通过" : "❌ 校验失败 —— 构建必须中止，不得回退到系统 bun 或 latest"}`);
  return ok;
}

if (argv.includes("--download")) {
  const out = resolve(argOf("--out", resolve(process.cwd(), entry.asset)));
  const u = url(PIN.releaseUrlTemplate, entry.asset);
  console.log(`[pin] 下载 ${u}`);
  const res = await fetch(u, { redirect: "follow" });
  if (!res.ok) {
    console.error(`[pin] 下载失败：HTTP ${res.status}`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
  const size = statSync(out).size;
  console.log(`[pin] 落盘 ${out}（${size} 字节）`);
  if (entry.bytes && size !== entry.bytes) {
    console.error(`[pin] ❌ 字节数不符：期望 ${entry.bytes}，实得 ${size}`);
    process.exit(1);
  }
  process.exit(check(await sha256Of(out), out) ? 0 : 1);
}

const file = argOf("--file", null);
if (!file) {
  console.error("用法：--file <zip> | --download [--out <路径>] | --list");
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`[pin] 文件不存在：${file}`);
  process.exit(1);
}
process.exit(check(await sha256Of(file), file) ? 0 : 1);
