#!/usr/bin/env node
// 对**打包产物**（.app）跑冒烟：验证 extraResources 路径、ELECTRON_RUN_AS_NODE 子进程、
// DATA_DIR 注入在成品里同样成立。需先执行 electron-builder --mac。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_BIN = join(
  DESKTOP_ROOT,
  "build",
  "dist",
  "mac-arm64",
  "iRouter.app",
  "Contents",
  "MacOS",
  "iRouter",
);
const APP_GATEWAY = join(
  DESKTOP_ROOT,
  "build",
  "dist",
  "mac-arm64",
  "iRouter.app",
  "Contents",
  "Resources",
  "gateway",
  "server",
);

if (!existsSync(APP_BIN)) {
  console.error(`找不到打包产物：${APP_BIN}\n请先执行：npm run dist:mac`);
  process.exit(1);
}

// 产物内不得混入 .env：其中的 JWT_SECRET / INITIAL_PASSWORD 是仓库里公开的占位值，
// 一旦随包分发，网关会用它替代随机生成的 jwt-secret，且初始口令被改成 change-me。
const envLeaks = existsSync(APP_GATEWAY)
  ? readdirSync(APP_GATEWAY).filter(
      (n) => n === ".env" || n.startsWith(".env."),
    )
  : [];
if (envLeaks.length > 0) {
  console.error(`[packaged] 产物内含公开密钥文件：${envLeaks.join(", ")}`);
  process.exit(1);
}

// 产物内必须带 DLP 规则文件：它是运行时 fs 读取的数据文件，不进入 Next 的
// import 图，也不被 tracing 收集。缺了它引擎会 fail-open——面板显示「脱敏」已开，
// 而实际每条请求都零扫描（最坏失败模式：看起来在工作）。
const APP_DLP_RULES = join(APP_GATEWAY, "open-sse", "dlp", "dlp_rules.yaml");
if (existsSync(APP_GATEWAY) && !existsSync(APP_DLP_RULES)) {
  console.error(`[packaged] 产物缺少 DLP 规则文件：${APP_DLP_RULES}`);
  process.exit(1);
}

const userData = mkdtempSync(join(tmpdir(), "irouter-packaged-"));
const child = spawn(APP_BIN, ["--smoke"], {
  cwd: DESKTOP_ROOT,
  env: {
    ...process.env,
    NODE_ENV: "",
    IROUTER_USER_DATA: userData,
    IROUTER_LEGACY_DIR: join(userData, "__no_legacy__"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let text = "";
child.stdout.on("data", (d) => {
  text += d;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => (text += d));
const killer = setTimeout(() => child.kill("SIGKILL"), 180000);

child.on("exit", (code) => {
  clearTimeout(killer);
  const entries = existsSync(userData) ? readdirSync(userData) : [];
  const hasGatewayData = entries.includes("db");
  rmSync(userData, { recursive: true, force: true });

  const pass = code === 0 && /\[smoke\] PASS/.test(text) && hasGatewayData;
  console.log(
    `[packaged] 退出码=${code} | 网关数据写入 userData=${hasGatewayData ? "✓(db/)" : "✗"}`,
  );
  console.log(`[packaged] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
});
