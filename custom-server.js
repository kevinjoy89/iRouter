const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

// 面板访问守卫（仅桌面形态启用：网关子进程环境带 IR_PANEL_GUARD=1）。
// 浏览器直连 HTML 页面时不回任何 HTTP 响应——写一行非法状态后掐断 socket，
// 浏览器呈现 ERR_INVALID_HTTP_RESPONSE / ERR_EMPTY_RESPONSE，而非可用页面。
// CLI（/v1、/api）、OAuth 回跳（/callback）与桌面窗口（注入客户端头）不受影响。
const PANEL_CLIENT_HEADER = "x-irouter-client";
const PANEL_CLIENT_VALUE = "irouter-app";

// Tauri 壳层每次启动生成的随机令牌（`IR_PANEL_GUARD_TOKEN`，经 webview UA 携带）。
//
// 为什么要有它：固定头与 `Electron/` UA 都写在开源仓库里，**任何本地进程都能伪造**——它们
// 只是「防误开」，不是安全边界。Tauri 壳把 webview 的 UA 设成
// `iRouter/<ver> iRouterGuard/<token>`（见 desktop-tauri/src-tauri/src/guard.rs），令牌每次启动
// 重新生成、只存在于内存与该进程环境里，于是「能加载该 origin」重新等于「就是我们的窗口」。
//
// 迁移期两种壳并存：Electron 版仍走原路径（固定头 / Electron UA），Tauri 版走令牌。
// 等 Electron 壳退役后再收紧（见 ADR-0007 与迁移计划 Phase 6）。
const PANEL_GUARD_TOKEN = process.env.IR_PANEL_GUARD_TOKEN || "";
const GUARD_UA_PREFIX = "iRouterGuard/";

function hasValidGuardToken(ua) {
  return Boolean(PANEL_GUARD_TOKEN) && ua.includes(`${GUARD_UA_PREFIX}${PANEL_GUARD_TOKEN}`);
}

function isBlockedPanelRequest(req) {
  // 桌面窗口识别：Tauri 的随机令牌（最强）→ 显式客户端头 → Electron UA（迁移期兼容）。
  // 浏览器无法天然携带三者之一，即被连接级拒绝。
  const ua = req.headers["user-agent"] || "";
  const hasClient =
    hasValidGuardToken(ua) ||
    req.headers[PANEL_CLIENT_HEADER] === PANEL_CLIENT_VALUE ||
    ua.includes("Electron/");
  if (hasClient) return false;
  const accept = req.headers.accept || "";
  const isHtmlPage = accept.includes("text/html");
  // Server Action POST（Next-Action 头）来自过期客户端（升级前残留的浏览器
  // 标签页/旧窗口）时同样掐断——否则旧 action ID 会在网关日志里刷
  // "Failed to find Server Action"
  const isServerAction = Boolean(req.headers["next-action"]);
  if (!isHtmlPage && !isServerAction) return false;
  const path = (req.url || "/").split("?")[0];
  if (path === "/callback" || path.startsWith("/callback/") ||
      path.startsWith("/v1") || path.startsWith("/api")) return false;
  return true;
}

// action 形态 POST（Next-Action 头 / multipart 体）：Next 把两者都当作可能的
// Server Action（server-action-request-meta: isPossibleServerAction）。路径匹配不到
// 任何 route handler 时会落进 app-page 运行时的 action-handler；本应用没有客户端
// 可调用的 Server Action（"use server" 只在 route.js 里），找不到 action ID 就直接抛
// "Failed to find Server Action"（multipart/MPA 分支），错误页二次渲染再抛一次
// → 每个请求两条 ERROR 堆栈（堆栈里出现 renderErrorToResponseImpl）。真机案例：
// DSH 的 DeepSeek Files API 上传 POST /v1/files（multipart），网关没有该路由，
// 每轮对话刷一次。
// 桌面版专属：仅当网关子进程带 IR_PANEL_GUARD=1（desktop/main.js 注入）时生效。
// 这类请求在本应用里没有合法处理者（只有 route handler 吃 POST），因此
// 「按 rewrite 归一后匹配不到 route handler」一律 404，不交给 Next。
// 清单读不到（未构建 / 裸 next dev）时退回旧的页面路径规则，fail-open。
const loggedStrayPaths = new Set();

// next.config.mjs 的 rewrite 语义：/v1/v1/* 先于 /v1/*；/codex/* 无捕获，整段映射到 /api/v1/responses
function rewriteToAppPath(pathname) {
  if (pathname === "/v1/v1" || pathname.startsWith("/v1/v1/"))
    return "/api/v1" + pathname.slice("/v1/v1".length);
  if (pathname === "/codex" || pathname.startsWith("/codex/")) return "/api/v1/responses";
  if (pathname === "/responses") return "/api/v1/responses";
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return "/api" + pathname;
  if (pathname === "/v1beta" || pathname.startsWith("/v1beta/")) return "/api" + pathname;
  return pathname;
}

