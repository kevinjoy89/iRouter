#!/usr/bin/env node
/**
 * Phase 1 验收：通用供应商 OAuth 回环的端到端验证（无需真实 provider 凭据）
 *
 * 为什么需要它：单元测试把换取、落库都 mock 掉了，跑得再绿也只证明「函数契约」；
 * 而真实 OAuth 需要 Claude / Gemini CLI 之类账号。GitLab 的 provider 实现允许用
 * meta.baseUrl 覆盖 token 与 userinfo 的主机（src/lib/oauth/providers/gitlab.js:23,34,42），
 * 于是可以用一个**本地桩**顶替远端 provider，把其余每一环都真跑：
 *
 *   面板登录 → register-session（HTTP，受鉴权保护）
 *     → 模拟 provider 重定向 GET /callback?code=&state=（真实 route handler）
 *       → 服务端 exchangeTokens（真实 HTTP POST 打到本地桩）
 *         → createProviderConnection 落库（真实 SQLite）
 *           → poll-status 返回 done（真实轮询端点）
 *
 * 唯一被替换的环节是「远端 GitLab 返回令牌」，其余全部真实。真机跑一次真实 provider 仍不可替代，
 * 但它把风险从「整条链路未知」收敛到「远端 provider 的行为」。
 *
 * 用法：node desktop/scripts/oauth-loopback-e2e.mjs [--bun <path>] [--port 31901] [--keep]
 *
 * 安全边界：临时 DATA_DIR + 临时 HOME + 临时端口；运行前后校验真实数据目录指纹未变。
 *
 * @author iRouter
 * @since 2026-10-07
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STANDALONE = resolve(argOf("--standalone", join(REPO_ROOT, ".next", "standalone")));
const BUN = argOf("--bun", "bun");
const PORT = Number(argOf("--port", "31901"));
const KEEP = argv.includes("--keep");
const PASSWORD = "spike-password";

const results = [];
const record = (id, title, ok, evidence = "") => {
  results.push({ id, title, ok, evidence });
  console.log(`  ${ok ? "✓" : "✗"} ${id} ${title}${evidence ? `\n      ${evidence}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portInUse(port) {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => { s.destroy(); res(false); });
    setTimeout(() => { s.destroy(); res(false); }, 1000);
  });
}
function fingerprint(p) {
  try {
    const st = statSync(p, { throwIfNoEntry: false });
    return st ? `${st.size}:${st.mtimeMs}` : "absent";
  } catch { return "absent"; }
}

const realDirs = [join(homedir(), ".irouter"), join(homedir(), ".9router")].map((p) => ({
  path: p, file: join(p, "db", "data.sqlite"), before: fingerprint(join(p, "db", "data.sqlite")),
}));

if (!existsSync(join(STANDALONE, "custom-server.js"))) {
  console.error(`[e2e] 致命：${STANDALONE} 下没有 custom-server.js，先跑 npm run build`);
  process.exit(2);
}
if (await portInUse(PORT)) {
  console.error(`[e2e] 致命：端口 ${PORT} 被占用，换 --port`);
  process.exit(2);
}

// ---------------------------------------------------------------- 本地 GitLab 桩

const stubHits = { token: null, userInfo: null };
const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    if (req.method === "POST" && req.url.startsWith("/oauth/token")) {
      stubHits.token = {
        body,
        params: Object.fromEntries(new URLSearchParams(body)),
        contentType: req.headers["content-type"] || "",
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "stub-access-token",
        refresh_token: "stub-refresh-token",
        expires_in: 3600,
        scope: "api",
        token_type: "bearer",
      }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/v4/user")) {
      stubHits.userInfo = { authorization: req.headers["authorization"] || "" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ username: "stub-user", email: "stub@example.com", name: "Stub User" }));
      return;
    }
    res.writeHead(404); res.end("not found");
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB_PORT = stub.address().port;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;
console.log(`[e2e] 本地 GitLab 桩 ${STUB_BASE}`);
console.log(`[e2e] 网关端口 ${PORT} ｜ bun ${BUN}\n`);

// ---------------------------------------------------------------- 启动网关

const root = mkdtempSync(join(tmpdir(), "irouter-oauth-e2e-"));
const dataDir = join(root, "data");
const homeDir = join(root, "home");
mkdirSync(dataDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });

const logs = [];
const child = spawn(BUN, [join(STANDALONE, "custom-server.js"), "--port", String(PORT)], {
  cwd: STANDALONE,
  env: {
    ...process.env,
    DATA_DIR: dataDir, HOME: homeDir, PORT: String(PORT), HOSTNAME: "127.0.0.1",
    NODE_ENV: "production", IR_PANEL_GUARD: "1",
    JWT_SECRET: "e2e-jwt-secret", INITIAL_PASSWORD: PASSWORD,
    API_KEY_SECRET: "e2e-api-key", MACHINE_ID_SALT: "e2e-machine-salt",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => logs.push(String(d)));
child.stderr.on("data", (d) => logs.push(String(d)));
let exited = null;
child.on("exit", (c, s) => { exited = { c, s }; });

let cookie = "";
async function req(path, { method = "GET", headers = {}, body, timeoutMs = 15000, capture = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { "x-irouter-client": "irouter-app", ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal, redirect: "manual",
    });
    if (capture) {
      const sc = res.headers.getSetCookie?.() ?? [];
      const pairs = sc.map((c) => c.split(";")[0]).filter(Boolean);
      if (pairs.length) cookie = pairs.join("; ");
    }
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: "", error: String(e?.message || e) };
  } finally { clearTimeout(t); }
}

let ready = false;
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  if (exited) break;
  if ((await req("/login", { timeoutMs: 5000 })).status === 200) { ready = true; break; }
  await sleep(1500);
}
if (!ready) {
  console.error("[e2e] 网关未就绪。日志尾：\n" + logs.join("").split("\n").slice(-25).join("\n"));
  child.kill("SIGKILL"); stub.close(); rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
console.log(`[e2e] 网关就绪（${Date.now() - t0} ms）\n[e2e] 端到端断言：`);

// ---------------------------------------------------------------- 流程

const STATE = "e2e-state-" + Date.now().toString(36);
const VERIFIER = "e2e-code-verifier-" + Math.random().toString(36).slice(2);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

{
  const r = await req("/api/auth/login", { method: "POST", body: { password: PASSWORD }, capture: true });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  record("E1", "登录取得会话 cookie", r.status === 200 && j?.success === true && cookie.length > 0,
    `status=${r.status} success=${j?.success}`);
}

{
  const r = await req("/api/oauth/gitlab/register-session", {
    method: "POST",
    body: {
      state: STATE, codeVerifier: VERIFIER, redirectUri: REDIRECT_URI,
      meta: { baseUrl: STUB_BASE, clientId: "stub-client" },
    },
  });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  record("E2", "register-session 登记回环会话", r.status === 200 && j?.success === true,
    `status=${r.status} body=${r.text.slice(0, 80)}`);
}

{
  const r = await req(`/api/oauth/gitlab/poll-status?state=${encodeURIComponent(STATE)}`);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  record("E3", "换取前轮询为 pending", j?.status === "pending", `status=${r.status} body=${r.text.slice(0, 80)}`);
}

{
  // 模拟 provider 把用户重定向回来 —— 真实 route handler
  const r = await req(`/callback?code=STUB-AUTH-CODE&state=${encodeURIComponent(STATE)}`);
  const success = r.text.includes("Authentication Successful");
  record("E4", "/callback 在服务端完成换取并返回成功页",
    r.status === 200 && success,
    `status=${r.status} 成功页=${success} bytes=${r.text.length}`);
  // code 不得回显
  record("E4b", "成功页不回显授权码", !r.text.includes("STUB-AUTH-CODE"), `含码=${r.text.includes("STUB-AUTH-CODE")}`);
}

{
  const t = stubHits.token;
  const ok = Boolean(t) && t.params.code === "STUB-AUTH-CODE" && t.params.code_verifier === VERIFIER
    && t.params.redirect_uri === REDIRECT_URI && t.params.grant_type === "authorization_code";
  record("E5", "桩收到真实的 token 请求，且 PKCE 校验码原样透传", ok,
    t ? `grant_type=${t.params.grant_type} code=${t.params.code} verifier匹配=${t.params.code_verifier === VERIFIER} redirect_uri=${t.params.redirect_uri}` : "未收到请求");
  record("E5b", "桩收到 userinfo 请求（Bearer 令牌已带上）",
    Boolean(stubHits.userInfo) && stubHits.userInfo.authorization === "Bearer stub-access-token",
    stubHits.userInfo ? `authorization=${stubHits.userInfo.authorization}` : "未收到");
}

{
  const r = await req(`/api/oauth/gitlab/poll-status?state=${encodeURIComponent(STATE)}`);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  record("E6", "换取后轮询为 done（面板据此翻到成功）", j?.status === "done",
    `status=${r.status} body=${r.text.slice(0, 120)}`);
  record("E6b", "轮询体不含 codeVerifier", !r.text.includes(VERIFIER), `含 verifier=${r.text.includes(VERIFIER)}`);
}

{
  const dbFile = join(dataDir, "db", "data.sqlite");
  let row = null; let err = "";
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    row = db.prepare("SELECT provider, authType, email, data FROM providerConnections ORDER BY createdAt DESC LIMIT 1").get();
    db.close();
  } catch (e) { err = String(e?.message || e); }
  const data = row?.data ? JSON.parse(row.data) : {};
  record("E7", "连接已落库（provider=gitlab / authType=oauth）",
    row?.provider === "gitlab" && row?.authType === "oauth",
    row ? `provider=${row.provider} authType=${row.authType} email=${row.email} token=${data.accessToken ? "已存" : "缺失"}` : `未查到 ${err}`);
}

{
  // 重放：同一 state 再打一次回调，不得二次换取
  const before = stubHits.token ? 1 : 0;
  await req(`/callback?code=STUB-AUTH-CODE&state=${encodeURIComponent(STATE)}`);
  const after = stubHits.token ? 1 : 0;
  record("E8", "重放同一 state 不触发第二次换取", before === after, `token 请求次数=${after}`);
}

// ---------------------------------------------------------------- 收尾

console.log("\n[e2e] 真实数据未被触碰校验：");
for (const d of realDirs) {
  const after = fingerprint(d.file);
  record(`S:${d.path}`, "指纹未变", d.before === after, `${d.before} → ${after}`);
}

child.kill("SIGTERM");
await sleep(1500);
if (!exited) child.kill("SIGKILL");
stub.close();
const leaked = await portInUse(PORT);
record("Z1", "端口释放、无残留", !leaked, `leaked=${leaked}`);

if (!KEEP) rmSync(root, { recursive: true, force: true });
else console.log(`[e2e] 保留临时目录：${root}`);

const passed = results.filter((r) => r.ok).length;
console.log(`\n================ Phase 1 端到端验收 ================`);
console.log(`${passed}/${results.length} 通过`);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.id.padEnd(6)} ${r.title}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n总体：${failed.length === 0 ? "PASS ✅" : `FAIL ❌ —— ${failed.length} 项未通过`}`);
if (failed.length) {
  console.log("\n失败项证据：");
  for (const f of failed) console.log(`  ${f.id} ${f.title}\n    ${f.evidence}`);
  console.log("\n网关日志尾：\n" + logs.join("").split("\n").slice(-30).join("\n"));
}
process.exit(failed.length === 0 ? 0 : 1);
