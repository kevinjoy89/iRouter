#!/usr/bin/env node
// 单实例（spec: app-shell / 单实例）验证。
// 真实场景：实例 A 已就绪运行 → 用户再次启动 B → B 必须被锁拒绝、不起第二个网关、A 不受影响。
// （刻意同 200ms 双开会撞上 Chromium ProcessSingleton 的已知竞态，那不是 spec 场景。）
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ELECTRON_BIN = require("electron");

const baseEnv = (userData) => ({
  ...process.env,
  NODE_ENV: "",
  IROUTER_USER_DATA: userData,
  IROUTER_LEGACY_DIR: join(userData, "__no_legacy__"),
});

function launch({ userData, smoke }) {
  const child = spawn(ELECTRON_BIN, [DESKTOP_ROOT, ...(smoke ? ["--smoke"] : [])], {
    cwd: DESKTOP_ROOT,
    env: baseEnv(userData),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { text: "" };
  child.stdout.on("data", (d) => (out.text += d));
  child.stderr.on("data", (d) => (out.text += d));
  return { child, out };
}

function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const tick = () => {
      const v = predicate();
      // 不能用 if (v)：退出码 0 是假值，会把“已退出”误判为“未退出”
      if (v !== null && v !== undefined) return resolvePromise(v);
      if (Date.now() >= deadline) return resolvePromise(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function probe(port, path = "/login") {
  return new Promise((resolvePromise) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 3000 }, (res) => {
      res.resume();
      resolvePromise(res.statusCode);
    });
    req.on("error", () => resolvePromise(0));
    req.on("timeout", () => {
      req.destroy();
      resolvePromise(0);
    });
  });
}

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const userData = mkdtempSync(join(tmpdir(), "irouter-single-"));
const a = launch({ userData, smoke: false });
try {
  const readyLine = await waitFor(() => a.out.text.match(/\[iRouter\] ready http:\/\/127\.0\.0\.1:(\d+)/), 90000);
  if (!readyLine) {
    console.error("✗ 实例 A 未就绪，无法测试\n" + a.out.text.slice(-1500));
    process.exit(1);
  }
  const port = Number(readyLine[1]);
  console.log(`  实例 A 就绪，端口 ${port}`);

  // 用户再次启动
  const b = launch({ userData, smoke: true });
  const bT0 = Date.now();
  const bExit = await waitFor(
    () => (b.child.exitCode === null ? null : b.child.exitCode),
    30000
  );
  const bElapsed = Date.now() - bT0;
  const bRejected = /singleInstanceLock=false/.test(b.out.text);
  const bNoGateway = !/\[iRouter\] ready|\[gateway\]/.test(b.out.text);
  const bFast = bExit !== null && bElapsed < 10000;

  check("实例 B 被单实例锁拒绝", bRejected, `exit=${bExit}`);
  check("实例 B 未启动第二个网关", bNoGateway);
  check("实例 B 快速退出", bFast, `${bElapsed}ms`);

  // A 必须毫发无损
  const stillUp = await probe(port);
  check("实例 A 仍在服务（未被 B 干扰）", stillUp === 200, `GET /login -> ${stillUp}`);

  // 退出 A 后端口释放、无残留
  a.child.kill("SIGTERM");
  await waitFor(() => (a.child.exitCode === null ? null : a.child.exitCode), 20000);
  await new Promise((r) => setTimeout(r, 1500));
  const leaked = (await probe(port)) !== 0;
  check("A 退出后端口已释放（无残留进程）", !leaked);
} finally {
  try {
    a.child.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r).length;
console.log(`\n[test-instance] ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
