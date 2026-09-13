#!/usr/bin/env node
// 内容审核（Content Exists Risk）触发器定位器。
//
// 原理：把候选内容按原样 POST 到与失败请求同一条上游路由（默认 hd/deepseek-v4.1-flash，
// 即 Console Go 后端），上游返回 400 + "Content Exists Risk" 即判定命中；对命中项按
// 行/字符二分，收敛到最小触发片段。
//
// 用法：
//   # 1) 直接探可疑文件（最便宜）
//   node scripts/trace-content-risk.mjs --files open-sse/utils/claudeCloaking.js CLAUDE.md
//
//   # 2) 探一段文本
//   node scripts/trace-content-risk.mjs --text "要试的内容"
//
//   # 3) 用 DSH 会话记录重建真实请求并定位
//   node scripts/trace-content-risk.mjs --session ~/.dsh/sessions/--Users-.../session-xxx/session.v3.jsonl.zstd --base-only
//   node scripts/trace-content-risk.mjs --session <同上> --scan          # 逐条消息扫
//   node scripts/trace-content-risk.mjs --session <同上> --bisect 12     # 对第 12 条消息做文本二分
//
// 环境变量：GATEWAY_URL（默认 http://127.0.0.1:20128）、GATEWAY_API_KEY（缺省从本机
// iRouter 库读）、PROBE_MODEL（默认 hd/deepseek-v4.1-flash）、PROBE_CONCURRENCY（默认 2）。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:20128").replace(/\/$/, "");
const PROBE_MODEL = process.env.PROBE_MODEL || "hd/deepseek-v4.1-flash";
const CONCURRENCY = Math.max(1, Number(process.env.PROBE_CONCURRENCY || 2));
const REPORT_PATH = process.env.PROBE_REPORT || "/tmp/content-risk-report.json";
// 探针用的极简 system：不带工具、不带项目上下文，先做便宜的粗筛
const MINIMAL_SYSTEM = "You are a helpful assistant.";

function apiKey() {
  if (process.env.GATEWAY_API_KEY) return process.env.GATEWAY_API_KEY;
  for (const dir of ["~/.irouter/db/data.sqlite", "~/.9router/db/data.sqlite"]) {
    const p = join(homedir(), dir.slice(2));
    if (!existsSync(p)) continue;
    try {
      const key = execFileSync("sqlite3", [p, "select key from apiKeys limit 1"], { encoding: "utf8" }).trim();
      if (key) return key;
    } catch { /* try next */ }
  }
  throw new Error("找不到网关 API Key：设置 GATEWAY_API_KEY，或确认 ~/.irouter/db/data.sqlite 存在");
}

const KEY = apiKey();

/** 发一次探针；返回 {verdict, status, message} */
export async function probe({ system = MINIMAL_SYSTEM, tools = null, text = null, messages = null, maxTokens = 1 }) {
  const msgs = messages || [];
  if (system) msgs.unshift({ role: "system", content: system });
  if (text != null) msgs.push({ role: "user", content: text });
  const body = { model: PROBE_MODEL, messages: msgs, max_tokens: maxTokens, stream: false };
  if (tools?.length) body.tools = tools;

  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let message = raw.slice(0, 300);
  try { message = JSON.parse(raw)?.error?.message || message; } catch { /* keep raw */ }
  if (res.ok) return { verdict: "ok", status: res.status, message: "" };
  if (res.status === 400 && /Content Exists Risk/i.test(raw)) return { verdict: "flagged", status: res.status, message };
  return { verdict: "other", status: res.status, message };
}

/** 并发受限地跑一批探针 */
async function probeAll(items, run) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = { ...items[idx], ...(await run(items[idx])) };
      process.stderr.write(`\r[probe] ${out.filter(Boolean).length}/${items.length}   `);
    }
  });
  await Promise.all(workers);
  process.stderr.write("\n");
  return out;
}

