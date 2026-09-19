#!/usr/bin/env node
// 首次运行导入（spec: embedded-gateway / 首次运行导入旧数据）的自动化验证。
// 覆盖 4 个场景：导入、重复运行不再询问、跳过、无旧数据。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ELECTRON_BIN = require("electron");

function runElectron({ userData, legacyDir, decision }) {
  return new Promise((resolvePromise) => {
    const child = spawn(ELECTRON_BIN, [DESKTOP_ROOT, "--smoke"], {
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "",
        IROUTER_USER_DATA: userData,
        IROUTER_LEGACY_DIR: legacyDir ?? join(userData, "__no_legacy__"),
        ...(decision ? { IROUTER_IMPORT_DECISION: decision } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const killer = setTimeout(() => child.kill("SIGKILL"), 150000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolvePromise({ code, out });
    });
  });
}

const MARKER_TABLE = "irouter_test_marker";

function readMarkerTable(dbPath) {
  if (!existsSync(dbPath)) return false;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(MARKER_TABLE);
    db.close();
    return !!row;
  } catch {
    return false;
  }
}

// 造一个仿真旧 CLI 数据目录。db 用真实 sqlite 文件，才能验证"导入后网关直接可用"。
function makeLegacy() {
  const base = mkdtempSync(join(tmpdir(), "irouter-legacy-"));
  mkdirSync(join(base, "auth"), { recursive: true });
  mkdirSync(join(base, "db"), { recursive: true });
  mkdirSync(join(base, "runtime", "node_modules"), { recursive: true });
  mkdirSync(join(base, "logs"), { recursive: true });
  writeFileSync(join(base, "auth", "providers.json"), JSON.stringify({ claude: { token: "legacy-token" } }));
  const db = new DatabaseSync(join(base, "db", "data.sqlite"));
  db.exec(`CREATE TABLE ${MARKER_TABLE} (note TEXT); INSERT INTO ${MARKER_TABLE} VALUES ('from-legacy');`);
  db.close();
  writeFileSync(join(base, "jwt-secret"), "secret-value");
  writeFileSync(join(base, "machine-id"), "mid");
  writeFileSync(join(base, "runtime", "node_modules", "junk.js"), "should never ship");
  writeFileSync(join(base, "logs", "app.log"), "log line");
  // 网关不会自造的信封文件，用于判定“到底有没有复制”（jwt-secret / db 等网关自己也会创建，不能当证据）
  writeFileSync(join(base, "irouter-legacy-sentinel.txt"), "sentinel");
  return base;
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "<缺失>");

const tmp = mkdtempSync(join(tmpdir(), "irouter-import-test-"));
try {
  // 场景 1：导入
  const legacy = makeLegacy();
  const ud1 = join(tmp, "ud1");
  mkdirSync(ud1, { recursive: true });
  const r1 = await runElectron({ userData: ud1, legacyDir: legacy, decision: "import" });
  check("场景1 导入：应用正常启动（网关能直接吃导入的 db）", r1.code === 0, `exit=${r1.code}`);
  check("场景1 导入：auth 已复制", existsSync(join(ud1, "auth", "providers.json")));
  check("场景1 导入：db 已复制且含旧表", readMarkerTable(join(ud1, "db", "data.sqlite")));
  check("场景1 导入：jwt-secret 内容保留", readIf(join(ud1, "jwt-secret")) === "secret-value");
  check("场景1 导入：machine-id 已复制", readIf(join(ud1, "machine-id")) === "mid");
  check("场景1 导入：信封文件已复制（通用复制生效）", readIf(join(ud1, "irouter-legacy-sentinel.txt")) === "sentinel");
  check("场景1 导入：runtime/ 被排除", !existsSync(join(ud1, "runtime")));
  check("场景1 导入：标记为 imported", readIf(join(ud1, ".irouter-import-decided")) === "imported");
  check("场景1 导入：旧目录原样保留（复制非移动）", existsSync(join(legacy, "jwt-secret")));

  // 场景 2：重复运行不再询问（不注入 decision → 若弹框会超时失败）
  const r2 = await runElectron({ userData: ud1, legacyDir: legacy });
  // 若执行失败输出子进程输出以便定位
  if (r2.code !== 0) console.log("--- r2 out ---\n" + r2.out + "\n--- end r2 out ---");
  check("场景2 重复运行：未再弹框（无 decision 也能跑完）", r2.code === 0, `exit=${r2.code}`);

  // 场景 3：跳过
  const ud3 = join(tmp, "ud3");
  mkdirSync(ud3, { recursive: true });
  const r3 = await runElectron({ userData: ud3, legacyDir: legacy, decision: "skip" });
  check("场景3 跳过：应用正常启动", r3.code === 0, `exit=${r3.code}`);
  check("场景3 跳过：未复制旧数据", !existsSync(join(ud3, "irouter-legacy-sentinel.txt")));
  check("场景3 跳过：标记为 skipped", readIf(join(ud3, ".irouter-import-decided")) === "skipped");

  // 场景 4：无旧数据 → 不询问、不写标记
  const ud4 = join(tmp, "ud4");
  mkdirSync(ud4, { recursive: true });
  const r4 = await runElectron({ userData: ud4, legacyDir: null });
  check("场景4 无旧数据：不弹框直接启动", r4.code === 0, `exit=${r4.code}`);
  check("场景4 无旧数据：不写导入标记", !existsSync(join(ud4, ".irouter-import-decided")));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[test-import] ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
