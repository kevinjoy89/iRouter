import { proxy as dashboardProxy } from "./dashboardGuard";

// 面板访问守卫（自维护特性）：只允许 iRouter 桌面窗口加载 HTML 页面，浏览器
// 直连一律 403。CLI 工具（Claude Code 等）走 /v1|/api，非 text/html 请求不受
// 影响；/callback 是 OAuth 系统浏览器回跳路径，必须放行。
const PANEL_CLIENT_HEADER = "x-irouter-client";
const PANEL_CLIENT_VALUE = "irouter-app";

export default async function proxy(request) {
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/html")) {
    const isOauthCallback = request.headers.get("sec-fetch-site") === "cross-site" ||
      new URL(request.url).pathname.startsWith("/callback");
    if (!isOauthCallback && request.headers.get(PANEL_CLIENT_HEADER) !== PANEL_CLIENT_VALUE) {
      return new Response(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee"><div style="text-align:center"><h1 style="color:#f97316;margin:0 0 12px">iRouter</h1><p style="margin:0 0 6px">请通过 iRouter 应用访问。</p><p style="color:#888;margin:0">Open this panel from the iRouter app.</p></div></body></html>',
        { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
  }
  return dashboardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};