#!/usr/bin/env node
// 构建内嵌网关：在锁版上游 9router/ 产出 Next standalone，复制进 desktop/build/server。
// 上游源码零改动——只读取，产物全部落在 desktop/build/（见 docs/adr/0002-pinned-upstream.md）。
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..");
const UPSTREAM = join(REPO_ROOT, "9router");
const STANDALONE = join(UPSTREAM, ".next", "standalone");
const OUT = join(DESKTOP_ROOT, "build", "gateway", "server");

function log(msg) {
  console.log(`[build-server] ${msg}`);
}

/**
 * 构建用净化环境。
 * 宿主进程（u1s1 本身是 Next.js 服务）会向 shell 泄漏 Next 私有变量：
 *   __NEXT_PRIVATE_STANDALONE_CONFIG / __NEXT_PRIVATE_ORIGIN / NEXT_DIST_DIR ...
 * 子进程 next build 一旦读到，就会跳过本项目的 next.config.mjs、改用宿主配置
 * （distDir 变成 .next-desktop、outputFileTracingRoot 指向不存在的 CI 路径），
 * 构建以 "TypeError: generate is not a function" 崩溃。必须整批剔除。
 */
function buildEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("__NEXT_")) continue;
    if (k === "NEXT_DIST_DIR" || k === "NEXT_DEPLOYMENT_ID") continue;
    // NEXT_TRACING_ROOT_MODE=workspace 会让 postbuild 跳过资源复制（CLI 打包专用）
    if (k === "NEXT_TRACING_ROOT_MODE") continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function run(cmd, args, { env } = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, {
    cwd: UPSTREAM,
    stdio: "inherit",
    env: buildEnv(env),
  });
}

function assertDir(p, what) {
  if (!existsSync(p)) {
    console.error(`[build-server] 缺少 ${what}: ${p}`);
    process.exit(1);
  }
}

// 1. 上游依赖（幂等）。@tailwindcss/postcss 等构建必需依赖在 devDependencies，
//    而本机 npm 因 NODE_ENV=production 默认省略 dev，必须显式 --include=dev。
run("npm", ["install", "--include=dev", "--no-audit", "--no-fund"], {
  env: { NODE_ENV: "" },
});

// 2. 构建：next build --webpack + postbuild(copy-standalone-assets.mjs
//    把 static/ public/ custom-server.js 并入 .next/standalone)
//    注入构建期临时的 JWT_SECRET 与 DATA_DIR，避免收集路由信息时触碰主目录 ~/.9router
const buildDataDir = join(DESKTOP_ROOT, "build", ".build-data");
mkdirSync(buildDataDir, { recursive: true });
run("npm", ["run", "build"], {
  env: {
    JWT_SECRET: "build-secret-irouter-gateway-compilation",
    DATA_DIR: buildDataDir,
  },
});

assertDir(STANDALONE, "Next standalone 产物");
assertDir(join(STANDALONE, "custom-server.js"), "custom-server.js");

// 3. 干净房间：复制 standalone → desktop/build/gateway/server
//    必须嵌套一层（gateway/server）：electron-builder 复制 extraResources 时，
//    相对路径恰好为 node_modules 的目录会被硬编码排除（util/filter.js），
//    下沉一层后变成 server/node_modules，才能随包分发。
rmSync(OUT, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
cpSync(STANDALONE, OUT, { recursive: true });

// 4. 强制 sql.js 纯 WASM 回退：剔除 Electron ABI 下需要重编译的原生模块
const nativeSqlite = join(OUT, "node_modules", "better-sqlite3");
if (existsSync(nativeSqlite)) {
  rmSync(nativeSqlite, { recursive: true, force: true });
  log("已移除 better-sqlite3（运行时走 sql.js 回退）");
}

// 5. 合并桌面端补丁多语言字典进 standalone 产物
const i18nPatchDir = join(DESKTOP_ROOT, "resources", "i18n");
const literalsDir = join(OUT, "public", "i18n", "literals");
if (existsSync(i18nPatchDir) && existsSync(literalsDir)) {
  const patchFiles = readdirSync(i18nPatchDir).filter((f) => f.endsWith(".json"));
  for (const patchFile of patchFiles) {
    const targetFile = join(literalsDir, patchFile);
    try {
      const patchContent = JSON.parse(readFileSync(join(i18nPatchDir, patchFile), "utf8"));
      let baseContent = {};
      if (existsSync(targetFile)) {
        baseContent = JSON.parse(readFileSync(targetFile, "utf8"));
      }
      const merged = { ...baseContent, ...patchContent };
      writeFileSync(targetFile, JSON.stringify(merged, null, 2), "utf8");
      log(`已合并多语言补丁字典: ${patchFile} (${Object.keys(patchContent).length} 条目)`);
    } catch (err) {
      console.error(`[build-server] 合并多语言补丁字典失败 ${patchFile}:`, err);
    }
  }
}

// 6. 产物自检
for (const [p, what] of [
  [join(OUT, "custom-server.js"), "custom-server.js"],
  [join(OUT, "server.js"), "server.js"],
  [join(OUT, ".next", "static"), ".next/static"],
  [join(OUT, "public"), "public"],
]) {
  assertDir(p, what);
}
if (existsSync(nativeSqlite)) {
  console.error("[build-server] better-sqlite3 未被移除");
  process.exit(1);
}

log(`完成 → ${OUT}`);