/** DSH 会话记录（session.v3.jsonl.zstd|jsonl）→ {system, tools, candidates} */
export function loadSession(path) {
  const jsonl = path.endsWith(".zstd")
    ? execFileSync("zstd", ["-dc", path], { encoding: "utf8", maxBuffer: 1 << 30 })
    : readFileSync(path, "utf8");
  const recs = jsonl.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const parts = (content) => (Array.isArray(content) ? content : [])
    .map((p) => p?.text || (p?.type === "tool-result" ? (p.content || []).map((c) => c?.text || "").join("") : "") || "")
    .join("\n");
  // assistant 消息里的 tool-call 参数对上游可见，一并还原
  const assistantText = (msg) => (msg?.content || [])
    .map((p) => p?.text || (p?.type === "tool-call" ? `[tool-call ${p.name}] ${p.arguments || ""}` : ""))
    .filter(Boolean).join("\n");

  let system = "";
  let tools = null;
  const candidates = [];
  for (const r of recs) {
    if (r.type === "system/message" && !system) system = parts(r.data?.message?.content);
    else if (r.type === "request/header" && !tools) tools = r.data?.header?.tools || null;
    else if (r.type === "user/message") candidates.push({ label: `user#${r.seq}`, role: "user", text: parts(r.data?.content) });
    else if (r.type === "assistant/message") candidates.push({ label: `assistant#${r.seq}`, role: "assistant", text: assistantText(r.data?.message) });
    else if (r.type === "tool/result") candidates.push({ label: `tool#${r.seq}`, role: "user", text: parts(r.data?.message?.content) });
  }
  return { system, tools, candidates };
}

/** 文本二分：找到最小命中片段（按行切，行内再按字符切） */
async function bisectText(text, base, label, depth = 0) {
  const lines = text.split("\n");
  if (lines.length > 1) {
    const mid = Math.ceil(lines.length / 2);
    for (const half of [[lines.slice(0, mid), "1/2"], [lines.slice(mid), "2/2"]]) {
      const [ls, tag] = half;
      if (!ls.length) continue;
      const r = await probe({ ...base, text: ls.join("\n") });
      if (r.verdict === "flagged") {
        process.stderr.write(`[bisect] ${label} ${tag} (${ls.length} 行) 仍命中，继续下钻\n`);
        return bisectText(ls.join("\n"), base, `${label} ${tag}`, depth + 1);
      }
    }
    return { label, text, note: "整体命中但两半都不单独命中——触发条件是多段内容/上下文叠加" };
  }
  // 单行：按字符二分
  let cur = text;
  while (cur.length > 64) {
    const mid = Math.ceil(cur.length / 2);
    const half = [cur.slice(0, mid), cur.slice(mid)];
    let narrowed = false;
    for (const h of half) {
      const r = await probe({ ...base, text: h });
      if (r.verdict === "flagged") { cur = h; narrowed = true; break; }
    }
    if (!narrowed) break;
  }
  return { label, text: cur, note: cur.length < text.length ? "已收敛到最小命中片段" : "无法再缩小" };
}

