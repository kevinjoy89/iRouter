#!/usr/bin/env node
// Phase 4 收尾：旧 CLI 数据导入的端到端验证（走真实二进制 + `IROUTER_IMPORT_DECISION` 接缝）。
//
// 为什么需要它：这个功能的三道护栏里有一条是「目标目录已有网关数据就别动」——
// 那正是保护**正在用的用户**的那条，而单元测试只能证明谓词，证明不了"应用真的没动它"。
//
// 安全约定（照抄 verify-guard-chain.mjs / verify-shell.mjs 的做法）：
//   - 全部读写都在 mktemp 出来的临时目录里
//   - **真实 `~/.irouter` 与 `~/.9router` 只取指纹，不写入、不读取内容**（指纹前后必须一致）
//   - Case A 特意用「临时目录里造出的已有数据形态」，而不是拿用户的真实目录跑
//
// 用法：node scripts/verify-legacy-import.mjs [--bin <path>]

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = resolve(HERE, "..");
const HOME = process.env.HOME || "";
const argOf = (n, d) => {
  const i = process.argv.indexOf(n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BIN = argOf("--bin", join(SHELL_ROOT, "src-tauri", "target", "debug", "irouter"));
const KEEP = process.argv.includes("--keep");

const MARKER = ".irouter-import-decided";
const results = [];
const record = (id, title, ok, ev = "") => {
  results.push({ id, title, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${id} ${title}${ev ? `\n      ${ev}` : ""}`);
};

// ---------------------------------------------------------------- 真实数据指纹
function fingerprint(dir) {
  if (!existsSync(dir)) return "（不存在）";
  const h = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        // 只取路径与大小：不读内容（避免碰到凭据），也足够发现"被写入/删除"
        h.update(`${p.slice(dir.length)}:${statSync(p).size}\n`);
      }
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 24);
}

const REAL_DIRS = [join(HOME, ".irouter"), join(HOME, ".9router")];
const realBefore = REAL_DIRS.map((d) => [d, fingerprint(d)]);

console.log(`[legacy] 二进制 ${BIN}`);
if (!existsSync(BIN)) {
  console.error(`[legacy] 二进制不存在，先构建：cd src-tauri && cargo build --bin irouter`);
  process.exit(2);
}

// ---------------------------------------------------------------- 起一次应用
async function runOnce({ dataDir, legacyDir, decision, timeoutMs = 60000 }) {
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    IROUTER_LEGACY_DIR: legacyDir,
    // 隔离：别让这次运行碰到真实的 ~/.irouter / ~/.9router
    HOME: process.env.HOME,
  };
  if (decision) env.IROUTER_IMPORT_DECISION = decision;
  else delete env.IROUTER_IMPORT_DECISION;

  const child = spawn(BIN, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (b) => (log += b.toString()));
  child.stderr.on("data", (b) => (log += b.toString()));

  const deadline = Date.now() + timeoutMs;
  // 等到"网关已拉起"或"旧数据导入"相关日志出现即可，不必等面板就绪
  while (Date.now() < deadline) {
    if (/网关已拉起|legacy-import/.test(log)) break;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // 再给导入落盘一点时间
  await new Promise((r) => setTimeout(r, 1500));

  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(); }, 8000);
    child.on("exit", () => { clearTimeout(t); r(); });
  });
  return log;
}

// ---------------------------------------------------------------- 准备
const root = mkdtempSync(join(tmpdir(), "irouter-legacy-e2e-"));
const fakeLegacy = join(root, "legacy");
mkdirSync(join(fakeLegacy, "db"), { recursive: true });
mkdirSync(join(fakeLegacy, "runtime"), { recursive: true });
writeFileSync(join(fakeLegacy, "db", "data.sqlite"), "旧库");
writeFileSync(join(fakeLegacy, "jwt-secret"), "旧密钥");
// ★ 追踪文件：**唯一命名 + 唯一内容**。用它判定"导入是否发生"，
// 而不是去看 jwt-secret / logs 之类——那些**网关自己首次运行也会创建**，
// 拿它们当判据会把"应用正常工作"误判成"导入发生了"（本脚本第一版就是这么错的）。
const TRACER = "irouter-legacy-tracer.txt";
writeFileSync(join(fakeLegacy, TRACER), "来自旧目录的追踪文件");
writeFileSync(join(fakeLegacy, "runtime", "node"), "CLI 自带的运行时");

// ============================ Case A：目标目录已有数据 → 护栏必须拦住
{
  const dataDir = join(root, "caseA-data");
  mkdirSync(join(dataDir, "db"), { recursive: true });
  writeFileSync(join(dataDir, "db", "data.sqlite"), "现有库");
  await runOnce({ dataDir, legacyDir: fakeLegacy, decision: "import" });

  // 注意：**不能断言"目录指纹未变"** —— 启动网关本身就会往数据目录写它自己的文件
  // （日志、PID、jwt-secret、模型目录缓存…）。那是应用在正常工作，不是导入。
  // 判据要用"只有导入才会产生的痕迹"：唯一命名的追踪文件。
  record("A1", "已有数据的目录：接缝直接设 import 也不导入（追踪文件缺席）", !existsSync(join(dataDir, TRACER)));
  record("A2", "已有数据的目录：现有库内容逐字未变", readFileSync(join(dataDir, "db", "data.sqlite"), "utf8") === "现有库");
  record("A3", "已有数据的目录：未复制旧目录的任何文件", !existsSync(join(dataDir, "jwt-secret")) || readFileSync(join(dataDir, "jwt-secret"), "utf8") !== "旧密钥");
  record("A4", "已有数据的目录：未留下导入标记", !existsSync(join(dataDir, MARKER)));
}

// ============================ Case B：真正的首次运行 → 应当导入
{
  const dataDir = join(root, "caseB-data");
  mkdirSync(dataDir, { recursive: true }); // 存在但为空 = 没有任何网关数据条目

  const log = await runOnce({ dataDir, legacyDir: fakeLegacy, decision: "import" });

  record("B0", "首次运行：追踪文件确实被复制（证明导入发生了）", existsSync(join(dataDir, TRACER)));
  record("B1", "首次运行：数据库被复制进来", existsSync(join(dataDir, "db", "data.sqlite")));
  record("B2", "首次运行：密钥被复制进来", existsSync(join(dataDir, "jwt-secret")));
  record("B3", "首次运行：runtime/ 被排除", !existsSync(join(dataDir, "runtime")));
  const marker = existsSync(join(dataDir, MARKER)) ? readFileSync(join(dataDir, MARKER), "utf8").trim() : "";
  record("B4", "首次运行：标记写为 imported", marker === "imported", `marker=${JSON.stringify(marker)}`);
  record("B5", "首次运行：日志里能看到导入条数", /legacy-import/.test(log), log.split("\n").find((l) => l.includes("legacy-import")) || "（日志里没有 legacy-import）");
}

// ============================ Case C：skip 接缝 → 只记标记不复制
{
  const dataDir = join(root, "caseC-data");
  mkdirSync(dataDir, { recursive: true });
  await runOnce({ dataDir, legacyDir: fakeLegacy, decision: "skip" });
  const marker = existsSync(join(dataDir, MARKER)) ? readFileSync(join(dataDir, MARKER), "utf8").trim() : "";
  record("C1", "skip：标记写为 skipped", marker === "skipped", `marker=${JSON.stringify(marker)}`);
  record("C2", "skip：没有复制任何文件（追踪文件缺席）", !existsSync(join(dataDir, TRACER)));
}

// ---------------------------------------------------------------- 真实目录必须原封不动
console.log("\n[legacy] 真实数据指纹：");
for (const [dir, before] of realBefore) {
  const after = fingerprint(dir);
  record(`F:${dir}`, "真实数据指纹未变", before === after, `${before} → ${after}`);
}

if (!KEEP) rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n总体：${failed.length ? `FAIL ❌ —— ${failed.length} 项` : "PASS ✅"}`);
if (failed.length) failed.forEach((f) => console.log(`  - ${f.id} ${f.title}`));
process.exit(failed.length ? 1 : 0);
