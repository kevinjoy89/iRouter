#!/usr/bin/env node
/**
 * Phase 4E 验收：**壳层链路自检**（真实二进制 + `IROUTER_SHELL_SELFTEST` 接缝 + 信号回收）。
 *
 * 为什么需要它：壳层的大部分能力（托盘、菜单项、原生对话框）在自动化里**点不到**，而
 * task-7/task-8 两次验证证明了链路级测试的价值——最典型的是 updater 那条事件：
 * `emit_to(EventTarget::webview_window("main"))` 与 `AppHandle::listen` 目标类型不匹配 →
 * 事件**静默丢失**，只有"该出现的日志没出现"能发现它。此前那两条缝是临时加、跑完删，
 * 这里把 `IROUTER_SHELL_SELFTEST`（`src/shell/selftest.rs`，**仅 debug 构建**）固化成可复跑门禁。
 *
 * 四个场景（每个都起一次真实二进制、真实 sidecar）：
 *   A1 update-dialog          就绪后触发 request_update_check → 断言「监听已注册 + 收到结果」
 *   A2 open-settings:updates  就绪后触发 open_settings(Some("updates")) → 断言分段进入日志
 *   A3 quit                   就绪后走 window::quit（等价托盘「退出」）→ 断言回收
 *   A4 signal-only            不发接缝，直接 SIGTERM → 断言信号回收（接缝之外的基线）
 *
 * 每个场景收尾都断言四项：**壳退出 / irouter-bun 消失 / 端口释放 / `.gateway.pid` 已清**。
 *
 * 安全边界：临时 `DATA_DIR` + 临时 `HOME`（不碰真实 `~/.irouter` / `~/.9router`，运行前后校验指纹），
 * 跑完清临时目录；残留进程会被检测并报红。
 *
 * 用法：
 *   node scripts/verify-shell.mjs [--bin <path>] [--scenario <id>] [--keep] [--timeout <秒>]
 *
 * 本机 crates.io 直连不可用时（首次需要编译），用镜像参数：
 *   IROUTER_CARGO_ARGS='--config source.crates-io.replace-with="rsproxy" --config source.rsproxy.registry="sparse+https://rsproxy.cn/index/"' \
 *     node scripts/verify-shell.mjs
 *
 * ⚠️ 会真的启动 GUI 窗口（需要可用的桌面会话），每个场景约 10–20 秒。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const SHELL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SHELL_ROOT, "..");
const BIN = argOf("--bin", join(SHELL_ROOT, "src-tauri", "target", "debug", "irouter"));
const SIDECAR = join(SHELL_ROOT, "src-tauri", "target", "debug", "irouter-bun");
const GATEWAY_DIR = join(REPO, "desktop", "build", "gateway", "server");
const KEEP = argv.includes("--keep");
const ONLY = argOf("--scenario", null);
const TIMEOUT_MS = Number(argOf("--timeout", "90")) * 1000;

const results = [];
const record = (id, title, ok, ev = "") => {
  results.push({ id, title, ok, ev });
  console.log(`  ${ok ? "✓" : "✗"} ${id} ${title}${ev ? `\n      ${ev}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = (p) => { try { const s = statSync(p, { throwIfNoEntry: false }); return s ? `${s.size}:${s.mtimeMs}` : "absent"; } catch { return "absent"; } };

/** 进程存活判定：**僵尸进程也算"已死"**——`kill(pid,0)` / `ps -p` 对僵尸都返回成功，
 *  这点 gateway.rs 的单测踩过一次（见 `gateway.rs` 的 `kills_grandchildren_not_just_the_direct_child`）。 */
function processAlive(pid) {
  try {
    const out = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!out) return false;
    return !out.startsWith("Z");
  } catch {
    return false;
  }
}

function portListening(port) {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { s.destroy(); res(v); };
    s.setTimeout(1500, () => done(false));
    s.on("error", () => done(false));
    s.on("connect", () => done(true));
  });
}