/** 对 OpenAI 格式请求体的 messages 做二分：命中集越来越小，最后在单条内做文本二分 */
async function bisectBody(body) {
  const base = { system: null, tools: body.tools || null };
  let msgs = (body.messages || []).filter((m) => m.role !== "system");
  const sys = (body.messages || []).find((m) => m.role === "system");
  if (sys) base.system = typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);

  const head = await probe({ ...base, messages: msgs.map((m) => ({ ...m })) });
  console.log(`[bisect] 全量 ${msgs.length} 条（${JSON.stringify(msgs).length}B）→ ${head.verdict.toUpperCase()} ${head.status}`);
  if (head.verdict !== "flagged") return null;

  while (msgs.length > 1) {
    const mid = Math.ceil(msgs.length / 2);
    let next = null;
    for (const [part, tag] of [[msgs.slice(0, mid), "前"], [msgs.slice(mid), "后"]]) {
      if (!part.length) continue;
      const r = await probe({ ...base, messages: part.map((m) => ({ ...m })) });
      console.log(`[bisect] ${tag}${part.length}条 → ${r.verdict.toUpperCase()}`);
      if (r.verdict === "flagged") { next = part; break; }
    }
    if (!next) { console.log("[bisect] 两半都不单独命中：触发条件是多条消息叠加"); break; }
    msgs = next;
  }

  const text = msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  const hit = await bisectText(text, base, "最小命中消息");
  return { messages: msgs.length, text: hit.text };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

  console.log(`[probe] 网关 ${GATEWAY_URL} | 模型 ${PROBE_MODEL} | 并发 ${CONCURRENCY}`);

  // 从「已捕获的请求体」定位：providerRequest（OpenAI 格式）或客户端原始 body 均可
  const fromBody = value("--from-body");
  if (fromBody) {
    const body = JSON.parse(readFileSync(fromBody, "utf8"));
    const hit = await bisectBody(body);
    writeFileSync(REPORT_PATH, JSON.stringify(hit || { verdict: "not-reproduced" }, null, 2));
    if (hit) console.log(`\n=== 最小命中片段（${hit.text.length}B）===\n${hit.text.slice(0, 4000)}`);
    return;
  }

  // watch：轮询请求详情库，出现新的 Content Exists Risk 且请求体未被截断时自动定位
  if (flag("--watch")) {
    const db = value("--db") || join(homedir(), ".irouter/db/data.sqlite");
    const intervalMs = Number(value("--interval") || 15000);
    let since = new Date().toISOString();
    console.log(`[watch] 监听 ${db}（每 ${intervalMs / 1000}s）自 ${since}`);
    for (;;) {
      const sql = `select id, timestamp, json_extract(data,'$.providerRequest') as body, json_extract(data,'$.providerRequest._truncated') as trunc from requestDetails where lower(data) like '%exists risk%' and timestamp > '${since}' order by timestamp`;
      let rows = [];
      try { rows = JSON.parse(execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" }) || "[]"); } catch { /* db busy */ }
      for (const r of rows) {
        since = r.timestamp;
        if (r.trunc || !r.body) { console.log(`[watch] ${r.timestamp} 命中但请求体被截断——请把 observabilityMaxJsonSize 调大后重试`); continue; }
        const file = `/tmp/content-risk-body-${r.id}.json`;
        writeFileSync(file, r.body);
        console.log(`[watch] ${r.timestamp} 捕获请求体 ${r.body.length}B → ${file}，开始二分`);
        const hit = await bisectBody(JSON.parse(r.body));
        writeFileSync(REPORT_PATH, JSON.stringify({ id: r.id, at: r.timestamp, hit }, null, 2));
        if (hit) console.log(`\n=== 最小命中片段（${hit.text.length}B）===\n${hit.text.slice(0, 4000)}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  if (flag("--text") || value("--text-file")) {
    const text = value("--text") ?? readFileSync(value("--text-file"), "utf8");
    const r = await probe({ text });
    const rep = [{ label: "--text", ...r }];
    writeFileSync(REPORT_PATH, JSON.stringify(rep, null, 2));
    console.log(`${r.verdict.toUpperCase()} status=${r.status} ${r.message}`);
    return;
  }

  if (flag("--files")) {
    const files = argv.slice(argv.indexOf("--files") + 1).filter((a) => !a.startsWith("--"));
    const items = files.map((f) => ({ label: f, text: readFileSync(f, "utf8") }));
    const res = await probeAll(items, (it) => probe({ text: it.text }));
    writeFileSync(REPORT_PATH, JSON.stringify(res, null, 2));
    for (const r of res) console.log(`${r.verdict.toUpperCase().padEnd(7)} ${String(r.status).padEnd(4)} ${r.label}`);
    console.log(`命中 ${res.filter((r) => r.verdict === "flagged").length}/${res.length}，报告 ${REPORT_PATH}`);
    return;
  }

  const session = value("--session");
  if (!session) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 26).join("\n"));
    process.exit(2);
  }

  const { system, tools, candidates } = loadSession(session);
  console.log(`[session] ${candidates.length} 条消息 | system ${system.length}B | tools ${tools ? tools.length : 0} 个`);

  if (flag("--base-only")) {
    const r = await probe({ system, tools, messages: [] });
    console.log(`base(system+tools) → ${r.verdict.toUpperCase()} status=${r.status} ${r.message}`);
    writeFileSync(REPORT_PATH, JSON.stringify([{ label: "base", ...r }], null, 2));
    return;
  }

  const base = { system, tools };

  if (value("--bisect")) {
    const idx = Number(value("--bisect"));
    const c = candidates[idx];
    if (!c) throw new Error(`没有第 ${idx} 条消息`);
    const whole = await probe({ ...base, text: c.text });
    console.log(`[bisect] 目标 ${idx} ${c.label}（${c.text.length}B）→ ${whole.verdict.toUpperCase()}`);
    if (whole.verdict !== "flagged") return;
    const hit = await bisectText(c.text, base, c.label);
    writeFileSync(REPORT_PATH, JSON.stringify([hit], null, 2));
    console.log(`\n=== 最小命中片段（${hit.text.length}B）===\n${hit.text.slice(0, 4000)}`);
    return;
  }

  // 默认：逐条消息粗筛（极简 system，无 tools），再对命中项做 base 复核
  const res = await probeAll(candidates, (c) => probe({ text: c.text }));
  const flagged = res.filter((r) => r.verdict === "flagged");
  console.log(`粗筛命中 ${flagged.length}/${res.length}`);
  for (const f of flagged) {
    const confirm = await probe({ ...base, text: f.text });
    console.log(`  复核 ${f.label} → ${confirm.verdict.toUpperCase()} status=${confirm.status}`);
    f.confirmed = confirm.verdict === "flagged";
  }
  writeFileSync(REPORT_PATH, JSON.stringify(res, null, 2));
  console.log(`报告 ${REPORT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
