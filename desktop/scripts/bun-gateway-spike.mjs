#!/usr/bin/env node
/**
 * Phase 0 门禁：Bun 能否跑通完整网关（ADR-0007 的前置验证）
 *
 * 用法：
 *   node desktop/scripts/bun-gateway-spike.mjs [--bun <path>] [--port 31888] [--standalone <dir>] [--keep]
 *
 * 安全边界（务必保持）：
 *   - 只读仓库；不修改任何产物
 *   - DATA_DIR 与 HOME 都指向临时目录，绝不碰真实的 ~/.irouter / ~/.9router
 *   - 使用临时端口，绝不干扰正在运行的桌面版（默认占 20128）
 *   - 运行前后校验真实数据目录未被触碰，被碰即判失败
 *
 * @author iRouter
 * @since 2026-10-07
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STANDALONE = resolve(argOf("--standalone", join(REPO_ROOT, ".next", "standalone")));
const BUN = argOf("--bun", "bun");
const PORT = Number(argOf("--port", "31888"));
const KEEP = argv.includes("--keep");
const READY_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------- 基础设施

const results = [];
function record(id, title, ok, evidence = "") {
  results.push({ id, title, ok, evidence });
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${id} ${title}${evidence ? `\n      ${evidence}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portInUse(port) {
  return new Promise((res) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      res(true);
    });
    sock.on("error", () => {
      sock.destroy();
      res(false);
    });
    setTimeout(() => {
      sock.destroy();
      res(false);
    }, 1200);
  });
}

/** 数据目录指纹：用于证明真实数据未被触碰 */
function fingerprint(p) {
  try {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return "absent";
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "absent";
  }
}

const REAL_DIRS = [join(homedir(), ".irouter"), join(homedir(), ".9router")].map((p) => ({
  path: p,
  file: join(p, "db", "data.sqlite"),
  before: fingerprint(join(p, "db", "data.sqlite")),
}));

// 面板守卫要求的客户端标识（等价于桌面壳的 Electron UA；这里用显式头）
const PANEL_HEADERS = { "x-irouter-client": "irouter-app" };

// 登录后的会话 cookie（部分端点受 dashboardGuard 保护）
let cookie = "";