function pgrep(pattern) {
  try {
    return execFileSync("pgrep", ["-fl", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  console.error(`[shell] 等待超时：${label}`);
  return null;
}

// ---------------------------------------------------------------- 前置
if (!statSync(BIN, { throwIfNoEntry: false })) {
  console.log(`[shell] 二进制不存在，先构建：${BIN}`);
  const extra = (process.env.IROUTER_CARGO_ARGS || "").split(" ").filter(Boolean);
  try {
    execFileSync("cargo", ["build", "--bin", "irouter", ...extra], { cwd: join(SHELL_ROOT, "src-tauri"), stdio: "inherit" });
  } catch {
    console.error("[shell] cargo build 失败（本机直连 crates.io 不可用时请设 IROUTER_CARGO_ARGS，见文件头）");
    process.exit(2);
  }
}
if (!statSync(SIDECAR, { throwIfNoEntry: false })) {
  console.error(`[shell] 找不到 sidecar ${SIDECAR}，先跑：node scripts/stage-sidecar.mjs`);
  process.exit(2);
}
if (!existsSync(join(GATEWAY_DIR, "custom-server.js"))) {
  console.error(`[shell] 找不到网关负载 ${GATEWAY_DIR}，先跑：npm --prefix desktop run build-server`);
  process.exit(2);
}

// 真实数据目录指纹（每个场景前后都比一次）
const realDirs = [join(homedir(), ".irouter"), join(homedir(), ".9router")].map((p) => ({
  path: p,
  file: join(p, "db", "data.sqlite"),
  before: fp(join(p, "db", "data.sqlite")),
}));

// R1：debug 二进制里应当能找到接缝字符串（release 侧由 CI 对产物做同一断言，期望为 0）
try {
  const out = execFileSync("strings", [BIN], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  record("R1", "debug 二进制含自检接缝（release 产物应为 0 —— CI 侧同一断言，见 selftest.rs 头注）",
    out.includes("IROUTER_SHELL_SELFTEST"), `strings ${BIN} 命中 IROUTER_SHELL_SELFTEST`);
} catch (e) {
  record("R1", "debug 二进制含自检接缝", false, `strings 不可用或失败：${e.message}`);
}

// ---------------------------------------------------------------- 场景
const SCENARIOS = [
  {
    id: "A1", selftest: "update-dialog", sigterm: true,
    title: "update-dialog：监听注册 → updater → 结果 → 弹窗链",
    expect: [
      "[selftest] 网关就绪，触发场景",
      "已注册 shell:update-available 监听",
      "收到菜单触发的检查结果，弹出结果对话框",
    ],
  },
  {
    id: "A2", selftest: "open-settings:updates", sigterm: true,
    title: "open-settings:updates：设置模态 IPC 落到 updates 分段",
    expect: ['打开设置面板：section=Some("updates")'],
  },
  {
    id: "A3", selftest: "quit", sigterm: false,
    title: "quit：正常退出路径（等价托盘「退出」）",
    expect: ["[selftest] 网关就绪，触发场景", "退出应用（closeAction=quit"],
  },
  {
    id: "A4", selftest: null, sigterm: true,
    title: "signal-only：不发接缝，SIGTERM 回收（基线）",
    expect: [],
  },
];

async function runScenario(sc) {
  console.log(`\n[shell] ── ${sc.id} ${sc.title}`);
  const root = mkdtempSync(join(tmpdir(), `irouter-shell-${sc.id.toLowerCase()}-`));
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const logs = [];
  const env = { ...process.env, DATA_DIR: dataDir, HOME: homeDir };
  if (sc.selftest) env.IROUTER_SHELL_SELFTEST = sc.selftest; else delete env.IROUTER_SHELL_SELFTEST;

  const child = spawn(BIN, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  let exited = null;
  child.on("exit", (c) => { exited = c; });
  const shellPid = child.pid;
  const text = () => logs.join("");

  const dumpTail = (n = 15) => text().split("\n").filter(Boolean).slice(-n).map((l) => `      ${l}`).join("\n");

  // 前置：网关被拉起（日志里有 pid/port）
  const started = await waitFor(() => text().match(/网关已拉起：pid=(\d+) port=(\d+)/), TIMEOUT_MS, `${sc.id} 网关拉起`);
  if (!started) {
    record(`${sc.id}.0`, "网关已拉起", false, `日志尾：\n${dumpTail()}`);
  } else {
    const gwPid = Number(started[1]);
    const port = Number(started[2]);
    record(`${sc.id}.0`, `网关已拉起（pid=${gwPid} port=${port}）`, true);

    // 场景断言：等每条期望日志出现
    for (let i = 0; i < sc.expect.length; i += 1) {
      const needle = sc.expect[i];
      const hit = await waitFor(() => text().includes(needle), TIMEOUT_MS, `${sc.id} 日志「${needle}」`);
      record(`${sc.id}.${i + 1}`, `日志出现「${needle}」`, Boolean(hit), hit ? "" : `未出现。日志尾：\n${dumpTail()}`);
    }

    // 收尾：要么自己退出（quit 场景），要么我们发 SIGTERM
    if (sc.sigterm) {
      child.kill("SIGTERM");
      const acked = await waitFor(() => text().includes("收到 SIGTERM"), 5000, `${sc.id} SIGTERM 被处理`);
      record(`${sc.id}.t0`, "SIGTERM 被信号钩子接住（日志可见）", Boolean(acked), acked ? "" : `日志尾：\n${dumpTail()}`);
    }

    const shellGone = await waitFor(() => !processAlive(shellPid), 20000, `${sc.id} 壳退出`);
    record(`${sc.id}.t1`, "壳进程已退出", Boolean(shellGone), shellGone ? "" : `pid=${shellPid} 仍在`);

    const gwGone = await waitFor(() => !processAlive(gwPid), 10000, `${sc.id} 网关消失`);
    record(`${sc.id}.t2`, "irouter-bun 已消失（无孤儿）", Boolean(gwGone), gwGone ? `pid=${gwPid}` : `pid=${gwPid} 仍在`);

    const portFree = await waitFor(async () => !(await portListening(port)), 10000, `${sc.id} 端口释放`);
    record(`${sc.id}.t3`, `端口 ${port} 已释放`, Boolean(portFree), portFree ? "" : `仍在监听`);

    const pidFile = join(dataDir, ".gateway.pid");
    const pidGone = !existsSync(pidFile);
    record(`${sc.id}.t4`, ".gateway.pid 已清", pidGone, pidGone ? "" : `${pidFile} 仍在：${readFileSync(pidFile, "utf8").trim()}`);

    if (exited === null && processAlive(shellPid)) child.kill("SIGKILL");
  }

  if (!KEEP) rmSync(root, { recursive: true, force: true });
  else console.log(`[shell] 保留临时目录：${root}`);
}

const selected = ONLY ? SCENARIOS.filter((s) => s.id === ONLY) : SCENARIOS;
if (ONLY && selected.length === 0) {
  console.error(`[shell] 未知场景 ${ONLY}（可用：${SCENARIOS.map((s) => s.id).join(", ")}）`);
  process.exit(2);
}
for (const sc of selected) await runScenario(sc);

// ---------------------------------------------------------------- 全局收尾断言
console.log("\n[shell] 全局断言：");
for (const d of realDirs) record(`F:${d.path}`, "真实数据指纹未变", d.before === fp(d.file), `${d.before} → ${fp(d.file)}`);

const leftovers = [...pgrep(BIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), ...pgrep("irouter-bun")];
record("Z1", "无残留壳/网关进程", leftovers.length === 0, leftovers.join(" | "));

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\n================ 壳层链路验收 ================\n${results.length - failed.length}/${results.length} 通过`);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.id.padEnd(8)} ${r.title}`);
console.log(`\n总体：${failed.length === 0 ? "PASS ✅" : `FAIL ❌ —— ${failed.length} 项`}`);
if (failed.length) for (const f of failed) console.log(`  ${f.id} ${f.title}\n    ${f.ev}`);
process.exit(failed.length === 0 ? 0 : 1);
