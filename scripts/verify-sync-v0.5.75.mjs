#!/usr/bin/env node
// Isolated end-to-end verification for tasks 4.7 (session cookie) and 4.9 (/v1/messages path).
// Spins a mock OpenAI-compatible upstream, starts the freshly built gateway on a temp
// DATA_DIR + free port, then drives real HTTP against it. Never touches the user's real DB.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

// 仓库根由脚本自身位置推导，避免硬编码路径
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE = join(REPO, ".next", "standalone");

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

// ---- mock upstream: OpenAI-compatible /v1/chat/completions ----
const upstreamHits = [];
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamHits.push({
      url: req.url,
      auth: req.headers.authorization,
      body: body.slice(0, 400),
    });
    if (req.url.includes("/chat/completions")) {
      const wantsStream = /"stream"\s*:\s*true/.test(body);
      if (wantsStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        chunk({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "MOCK_OK" },
              finish_reason: null,
            },
          ],
        });
        chunk({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "MOCK_OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
});

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`,
  );
};

const upstreamPort = await freePort();
await new Promise((r) => upstream.listen(upstreamPort, "127.0.0.1", r));
console.log(`[mock] upstream on 127.0.0.1:${upstreamPort}`);

const dataDir = mkdtempSync(join(tmpdir(), "irouter-verify-"));
const port = await freePort();
console.log(
  `[gw]   starting gateway on 127.0.0.1:${port}, DATA_DIR=${dataDir}`,
);

const gw = spawn(
  process.execPath,
  [join(STANDALONE, "custom-server.js"), "--port", String(port)],
  {
    cwd: STANDALONE,
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      DATA_DIR: dataDir,
      JWT_SECRET: "verify-secret",
      INITIAL_PASSWORD: "verify-pass-123",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let gwLog = "";
gw.stdout.on("data", (d) => (gwLog += d));
gw.stderr.on("data", (d) => (gwLog += d));

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 60000;
for (;;) {
  try {
    const r = await fetch(`${base}/login`);
    if (r.status < 500) break;
  } catch {}
  if (Date.now() > deadline) {
    console.log("gateway never came up:\n" + gwLog.slice(-2000));
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("[gw]   up");

try {
  // ---------- 4.7 session cookie ----------
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "verify-pass-123" }),
  });
  const setCookie = loginRes.headers.getSetCookie?.() ?? [
    loginRes.headers.get("set-cookie"),
  ];
  const cookieStr = (setCookie || []).filter(Boolean).join("; ");
  check("4.7 login 成功", loginRes.status === 200, `status=${loginRes.status}`);
  const maxAge = /max-age=(\d+)/i.exec(cookieStr);
  check(
    "4.7 cookie 带 24h maxAge (86400)",
    !!maxAge && Number(maxAge[1]) === 86400,
    maxAge
      ? `max-age=${maxAge[1]}`
      : `no max-age in: ${cookieStr.slice(0, 160)}`,
  );

  const authToken = /auth_token=([^;]+)/.exec(cookieStr)?.[1];

  // ---------- 4.9 /v1/messages through the claude->openai bridge ----------
  const hdr = {
    "Content-Type": "application/json",
    ...(authToken ? { Cookie: `auth_token=${authToken}` } : {}),
  };

  // a) gateway API key (required to call /v1/*)
  const keyRes = await fetch(`${base}/api/keys`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ name: "verify" }),
  });
  const keyJson = await keyRes.json().catch(() => ({}));
  const gwKey = keyJson.key;
  check(
    "4.9 创建网关 API key",
    !!gwKey,
    `status=${keyRes.status} ${JSON.stringify(keyJson).slice(0, 120)}`,
  );

  // b) custom OpenAI-compatible node pointing at the mock upstream
  const nodeRes = await fetch(`${base}/api/provider-nodes`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({
      name: "MockUpstream",
      prefix: "mockup",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      type: "openai-compatible",
    }),
  });
  const nodeJson = await nodeRes.json().catch(() => ({}));
  const nodeId = nodeJson.node?.id || nodeJson.id;
  check(
    "4.9 注册 OpenAI 兼容节点",
    nodeRes.status < 400 && !!nodeId,
    `status=${nodeRes.status} id=${nodeId} ${JSON.stringify(nodeJson).slice(0, 140)}`,
  );

  // c) attach a connection (API key) to that node
  const connRes = await fetch(`${base}/api/providers`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({
      provider: nodeId,
      apiKey: "sk-mock-upstream",
      name: "mock",
      priority: 1,
    }),
  });
  const connJson = await connRes.json().catch(() => ({}));
  check(
    "4.9 添加连接",
    connRes.status < 400,
    `status=${connRes.status} ${JSON.stringify(connJson).slice(0, 160)}`,
  );

  // d) Anthropic-shaped request, including a bare-object content block (the exact upstream fix).
  const msgRes = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": gwKey || "sk-none",
    },
    body: JSON.stringify({
      model: "mockup/mock-model",
      max_tokens: 64,
      system: [{ type: "text", text: "You are a test." }],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: { type: "text", text: "prior turn" } }, // bare object content
        { role: "user", content: [{ type: "text", text: "say MOCK_OK" }] },
      ],
    }),
  });
  const msgText = await msgRes.text();
  check(
    "4.9 /v1/messages 请求成功",
    msgRes.status === 200,
    `status=${msgRes.status} body=${msgText.slice(0, 220)}`,
  );
  check("4.9 收到上游回复内容", /MOCK_OK/.test(msgText), msgText.slice(0, 160));
  check(
    "4.9 上游确实被调用 (claude→openai 翻译生效)",
    upstreamHits.length > 0,
    upstreamHits.length
      ? `hits=${upstreamHits.length} path=${upstreamHits[0].url}`
      : "no upstream hit",
  );
  if (upstreamHits.length) {
    const u = upstreamHits[0];
    let names = [],
      body = {};
    try {
      body = JSON.parse(u.body);
      names = (body.messages || []).map((m) => m.role);
    } catch {}
    // system 提示被前置，故为 system + 3 轮对话；裸对象 content 那一轮必须在场
    check(
      "4.9 裸对象 content 未导致该轮丢失 (上游收到 4 条含 assistant)",
      names.join(",") === "system,user,assistant,user" &&
        /prior turn/.test(u.body),
      `roles=${JSON.stringify(names)} hasPriorTurn=${/prior turn/.test(u.body)}`,
    );
  }
  // 响应诊断：非流式下的 content-type 与长度
  console.log(
    `[diag] /v1/messages status=${msgRes.status} ctype=${msgRes.headers.get("content-type")} len=${msgText.length}`,
  );
  console.log(`[diag] body head: ${JSON.stringify(msgText.slice(0, 300))}`);
  // 完整落盘，便于人工核对 MOCK_OK 确实经 claude 事件流透传。
  // 写到本次运行的隔离目录（dataDir 同一个 mkdtemp 产物）：固定路径如 /tmp/msg-stream.txt
  // 在多用户机上可被预置符号链接，脚本会以当前用户身份覆盖任意可写文件。
  writeFileSync(join(dataDir, "msg-stream.txt"), msgText);
  const deltaText = (msgText.match(/"text":"([^"]*)"/g) || []).join("");
  console.log(`[diag] 流内文本增量: ${deltaText}`);

  // ---------- 4.8 weekly quota keys must not be billable model rows ----------
  const pricing = await fetch(`${base}/api/pricing`, {
    headers: authToken ? { Cookie: `auth_token=${authToken}` } : {},
  });
  const pricingText = await pricing.text();
  check(
    "4.8 定价接口不包含 gemini_weekly/claude_gpt_weekly",
    !/gemini_weekly|claude_gpt_weekly/.test(pricingText),
    `status=${pricing.status}`,
  );

  // ---------- logout clears the cookie ----------
  const logout = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: authToken ? { Cookie: `auth_token=${authToken}` } : {},
  });
  const logoutCookie = (
    (logout.headers.getSetCookie?.() ?? [logout.headers.get("set-cookie")]) ||
    []
  )
    .filter(Boolean)
    .join("; ");
  check(
    "4.7 登出清除 cookie",
    /auth_token=;|auth_token="";|max-age=0/i.test(logoutCookie),
    `status=${logout.status} cookie=${logoutCookie.slice(0, 120)}`,
  );
} finally {
  gw.kill("SIGTERM");
  upstream.close();
  await new Promise((r) => setTimeout(r, 800));
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(
  `\n=== ${results.length - failed.length}/${results.length} 通过 ===`,
);
if (!existsSync(STANDALONE)) console.log("warning: standalone missing");
process.exit(failed.length ? 1 : 0);
