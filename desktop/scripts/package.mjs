#!/usr/bin/env node
// 打包入口：统一走国内镜像源，避免 electron / electron-builder 工具包
// 从 GitHub 直连下载时卡死（本机多次卡在 "Timeout awaiting 'request'"）。
// 可被环境变量覆盖：ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

process.env.ELECTRON_MIRROR ??= "https://npmmirror.com/mirrors/electron/";
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= "https://npmmirror.com/mirrors/electron-builder-binaries/";

// 打包前清空输出目录。electron-builder 不会清理 output（见 electron-builder.yml 的
// directories.output = build/dist），于是历史上每个版本的 dmg 与解压产物都会累积：
// 实测 desktop/build/ 曾达 1.0 GiB，其中还躺着一份与 build/dist 完全重复的 dist-preview，
// 而当时的产物版本是 0.3.3、package.json 已经是 0.3.7。产物是纯派生物（npm run dist:* 可
// 重新生成），所以默认清空；需要留档时设 IROUTER_KEEP_DIST=1。
const OUTPUT_DIR = join(DESKTOP_ROOT, "build", "dist");
if (process.env.IROUTER_KEEP_DIST === "1") {
  console.log("[package] IROUTER_KEEP_DIST=1，保留既有输出目录");
} else if (existsSync(OUTPUT_DIR)) {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  console.log(`[package] 已清空输出目录 ${OUTPUT_DIR}`);
}

const cli = require.resolve("electron-builder/out/cli/cli.js");

// 避免 CI/Tag 构建环境下 electron-builder 触发隐式发布导致的 GH_TOKEN 校验失败
const userArgs = process.argv.slice(2);
const hasPublishFlag = userArgs.some(
  (arg) => arg.startsWith("--publish") || arg === "-p",
);
const defaultArgs = hasPublishFlag ? [] : ["--publish", "never"];

const child = spawn(process.execPath, [cli, ...defaultArgs, ...userArgs], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));