#!/usr/bin/env node
// 构建内嵌网关：9router 源码已并入仓库根目录（原 submodule 已废弃），
// 在根目录产出 Next standalone，复制进 desktop/build/server。
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..");
// 网关源码 = 仓库根目录（根 package.json 的 build/postbuild 即 9router 构建脚本）
const UPSTREAM = REPO_ROOT;
const STANDALONE = join(UPSTREAM, ".next", "standalone");
const OUT = join(DESKTOP_ROOT, "build", "gateway", "server");

// 产品版本号真源 = desktop/package.json（见 docs/adr/0004）。
// 面板可见版本号由此注入：config.js 被客户端组件导入，运行时读文件不可用，
// NEXT_PUBLIC_* 是 Next 构建期内联到客户端 bundle 的唯一直通路径。
const APP_VERSION = JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8")).version;

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
//    NEXT_PUBLIC_APP_VERSION：面板可见版本号（来源 desktop/package.json，见 ADR 0004）
const buildDataDir = join(DESKTOP_ROOT, "build", ".build-data");
mkdirSync(buildDataDir, { recursive: true });
log(`注入 NEXT_PUBLIC_APP_VERSION=${APP_VERSION}`);
run("npm", ["run", "build"], {
  env: {
    JWT_SECRET: "build-secret-irouter-gateway-compilation",
    DATA_DIR: buildDataDir,
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
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

// 4. 剔除 better-sqlite3 原生模块：node_modules 里的 .node 按开发机 Node 编译
//    （实测 dev Node MODULE_VERSION 147，Electron 44 内嵌 Node 24.20 为 149，二者不兼容），
//    且 electron-builder.yml 设置了 npmRebuild: false（打包不重编译），带上必是坏二进制。
//    运行时走驱动链下一级 node:sqlite（Node ≥22.5 内置的真 SQLite，Electron 的 Node 24 自带），
//    不是 sql.js WASM 降级；顺带省掉随包的 ~12MB。
const nativeSqlite = join(OUT, "node_modules", "better-sqlite3");
if (existsSync(nativeSqlite)) {
  rmSync(nativeSqlite, { recursive: true, force: true });
  log("已移除 better-sqlite3（原生模块 ABI 不兼容 Electron，运行时走 node:sqlite）");
}

// 5. 剔除 .env：Next standalone 会把仓库根的 .env 一并拷进来（含 .env.example 的
//    占位密钥）。留着的后果是「密钥取自公开文件」：
//    · JWT_SECRET → dashboardSession.js 走 env 提前返回，永不生成随机 jwt-secret 文件，
//      壳层 main.js 读不到该文件 → smoke 登录注入失败、面板停在 /login；
//      且该值等同已提交的 .env.example，任何人可离线签发合法 auth_token。
//    · INITIAL_PASSWORD=change-me → 覆盖代码默认值 123456，与登录页提示不符。
//    删掉后网关恢复安全默认：JWT_SECRET 首次启动随机生成落盘、初始口令回落 123456。
for (const name of readdirSync(OUT)) {
  if (name === ".env" || name.startsWith(".env.")) {
    rmSync(join(OUT, name), { recursive: true, force: true });
    log(`已移除 ${name}（避免公开占位密钥进入产物，网关改用安全默认值）`);
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
// .env 回归守卫：@next/env 会自动读取服务端同目录的 .env，混入即重新引入公开密钥
for (const name of readdirSync(OUT)) {
  if (name === ".env" || name.startsWith(".env.")) {
    console.error(`[build-server] ${name} 未被移除`);
    process.exit(1);
  }
}

log(`完成 → ${OUT}`);
