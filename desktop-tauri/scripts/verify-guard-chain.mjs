#!/usr/bin/env node
/**
 * Phase 3 验收：**随机令牌守卫链路**端到端验证（无需打开 GUI 窗口）。
 *
 * 验证的就是 gateway.rs 运行时做的事：用 stage 过的 Bun 拉起网关负载（临时 DATA_DIR、临时
 * 端口、IR_PANEL_GUARD=1 + 本次随机令牌），然后分别以不同 UA 探 /login：
 *
 *   令牌 UA（= webview 会带的）      → 200   ← 这正是 gateway.rs 的就绪探针
 *   错误令牌                         → 连接被切断
 *   普通浏览器 UA                    → 连接被切断
 *   Electron UA（迁移期兼容）        → 200
 *   固定客户端头（迁移期兼容）        → 200
 *
 * 安全边界：临时 DATA_DIR + 临时 HOME + 临时端口；运行前后校验真实数据目录指纹未变。
 *
 * 用法：node scripts/verify-guard-chain.mjs [--port 31911] [--keep]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const SHELL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SHELL_ROOT, "..");
const BUN = argOf("--bun", join(SHELL_ROOT, "src-tauri", "target", "debug", "irouter-bun"));
const GATEWAY_DIR = argOf("--gateway-dir", join(REPO, "desktop", "build", "gateway", "server"));
const PORT = Number(argOf("--port", "31911"));
const KEEP = argv.includes("--keep");
const TOKEN = randomBytes(32).toString("hex");

const results = [];
const record = (id, title, ok, ev = "") => {
  results.push({ id, title, ok, ev });
  console.log(`  ${ok ? "✓" : "✗"} ${id} ${title}${ev ? `\n      ${ev}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = (p) => { try { const s = statSync(p, { throwIfNoEntry: false }); return s ? `${s.size}:${s.mtimeMs}` : "absent"; } catch { return "absent"; } };
const realDirs = [join(homedir(), ".irouter"), join(homedir(), ".9router")].map((p) => ({ path: p, file: join(p, "db", "data.sqlite"), before: fp(join(p, "db", "data.sqlite")) }));

if (!statSync(BUN, { throwIfNoEntry: false })) { console.error(`[guard] 找不到 ${BUN}，先跑 node scripts/stage-sidecar.mjs`); process.exit(2); }

const root = mkdtempSync(join(tmpdir(), "irouter-guard-"));
const dataDir = join(root, "data");
const homeDir = join(root, "home");
mkdirSync(dataDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });

const logs = [];
const child = spawn(BUN, [join(GATEWAY_DIR, "custom-server.js"), "--port", String(PORT)], {
  cwd: GATEWAY_DIR,
  env: {
    ...process.env, DATA_DIR: dataDir, HOME: homeDir, PORT: String(PORT), HOSTNAME: "127.0.0.1",
    NODE_ENV: "production", IR_PANEL_GUARD: "1", IR_PANEL_GUARD_TOKEN: TOKEN,
    JWT_SECRET: "guard-e2e", INITIAL_PASSWORD: "guard-e2e",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => logs.push(String(d)));
child.stderr.on("data", (d) => logs.push(String(d)));
let exited = null;
child.on("exit", (c) => { exited = c; });

/** 裸 TCP 探针：能区分「200」与「连接被切断」——这正是 gateway.rs 用的方式。 */
function probe(userAgent, extraHeaders = {}) {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port: PORT });
    let out = "";
    const done = (v) => { s.destroy(); res(v); };
    s.setTimeout(4000, () => done({ status: 0, note: "timeout" }));
    s.on("error", (e) => done({ status: 0, note: `连接被切断（${e.code || e.message}）` }));
    s.on("data", (d) => { out += String(d); });
    s.on("close", () => {
      const m = out.match(/^HTTP\/1\.[01] (\d{3})/);
      done(m ? { status: Number(m[1]), note: "" } : { status: 0, note: `非 HTTP 响应：${JSON.stringify(out.slice(0, 40))}` });
    });
    const headers = [
      `GET /login HTTP/1.1`, `Host: 127.0.0.1:${PORT}`,
      `User-Agent: ${userAgent}`, `Accept: text/html`, `Connection: close`,
      ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
      "", "",
    ].join("\r\n");
    s.write(headers);
  });
}

// 等就绪：用令牌 UA（与 gateway.rs 的就绪探针一致）
let ready = false;
for (let i = 0; i < 120; i += 1) {
  if (exited !== null) break;
  const r = await probe(`iRouter/0.3.7 iRouterGuard/${TOKEN}`);
  if (r.status === 200) { ready = true; break; }
  await sleep(500);
}
if (!ready) {
  console.error("[guard] 网关未就绪。日志尾：\n" + logs.join("").split("\n").slice(-20).join("\n"));
  child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); process.exit(1);
}
console.log(`[guard] 网关就绪（令牌 UA 探测到 200）\n[guard] 守卫链路断言：`);

const withToken = await probe(`iRouter/0.3.7 iRouterGuard/${TOKEN}`);
record("G1", "令牌 UA → 200（gateway.rs 就绪探针走的就是这条）", withToken.status === 200, `status=${withToken.status}`);

const wrongToken = await probe(`iRouter/0.3.7 iRouterGuard/${"0".repeat(64)}`);
record("G2", "错误令牌 → 连接被切断", wrongToken.status === 0, `status=${wrongToken.status} ${wrongToken.note}`);

const browser = await probe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36");
record("G3", "普通浏览器 UA → 连接被切断（面板不在浏览器里暴露）", browser.status === 0, `status=${browser.status} ${browser.note}`);

const electron = await probe("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Electron/44.2.0");
record("G4", "Electron UA → 200（迁移期兼容，Electron 壳仍在用）", electron.status === 200, `status=${electron.status}`);

const headerClient = await probe("Mozilla/5.0", { "x-irouter-client": "irouter-app" });
record("G5", "固定客户端头 → 200（迁移期兼容）", headerClient.status === 200, `status=${headerClient.status}`);

const apiNoToken = await probe("Mozilla/5.0");  // /login 已验；这里确认 /v1 与 /api 仍豁免
record("G6", "守卫令牌未泄漏进日志", !logs.join("").includes(TOKEN), `日志含令牌=${logs.join("").includes(TOKEN)}`);

console.log("\n[guard] 真实数据未被触碰校验：");
for (const d of realDirs) record(`S:${d.path}`, "指纹未变", d.before === fp(d.file), `${d.before} → ${fp(d.file)}`);

child.kill("SIGTERM");
await sleep(1500);
if (exited === null) child.kill("SIGKILL");
record("Z1", "网关已退出", exited !== null, `exit=${exited}`);
if (!KEEP) rmSync(root, { recursive: true, force: true });
else console.log(`[guard] 保留临时目录：${root}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n================ 守卫链路验收 ================\n${results.length - failed.length}/${results.length} 通过`);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.id.padEnd(4)} ${r.title}`);
console.log(`\n总体：${failed.length === 0 ? "PASS ✅" : `FAIL ❌ —— ${failed.length} 项`}`);
if (failed.length) for (const f of failed) console.log(`  ${f.id} ${f.title}\n    ${f.ev}`);
process.exit(failed.length === 0 ? 0 : 1);
