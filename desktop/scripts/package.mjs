#!/usr/bin/env node
// 打包入口：统一走国内镜像源，避免 electron / electron-builder 工具包
// 从 GitHub 直连下载时卡死（本机多次卡在 "Timeout awaiting 'request'"）。
// 可被环境变量覆盖：ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

process.env.ELECTRON_MIRROR ??= "https://npmmirror.com/mirrors/electron/";
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= "https://npmmirror.com/mirrors/electron-builder-binaries/";

const cli = require.resolve("electron-builder/out/cli/cli.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));