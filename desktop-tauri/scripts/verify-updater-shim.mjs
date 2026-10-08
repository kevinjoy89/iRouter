#!/usr/bin/env node
/**
 * Phase 4B 验收：**更新器 shim（`window.irouterShell`）契约验证**（无需 GUI、无需联网）。
 *
 * 为什么用 Node 跑而不是 `cargo test`：契约里有三条**只有真的执行一遍 JS 才能验**——
 *   ① `window.irouterShell` 在脚本求值后**同步**存在（为假则面板「软件更新」整段消失，
 *      `src/shared/components/ShellSettingsModal.js:66-70`）；
 *   ② `onUpdateX()` **同步返回取消函数**（面板写的是 `unsubX?.()`，返回 Promise 会静默
 *      不执行 → 监听器泄漏，`UpdateSettings.js:72-77`）；
 *   ③ 事件 payload 原样解包交给面板；`update-error` 收到的是**裸字符串**。
 * Rust 侧的 `cargo test updater::` 只能验"shim.js 源码里存在这些形状"（结构性断言），
 * 这里补上"跑起来真的成立"。
 *
 * 跨文件一致性（X 组）也在这里做：shim 里的事件名/命令名与 `src/updater/*.rs` 对账——
 * 任何一侧改名都能在这里立刻红，而不是等用户发现"更新功能静默消失"。
 *
 * 用法：node scripts/verify-updater-shim.mjs [--shim <path>]
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const SHELL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATER_DIR = join(SHELL_ROOT, "src-tauri", "src", "updater");
const SHIM = argOf("--shim", join(UPDATER_DIR, "shim.js"));

const results = [];
const record = (id, title, ok, ev = "") => {
  results.push({ id, title, ok, ev });
  console.log(`  ${ok ? "✓" : "✗"} ${id} ${title}${ev ? `\n      ${ev}` : ""}`);
};

if (!statSync(SHIM, { throwIfNoEntry: false })) {
  console.error(`[shim] 找不到 ${SHIM}`);
  process.exit(2);
}
const SRC = readFileSync(SHIM, "utf8");

/**
 * 在假 window 上求值 shim.js。
 * - `internalsAtStart=false` 用来模拟"init 脚本早于 `__TAURI_INTERNALS__` 注入"（设计 §16-U1）；
 * - setTimeout 用**真定时器**，否则 boot 轮询不会跑（上一版假定时器就漏掉了这条）。
 */
function makeHarness({ internalsAtStart = true, preexisting = null } = {}) {
  const calls = [];
  const callbacks = new Map();
  const win = {
    __IROUTER_PLATFORM__: "darwin",
    navigator: { platform: "MacIntel", userAgent: "verify-updater-shim" },
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms || 0),
    Promise, Object, String, console, JSON,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
  };
  win.window = win;
  if (preexisting) win.irouterShell = preexisting;

  let nextId = 1;
  const internals = {
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "plugin:event|listen") return nextId++;
      return null;
    },
    transformCallback: (cb) => { const id = nextId++; callbacks.set(id, cb); return id; },
  };
  if (internalsAtStart) win.__TAURI_INTERNALS__ = internals;
  vm.runInContext(SRC, vm.createContext(win), { filename: "shim.js" });
  return { win, calls, callbacks, internals };
}

const tick = (ms = 30) => new Promise((r) => globalThis.setTimeout(r, ms));
const listenCalls = (h) => h.calls.filter(([c]) => c === "plugin:event|listen");
const shellCalls = (h) => h.calls.filter(([c]) => c.startsWith("shell_"));
// 事件名在 shim 侧被改坏时，宁可让断言干净地红，也不要抛 TypeError 崩掉整脚本
const handlerFor = (h, event) => {
  const hit = listenCalls(h).find(([, a]) => a.event === event);
  const cb = hit ? h.callbacks.get(hit[1].handler) : null;
  return typeof cb === "function" ? cb : () => {};
};

console.log(`[shim] ${SHIM}\n[shim] 运行时契约：`);