async function req(path, { method = "GET", headers = {}, body, timeoutMs = 15_000, captureCookies = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: {
        ...PANEL_HEADERS,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      redirect: "manual",
    });
    if (captureCookies) {
      const setCookies = res.headers.getSetCookie?.() ?? [];
      const pairs = setCookies.map((c) => c.split(";")[0]).filter(Boolean);
      if (pairs.length) cookie = pairs.join("; ");
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 前置检查

console.log(`[spike] 仓库根     ${REPO_ROOT}`);
console.log(`[spike] standalone ${STANDALONE}`);
console.log(`[spike] bun        ${BUN}`);
console.log(`[spike] 端口       ${PORT}`);

if (!existsSync(join(STANDALONE, "custom-server.js"))) {
  console.error(`[spike] 致命：${STANDALONE} 下没有 custom-server.js，先跑 npm run build`);
  process.exit(2);
}
if (await portInUse(PORT)) {
  console.error(`[spike] 致命：端口 ${PORT} 已被占用，换一个 --port`);
  process.exit(2);
}

const bunVersion = await new Promise((res) => {
  const p = spawn(BUN, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("error", () => res(null));
  p.on("exit", (code) => res(code === 0 ? out.trim() : null));
});
if (!bunVersion) {
  console.error(`[spike] 致命：无法执行 ${BUN} --version`);
  process.exit(2);
}
console.log(`[spike] bun 版本   ${bunVersion}`);

// ---------------------------------------------------------------- 启动

const root = mkdtempSync(join(tmpdir(), "irouter-bun-spike-"));
const dataDir = join(root, "data");
const homeDir = join(root, "home");
mkdirSync(dataDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
console.log(`[spike] 临时根     ${root}\n`);

const logs = [];
const child = spawn(BUN, [join(STANDALONE, "custom-server.js"), "--port", String(PORT)], {
  cwd: STANDALONE,
  env: {
    ...process.env,
    // 隔离：即便 .env 里的 DATA_DIR 被读取，也只能落在临时目录
    DATA_DIR: dataDir,
    HOME: homeDir,
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    // 桌面拓扑：启用面板守卫（spike 全程带客户端头）
    IR_PANEL_GUARD: "1",
    // 显式给定，避免依赖 .env 内容
    JWT_SECRET: "spike-jwt-secret-not-for-production",
    INITIAL_PASSWORD: "spike-password",
    API_KEY_SECRET: "spike-api-key-secret",
    MACHINE_ID_SALT: "spike-machine-salt",
    // 不继承用户 shell 里可能存在的代理/转发相关变量
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => logs.push(String(d)));
child.stderr.on("data", (d) => logs.push(String(d)));

let exited = null;
child.on("exit", (code, signal) => {
  exited = { code, signal };
});

const logText = () => logs.join("");

// ---------------------------------------------------------------- 就绪等待

let ready = false;
const t0 = Date.now();
while (Date.now() - t0 < READY_TIMEOUT_MS) {
  if (exited) break;
  const r = await req("/login", { timeoutMs: 5000 });
  if (r.status === 200) {
    ready = true;
    break;
  }
  await sleep(1500);
}
const bootMs = Date.now() - t0;
console.log(`[spike] 启动耗时   ${bootMs} ms（就绪=${ready}）\n`);

if (!ready) {
  console.error("[spike] 网关未在超时内就绪 —— 前 60 行日志：");
  console.error(logText().split("\n").slice(0, 60).join("\n"));
  child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------- 断言

console.log("[spike] 能力面断言：");

// A0 登录（后半段断言都需要会话；同时验证 getClientIp 依赖的 x-9r-real-ip 链）
{
  const r = await req("/api/auth/login", {
    method: "POST",
    body: { password: "spike-password" },
    captureCookies: true,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.text);
  } catch { /* ignore */ }
  record("A0", "登录成功并取得会话 cookie", r.status === 200 && parsed?.success === true && cookie.length > 0,
    `status=${r.status} success=${parsed?.success} cookie=${cookie ? "已获得" : "无"}`);
}

// A1 面板 HTML
{
  const r = await req("/login");
  const ct = r.headers.get("content-type") || "";
  record("A1", "面板 /login 返回 HTML", r.status === 200 && ct.includes("text/html"),
    `status=${r.status} content-type=${ct} bytes=${r.text.length}`);
}

// A2 根路径
{
  const r = await req("/");
  const ok = r.status === 200 || (r.status >= 300 && r.status < 400);
  record("A2", "根路径 / 可达", ok, `status=${r.status} location=${r.headers.get("location") || "-"}`);
}

// A3 /callback（既有 smoke 的断言：>0 即认为路由存在）
{
  const r = await req("/callback");
  record("A3", "/callback 路由存在", r.status > 0, `status=${r.status}`);
}

// A4 OpenAI 兼容端点
{
  const r = await req("/v1/models");
  let parsed = null;
  try {
    parsed = JSON.parse(r.text);
  } catch { /* 非 JSON */ }
  const ok = r.status === 200 && parsed && Array.isArray(parsed.data);
  record("A4", "/v1/models 返回模型列表", ok,
    `status=${r.status} models=${parsed?.data?.length ?? "n/a"}`);
}

// A5 SSE 流式转发（关键：验证 Bun 下不被缓冲）
{
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  let ct = "";
  let firstChunk = "";
  let chunks = 0;
  let streamStatus = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/usage/stream`, {
      headers: { ...PANEL_HEADERS, ...(cookie ? { cookie } : {}) },
      signal: ctrl.signal,
    });
    streamStatus = res.status;
    ct = res.headers.get("content-type") || "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (chunks < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks += 1;
      if (chunks === 1) firstChunk = dec.decode(value).slice(0, 80);
    }
    await reader.cancel().catch(() => {});
  } catch (e) {
    if (!firstChunk) firstChunk = `<${String(e?.message || e)}>`;
  } finally {
    clearTimeout(timer);
  }
  record("A5", "SSE 流式（/api/usage/stream）分块可达",
    streamStatus === 200 && ct.includes("text/event-stream") && chunks > 0,
    `status=${streamStatus} content-type=${ct || "-"} chunks=${chunks} first=${JSON.stringify(firstChunk)}`);
}

// A6 SQLite：走 bun:sqlite，且无降级告警
{
  const dbFile = join(dataDir, "db", "data.sqlite");
  let readyAt = 0;
  for (let i = 0; i < 20; i += 1) {
    if (existsSync(dbFile)) {
      readyAt = i;
      break;
    }
    await sleep(1000);
  }
  let tables = null;
  let err = "";
  if (existsSync(dbFile)) {
    try {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
      db.close();
    } catch (e) {
      err = String(e?.message || e);
    }
  }
  const fallbackWarn = /\[DB\].*(unavailable|failed)/i.test(logText());
  const driver = /bun:sqlite/i.test(logText()) ? "bun:sqlite(日志提及)" : "见下方告警判断";
  record("A6", "SQLite 落盘可读且无驱动降级", existsSync(dbFile) && tables > 0 && !fallbackWarn,
    `db=${existsSync(dbFile) ? dbFile : "未创建"} tables=${tables ?? "-"} 等待=${readyAt}s 降级告警=${fallbackWarn} (${driver})${err ? ` err=${err}` : ""}`);
}

// A7 面板守卫：无客户端标识的浏览器式请求必须被切断
{
  let blocked = false;
  let detail = "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`http://127.0.0.1:${PORT}/login`, {
      headers: { accept: "text/html" }, // 不带 x-irouter-client / Electron UA
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    detail = `status=${res.status}`;
    blocked = false;
  } catch (e) {
    detail = `连接被切断（${String(e?.message || e)}）`;
    blocked = true;
  }
  record("A7", "面板守卫切断无标识的 HTML 请求", blocked, detail);
}

// A8 IP 推导 / peer 令牌防伪（SSRF 守卫是观测点）
{
  const privateUrl = "http://127.0.0.1:11434/v1";
  const body = { baseUrl: privateUrl, apiKey: "spike", type: "custom" };

  const a = await req("/api/provider-nodes/validate", { method: "POST", body });
  const aBlocked = /URL not allowed/.test(a.text);

  const b = await req("/api/provider-nodes/validate", {
    method: "POST",
    body,
    headers: { "x-forwarded-for": "8.8.8.8" },
  });
  const bBlocked = /URL not allowed/.test(b.text);

  const c = await req("/api/provider-nodes/validate", {
    method: "POST",
    body,
    headers: { "x-9r-peer-token": "forged", "x-9r-real-ip": "8.8.8.8" },
  });
  const cBlocked = /URL not allowed/.test(c.text);

  // 401/403 表示探针没打到被测逻辑——那种"通过"是假阳性，必须判失败
  const reachedLogic = [a, b, c].every((r) => r.status !== 401 && r.status !== 403);
  const authNote = reachedLogic ? "" : ` ⚠ 探针未穿过鉴权（status=${[a.status, b.status, c.status].join("/")}），结论无效`;

  record("A8.1", "本机直连 → 视为本地（SSRF 守卫放行私网地址）", reachedLogic && !aBlocked,
    `status=${a.status} blocked=${aBlocked}${authNote}`);
  record("A8.2", "带 X-Forwarded-For → 视为经代理（守卫收紧）", reachedLogic && bBlocked,
    `status=${b.status} blocked=${bBlocked}${authNote}`);
  record("A8.3", "伪造 x-9r-peer-token / x-9r-real-ip 无效（与直连同结果）", reachedLogic && cBlocked === aBlocked,
    `status=${c.status} blocked=${cBlocked}（期望 ${aBlocked}，与 A8.1 一致）${authNote}`);
}

// A9 日志无致命错误
{
  const text = logText();
  const fatal = [
    /Cannot find module/i,
    /ERR_REQUIRE_ESM/,
    /is not a function/i,
    /UnhandledPromiseRejection/i,
    /Segmentation fault/i,
    /panic/i,
  ].filter((re) => re.test(text)).map((re) => re.source);
  record("A9", "运行日志无致命错误", fatal.length === 0, fatal.length ? `命中：${fatal.join(", ")}` : "无命中");
  const warnLines = text.split("\n").filter((l) => /\[DB\]|\[BackgroundTokenRefresh\]|\[edge\]/.test(l));
  if (warnLines.length) console.log(`      诊断行：\n        ${warnLines.slice(0, 6).join("\n        ")}`);
}

// ---------------------------------------------------------------- 数据安全校验

console.log("\n[spike] 真实数据未被触碰校验：");
for (const d of REAL_DIRS) {
  const after = fingerprint(d.file);
  record(`S:${d.path}`, "指纹未变", d.before === after, `${d.before} → ${after}`);
}

// ---------------------------------------------------------------- 收尾

const exitedCleanly = await new Promise((res) => {
  if (exited) return res(true);
  child.kill("SIGTERM");
  const t = setTimeout(() => {
    child.kill("SIGKILL");
    res(false);
  }, 8000);
  child.on("exit", () => {
    clearTimeout(t);
    res(true);
  });
});
await sleep(1200);
const leaked = await portInUse(PORT);
record("Z1", "SIGTERM 后端口释放、无进程残留", !leaked, `clean=${exitedCleanly} port=${PORT} leaked=${leaked}`);

if (!KEEP) rmSync(root, { recursive: true, force: true });
else console.log(`[spike] 保留临时目录：${root}`);

// ---------------------------------------------------------------- 报告

const passed = results.filter((r) => r.ok).length;
console.log(`\n================ Phase 0 门禁报告 ================`);
console.log(`Bun ${bunVersion} ｜ 启动 ${bootMs} ms ｜ ${passed}/${results.length} 通过`);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.id.padEnd(22)} ${r.title}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n总体：${failed.length === 0 ? "PASS ✅ —— 可进入 Phase 1" : `FAIL ❌ —— ${failed.length} 项未通过`}`);
if (failed.length) {
  console.log("\n失败项证据：");
  for (const f of failed) console.log(`  ${f.id} ${f.title}\n    ${f.evidence}`);
  console.log("\n最后 40 行日志：");
  console.log(logText().split("\n").slice(-40).join("\n"));
}
process.exit(failed.length === 0 ? 0 : 1);
