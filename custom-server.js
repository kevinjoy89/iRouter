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

function isBlockedPanelRequest(req) {
  // 桌面窗口识别：Electron UA 天然携带（零依赖，不依赖 webRequest 注入）；
  // 也接受显式客户端头。浏览器无法天然携带两者之一，即被连接级拒绝。
  const ua = req.headers["user-agent"] || "";
  const hasClient =
    req.headers[PANEL_CLIENT_HEADER] === PANEL_CLIENT_VALUE || ua.includes("Electron/");
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

module.exports = { isBlockedPanelRequest, isStrayActionPost, rewriteToAppPath, routeRegExp };

if (require.main === module) {
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