// ---------------- S 组：运行时行为 ----------------
{
  // S1 同步存在性（契约①）
  const h = makeHarness();
  record("S1", "求值后 window.irouterShell 同步存在且为对象（为假则「软件更新」整段消失）",
    Boolean(h.win.irouterShell) && typeof h.win.irouterShell === "object",
    `typeof=${typeof h.win.irouterShell}`);
  record("S2", "platform 取 Rust 注入的字面量（不是 navigator 猜的）",
    h.win.irouterShell.platform === "darwin", String(h.win.irouterShell.platform));

  // S3 对外 ABI 的方法名一个都不能少
  const methods = ["checkUpdate", "downloadUpdate", "cancelDownload", "installUpdate", "ignoreVersion",
    "onUpdateProgress", "onUpdateAvailable", "onUpdateDownloaded", "onUpdateError"];
  const missing = methods.filter((m) => typeof h.win.irouterShell[m] !== "function");
  record("S3", "9 个方法名齐全（面板直接按名字调用，缺一个 = 该功能静默不动作）",
    missing.length === 0, missing.length ? `缺：${missing.join(", ")}` : `共 ${methods.length} 个`);

  // S4 与 shell 的 shim 合并而不是覆盖（两处 initialization_script 写同一个对象）
  const h2 = makeHarness({ preexisting: { getSettings: () => "kept", setSetting: () => "kept" } });
  record("S4", "与 shell 的 shim 合并（预置成员不被覆盖）",
    typeof h2.win.irouterShell.getSettings === "function" && typeof h2.win.irouterShell.checkUpdate === "function",
    `getSettings=${typeof h2.win.irouterShell.getSettings} checkUpdate=${typeof h2.win.irouterShell.checkUpdate}`);
}

{
  // S5/S6/S7 同步 unlisten + 单次 listen + 本地分发
  const h = makeHarness();
  const got = [];
  const off = h.win.irouterShell.onUpdateAvailable((res) => got.push(res));
  record("S5", "onUpdateX 同步返回取消函数，且不是 Promise（返回 Promise → ?.() 静默不执行）",
    typeof off === "function" && !(off instanceof Promise), `typeof=${typeof off}`);

  await tick();
  const subs = listenCalls(h);
  record("S6", "4 个事件各只 listen 一次（不随订阅次数增长）",
    subs.length === 4, `listen：${JSON.stringify(subs.map((c) => c[1].event))}`);
  record("S7", "listen 的 target 为 Any（否则 Rust 侧 emit 到主窗口时收不到）",
    subs.length === 4 && subs.every(([, a]) => a[1] === undefined ? a.target.kind === "Any" : a.target.kind === "Any"),
    JSON.stringify(subs[0] && subs[0][1].target));

  const fire = handlerFor(h, "shell:update-available");
  fire({ event: "shell:update-available", id: 1, payload: { updateAvailable: true, latest: "0.3.9" } });
  record("S8", "payload 原样解包交给面板（去掉 Tauri 的 {event,id,payload} 外壳）",
    got.length === 1 && got[0].latest === "0.3.9", JSON.stringify(got));

  // off() 可能是坏实现返回的 Promise/undefined —— 别让验证脚本自己炸掉，记录成失败即可
  let offCallable = typeof off === "function";
  try { if (offCallable) off(); } catch (e) { offCallable = false; }
  fire({ event: "shell:update-available", id: 1, payload: { latest: "1.0.0" } });
  record("S9", "取消订阅后不再收到回调（取消函数必须可同步调用）",
    offCallable && got.length === 1,
    `可调用=${offCallable} 收到 ${got.length} 次`);

  const got2 = [];
  h.win.irouterShell.onUpdateAvailable((r) => got2.push(r));
  fire({ event: "shell:update-available", id: 1, payload: { latest: "2.0.0" } });
  record("S10", "多订阅者互不干扰；重新订阅不重复 listen",
    got2.length === 1 && got2[0].latest === "2.0.0" && listenCalls(h).length === 4,
    `got2=${JSON.stringify(got2)} listen=${listenCalls(h).length}`);
}

{
  // S11 error payload 必须是裸字符串（发对象面板渲染直接炸）
  const h = makeHarness();
  await tick();
  const seen = [];
  h.win.irouterShell.onUpdateError((e) => seen.push(e));
  handlerFor(h, "shell:update-error")({ event: "shell:update-error", id: 1, payload: "Download canceled by user" });
  record("S11", "shell:update-error 的 payload 是裸字符串（不是 {message}/{error} 对象）",
    seen.length === 1 && typeof seen[0] === "string" && seen[0] === "Download canceled by user",
    JSON.stringify(seen));

  // S12 命令名与参数形状（Tauri 命令名 = Rust 函数名原样；参数按 camelCase）
  await h.win.irouterShell.checkUpdate(true);
  await h.win.irouterShell.checkUpdate();
  await h.win.irouterShell.downloadUpdate();
  await h.win.irouterShell.cancelDownload();
  await h.win.irouterShell.installUpdate();
  await h.win.irouterShell.ignoreVersion("0.3.9");
  await h.win.irouterShell.ignoreVersion(undefined);
  const expected = JSON.stringify([
    ["shell_check_update", { force: true }],
    ["shell_check_update", { force: false }],
    ["shell_download_update", {}],
    ["shell_cancel_download", {}],
    ["shell_install_update", {}],
    ["shell_ignore_version", { version: "0.3.9" }],
    ["shell_ignore_version", { version: null }],
  ]);
  record("S12", "命令名与参数形状逐字匹配（force 缺省=false；非字符串 version → null）",
    JSON.stringify(shellCalls(h)) === expected, JSON.stringify(shellCalls(h)));
}