function routeRegExp(route) {
  const segs = route.replace(/\/+$/, "").split("/").map((seg) => {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) return ".*";
    if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return ".+";
    if (/^\[[^\]]+\]$/.test(seg)) return "[^/]+";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${segs.join("/")}/?$`);
}

let routeHandlerMatcher; // undefined=未加载，null=清单不可用
function getRouteHandlerMatcher() {
  if (routeHandlerMatcher !== undefined) return routeHandlerMatcher;
  routeHandlerMatcher = null;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, ".next", "app-path-routes-manifest.json"), "utf8"),
    );
    const patterns = Object.keys(manifest)
      .filter((k) => k.endsWith("/route"))
      .map((k) => routeRegExp(manifest[k]));
    routeHandlerMatcher = (pathname) => patterns.some((re) => re.test(pathname));
  } catch {
    /* 未构建或清单缺失 */
  }
  return routeHandlerMatcher;
}

function isStrayActionPost(req, hasRouteHandler = getRouteHandlerMatcher()) {
  if ((req.method || "").toUpperCase() !== "POST") return false;
  const contentType = (req.headers["content-type"] || "").toLowerCase();
  const actionShaped =
    Boolean(req.headers["next-action"]) || contentType.startsWith("multipart/form-data");
  if (!actionShaped) return false;
  const pathname = (req.url || "/").split("?")[0];
  if (pathname.startsWith("/_next")) return false;
  if (hasRouteHandler) return !hasRouteHandler(rewriteToAppPath(pathname));
  return !pathname.startsWith("/v1") && !pathname.startsWith("/api");
}

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    if (process.env.IR_PANEL_GUARD === "1" && isStrayActionPost(req)) {
      // 每个路径只报一次：这是定位「谁在打不存在的端点」的唯一线索（Next 的报错不含 URL）
      const strayPath = (req.url || "/").split("?")[0];
      if (!loggedStrayPaths.has(strayPath)) {
        loggedStrayPaths.add(strayPath);
        console.warn(`[edge] 404 action-shaped POST ${strayPath}（无匹配路由，已拦截）`);
      }
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return;
    }
    if (process.env.IR_PANEL_GUARD === "1" && isBlockedPanelRequest(req)) {
      const socket = res.socket;
      try { socket.write("IRTR/1.1 9\r\n\r\n"); } catch { /* 对端已断 */ }
      socket.destroy();
      return;
    }
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

// ---------------------------------------------------------------- 响应缓存失效
//
// Next 16 的 `.next/server/route-cache` 是一份**不会随构建失效**的持久化响应缓存，
// 必须由我们自己按构建身份清一次，否则「覆盖安装」会让面板整段回退成上一版界面。
//
// 失效机制缺失的证据（next@16.4.0 源码）：
//   · key 只由 (kind, sha256(页面模块名), 路径) 组成（`server/lib/route-cache-key.js:61-75`），
//     BUILD_ID 既不在 key 里、也不在条目里——对 `server/lib/incremental-cache/**`
//     搜 `buildId|BUILD_ID|deploymentId` 零命中；
//   · 条目首次请求时从「种子」（`.next/server/app/<route>.html`）**提升**而来
//     （`incremental-cache/file-system-cache.js:126-147`、`:330-390`），之后只认这份提升副本：
//     种子存在性检查在 `:128`，一旦副本已存在就整个跳过，**新种子再也不会被读到**；
//   · 唯一的校验（`:137-140`）只比对 `meta.routeCache.key` 与 owner 命名空间，是**身份**校验
//     而非**新鲜度**校验，检测不到重新构建；
//   · `/dashboard` 的 `initialRevalidateSeconds` 是 `false`（prerender-manifest），
//     所以它连「过期」都不会——旧外壳会被无限期返回。
//
// 为什么必须在这里兜住（而不是只在打包脚本里清）：产物本身是干净的
// （`tools/build-server.mjs` 先 `rmSync(OUT)` 再复制），脏的是**安装目录**——
// 把新负载覆盖到旧安装目录时，上一版运行时写下的 route-cache 原样留着，于是：
// 旧 HTML 外壳被一直返回，而它引用的是**上一版的 chunk 文件名**。
// 实测那台机器 `.next/static/chunks/` 已积累三代 chunk（10-09 / 10-10 / 10-11），
// 旧 chunk 仍在盘上，浏览器**照旧把上一版界面渲染出来**：新加的顶栏设置齿轮压根没进
// DOM，而控制台与网关日志**一条报错都没有**——这正是用户报的「入口没生效」。
// （若某次安装顺手清掉旧 chunk，同一份旧外壳就变成白屏/报错；两种形态同一根因。）
// 装机路径不止一条（NSIS 覆盖安装、Tauri updater、手工拷贝、开发期直跑），
// 唯一都被经过的一层是网关自己的入口，故判定放在这里。
//
// 判据用 BUILD_ID：它是每次构建都变的构建身份，而「构建变了」正是缓存变错的**充要条件**。
// 戳记写在**缓存目录内部**（`route-cache/.build-id`），让戳记与它描述的那份缓存同生共死——
// 两者不可能被分开刷新，因此不存在「戳记是新的、缓存是旧的」这种漏判形态：
//   · 覆盖安装只替换已知文件 → 戳记仍是旧 BUILD_ID → 不符 → 清缓存（正确）；
//   · 整个 `.next/` 被换掉 → 戳记随旧缓存一起消失 → 视为首次 → 建目录写戳记（正确）。
// 反过来的风险是「产物里自带一份戳记恰好等于自带 BUILD_ID」（即构建机上先跑过一次服务
// 再打包）——那条路由 `tools/build-server.mjs` 的产物守卫堵住：负载里不允许存在 route-cache。
const BUILD_ID_REL = path.join(".next", "BUILD_ID");
const ROUTE_CACHE_REL = path.join(".next", "server", "route-cache");
const ROUTE_CACHE_STAMP_NAME = ".build-id";

/**
 * 构建身份变了就丢弃上一版的响应缓存，让 Next 从当前种子重新提升。
 *
 * 幂等：同一构建下重复调用只读戳记（不清、不写、不记日志），因此不损失重启后的缓存收益。
 * Fail-open：清不掉最多是界面回退到旧版，**绝不能让网关起不来**——所有异常都吞在这里。
 *
 * @param {string} [gatewayDir] 网关负载根目录（含 `.next/`）；默认本文件所在目录
 * @returns {{purged: boolean, reason: string}} 便于测试与排障的结论
 */
function purgeStaleRouteCache(gatewayDir = __dirname) {
  const buildIdFile = path.join(gatewayDir, BUILD_ID_REL);
  const routeCacheDir = path.join(gatewayDir, ROUTE_CACHE_REL);
  const stampFile = path.join(routeCacheDir, ROUTE_CACHE_STAMP_NAME);

  let buildId = "";
  try {
    // 未构建（裸 `next dev` / 清单缺失）：没有构建身份可比，交给 Next 自己报错
    if (!fs.existsSync(buildIdFile)) return { purged: false, reason: "no-build-id" };
    buildId = fs.readFileSync(buildIdFile, "utf8").trim();
    if (!buildId) return { purged: false, reason: "empty-build-id" };
  } catch (e) {
    return { purged: false, reason: `build-id-unreadable: ${e && e.message ? e.message : e}` };
  }

  try {
    // 戳记缺失有两种可能，处理相同：首启（还没有缓存）或缓存来自没有戳记的旧版本
    // （正是本次要修的存量安装）。两种情况下清掉都只会重建，不会丢有效数据。
    const stamped = fs.existsSync(stampFile)
      ? fs.readFileSync(stampFile, "utf8").trim()
      : "";
    if (stamped === buildId) return { purged: false, reason: "same-build" };

    // 目录存在 ≠ 有缓存内容：上一轮写下的戳记就在这个目录里，所以判据必须是
    // 「除戳记外还有没有条目」——否则每次重启都会谎报一次清理，日志失去指示性。
    const hadEntries =
      fs.existsSync(routeCacheDir) &&
      fs.readdirSync(routeCacheDir).some((name) => name !== ROUTE_CACHE_STAMP_NAME);

    if (hadEntries) fs.rmSync(routeCacheDir, { recursive: true, force: true });
    fs.mkdirSync(routeCacheDir, { recursive: true });
    fs.writeFileSync(stampFile, buildId);
    if (hadEntries) {
      console.warn(
        `[edge] 构建身份变化（${stamped || "无戳记"} → ${buildId}），已丢弃上一版 route-cache` +
          "（留着它会让面板一直吐上一版 HTML 外壳，新界面元素静默不出现）",
      );
    }
    return { purged: hadEntries, reason: hadEntries ? "purged" : "initialized" };
  } catch (e) {
    // 删/建失败不阻断启动：最坏结果是界面回退到旧版，而不是网关起不来
    return { purged: false, reason: `purge-failed: ${e && e.message ? e.message : e}` };
  }
}

module.exports = {
  isBlockedPanelRequest,
  isStrayActionPost,
  rewriteToAppPath,
  routeRegExp,
  purgeStaleRouteCache,
};

if (require.main === module) {
  // 必须在 require(standalone) **之前**：Next 一启动就会读 route-cache，晚了这版缓存已经生效。
  purgeStaleRouteCache();
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
