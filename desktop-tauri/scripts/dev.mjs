#!/usr/bin/env node
/**
 * dev 启动器：stage sidecar → 指路网关负载 → `tauri dev`。
 *
 * 依据 docs/plans/2026-10-07-tauri-bun-sidecar-packaging.md §3.2：
 * **`tauri dev` 不复制 resources**，所以 dev 形态必须用 IROUTER_GATEWAY_DIR 显式指路
 * （生产形态走 resource_dir()/gateway，见 src-tauri/src/gateway.rs 的三级回退）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = resolve(HERE, "..");
const REPO = resolve(SHELL_ROOT, "..");
const GATEWAY_DIR = join(REPO, "build", "gateway", "server");

// 1. stage sidecar（幂等：已就位则跳过下载）
const stage = spawnSync("node", [join(HERE, "stage-sidecar.mjs")], { stdio: "inherit" });
if (stage.status !== 0) process.exit(stage.status ?? 1);

// 2. 负载必须在位
if (!existsSync(join(GATEWAY_DIR, "custom-server.js"))) {
  console.error(`[dev] 找不到网关负载 ${GATEWAY_DIR}`);
  console.error(`[dev] 先跑：npm --prefix desktop-tauri run gateway:build`);
  process.exit(1);
}

// 3. 启动 tauri dev，并把负载位置显式告诉壳层
console.log(`[dev] IROUTER_GATEWAY_DIR=${GATEWAY_DIR}`);
const dev = spawnSync("npx", ["tauri", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: SHELL_ROOT,
  env: { ...process.env, IROUTER_GATEWAY_DIR: GATEWAY_DIR },
});
process.exit(dev.status ?? 1);