{
  // S13 桥接晚于 shim 注入（设计 §16-U1 的"不依赖顺序"写法）
  const h = makeHarness({ internalsAtStart: false });
  record("S13", "桥接尚未注入时：irouterShell 仍同步存在、调用排队不抛错",
    Boolean(h.win.irouterShell) &&
    typeof h.win.irouterShell.onUpdateAvailable(() => {}) === "function" &&
    h.win.irouterShell.checkUpdate(false) instanceof Promise);

  h.win.__TAURI_INTERNALS__ = h.internals;
  await tick(50);
  record("S14", "桥接出现后：排队的调用被回放，4 个 listen 补齐（不丢任何订阅）",
    shellCalls(h).some(([c, a]) => c === "shell_check_update" && a.force === false) && listenCalls(h).length === 4,
    JSON.stringify(h.calls.map((c) => c[0])));
}

// ---------------- X 组：跨文件一致性 ----------------
{
  const eventsRs = readFileSync(join(UPDATER_DIR, "events.rs"), "utf8");
  const evNames = [...eventsRs.matchAll(/pub const EV_[A-Z_]+: &str = "([^"]+)"/g)].map((m) => m[1]);
  // 发给 webview 的 4 个（shell:update-*）必须逐字出现在 shim 里；
  // Rust→Rust 的应用内事件（shell:check-update-requested）**必须不在** shim 里（面板不该看到它）
  const toWebview = evNames.filter((n) => n.startsWith("shell:update-"));
  const internal = evNames.filter((n) => !n.startsWith("shell:update-"));
  const leaked = internal.filter((n) => SRC.includes(n));
  record("X1", "shim 的事件名与 events.rs 对齐：4 个发面板的逐字一致，应用内事件不外泄",
    toWebview.length === 4 && toWebview.every((n) => SRC.includes(n)) && leaked.length === 0,
    `events.rs=${JSON.stringify(evNames)}` + (leaked.length ? ` 泄漏到面板：${leaked}` : ""));

  const cmdsRs = readFileSync(join(UPDATER_DIR, "commands.rs"), "utf8");
  const cmdNames = [...cmdsRs.matchAll(/#\[tauri::command\][\s\S]{0,120}?pub (?:async )?fn (\w+)/g)].map((m) => m[1]);
  const notInShim = cmdNames.filter((c) => !SRC.includes(`'${c}'`));
  record("X2", "commands.rs 的每个 #[tauri::command] 都被 shim 调用（否则是死命令）",
    cmdNames.length === 5 && notInShim.length === 0,
    `commands.rs=${JSON.stringify(cmdNames)}` + (notInShim.length ? ` 未在 shim 中：${notInShim}` : ""));

  const firstAssign = SRC.indexOf("window.irouterShell =");
  const firstAsync = SRC.indexOf("setTimeout(waitForBridge");
  record("X3", "源码顺序：同步建立 irouterShell 早于任何等待/异步（契约①的结构保证）",
    firstAssign !== -1 && firstAsync !== -1 && firstAssign < firstAsync,
    `assign@${firstAssign} waitForBridge@${firstAsync}`);

  record("X4", "onUpdateX 走本地分发而不是每次订阅都 listen（源码级）",
    SRC.includes("function on(event, cb)") && SRC.includes("listeners[event] || (listeners[event] = [])"));
}

// ---------------- 汇总 ----------------
const failed = results.filter((r) => !r.ok);
console.log(`\n================ 更新器 shim 契约验收 ================\n${results.length - failed.length}/${results.length} 通过`);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.id.padEnd(4)} ${r.title}`);
console.log(`\n总体：${failed.length === 0 ? "PASS ✅" : `FAIL ❌ —— ${failed.length} 项`}`);
if (failed.length) for (const f of failed) console.log(`  ${f.id} ${f.title}\n    ${f.ev}`);
process.exit(failed.length === 0 ? 0 : 1);
