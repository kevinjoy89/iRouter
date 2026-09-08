#!/usr/bin/env node
// 端到端冒烟：隔离 userData 启动 Electron，验证网关就绪 + 面板加载 + API 可达 + 退出无残留。
// 用法：npm run smoke
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import net from "node:net";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ELECTRON_BIN = require("electron");

function portInUse(port) {
  return new Promise((resolvePromise) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolvePromise(true);
    });
    sock.on("error", () => {
      sock.destroy();
      resolvePromise(false);
    });
    setTimeout(() => {
      sock.destroy();
      resolvePromise(false);
    }, 1500);
  });
}

const userData = mkdtempSync(join(tmpdir(), "irouter-smoke-"));
const out = [];

const child = spawn(ELECTRON_BIN, [DESKTOP_ROOT, "--smoke"], {
  cwd: DESKTOP_ROOT,
  env: {
    ...process.env,
    NODE_ENV: "",
    // 隔离数据目录，绝不碰真实的 ~/Library/Application Support/iRouter
    IROUTER_USER_DATA: userData,
    // 指向不存在的路径，避免被"导入旧数据"模态框卡住
    IROUTER_LEGACY_DIR: join(userData, "no-legacy"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (d) => {
  const s = String(d);
  out.push(s);
  process.stdout.write(s);
});
child.stderr.on("data", (d) => {
  const s = String(d);
  out.push(s);
  process.stderr.write(s);
});

const killer = setTimeout(() => {
  console.error("[smoke] 超时 180s，强制终止");
  child.kill("SIGKILL");
}, 180000);

child.on("exit", async (code) => {
  clearTimeout(killer);
  rmSync(userData, { recursive: true, force: true });

  const log = out.join("");
  const port = Number((log.match(/\[smoke\] port=(\d+)/) || [])[1]);
  let ok = code === 0 && /\[smoke\] PASS/.test(log);

  if (port) {
    await new Promise((r) => setTimeout(r, 1500));
    const leaked = await portInUse(port);
    console.log(`[smoke] 端口 ${port} 退出后${leaked ? "仍被占用 ✗（进程残留）" : "已释放 ✓"}`);
    ok &&= !leaked;
  } else {
    console.log("[smoke] 未能解析端口（可能未启动到网关阶段）");
    ok = false;
  }

  console.log(`[smoke] 总体 ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
});
