/**
 * OAuth 回调收取端点（通用授权码流程）。
 *
 * 为什么这里不是页面：Next 不允许 route.js 与 page.js 共存于同一路由段，而
 * redirect_uri（`http://localhost:<port>/callback`）**必须逐字节保持不变**——它是各
 * 供应商已注册的重定向地址，改路径会被 provider 拒绝。所以由本 handler 取代原先的
 * `page.js`。
 *
 * 它做什么：把授权码在**服务端**换成令牌并落库，面板用既有的 poll 原语取结果。浏览器只
 * 被重定向一次，不再参与交付——这正是修掉「桌面版通用供应商只能手粘 URL」的关键：旧实现
 * 依赖 window.opener.postMessage / BroadcastChannel / localStorage 三通道，而桌面壳把跨域
 * 授权页交给系统浏览器后弹窗根本没被创建，且面板在 127.0.0.1 而 redirect 落在 localhost，
 * 三通道全部命中不了。
 *
 * 安全边界见 src/lib/oauth/utils/server.js 顶部那段注释；要点是：本端点**只读不建**会话
 * （会话只能经受鉴权的 register-session 创建）、state 精确命中且一次性消费、Origin 守卫、
 * code 永不回显进 HTML（除非走手粘兜底路径）。
 */
import { NextResponse } from "next/server";
import {
  completeLoopbackCallback,
  getOAuthSessionForCallback,
  isLoopbackOrigin,
  renderCodexResultPage,
  renderOAuthManualPage,
} from "@/lib/oauth/utils/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // URL 里可能带 code/state，别让它出现在任何 Referer 里
  "referrer-policy": "no-referrer",
};

function html(body, status = 200) {
  return new NextResponse(body, { status, headers: NO_STORE });
}

export async function GET(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // 合法重定向是顶层导航（无 Origin）；跨站页面的 fetch 一定带 Origin。
  // 与既有 localhost 代理守卫同构，见 server.js 的 isLoopbackOrigin。
  if (!isLoopbackOrigin(request.headers.get("origin"))) {
    return html(renderCodexResultPage(false, "Cross-origin callback rejected"), 403);
  }

  // 无 state：不是一次有效的回环回调（面板探针、用户手敲、或旧三通道流程的残留）。
  // 返回手粘兜底页而不是错误页——桌面壳的就绪探针会裸打 /callback 并要求 200。
  if (!state) {
    return html(
      renderOAuthManualPage({
        message:
          "This is the OAuth callback endpoint. If you were sent here by a login you started in the app, copy this URL and paste it into the app's manual input.",
        url: request.url,
      })
    );
  }

  // 只查不建：会话只能由受鉴权保护的 register-session 创建。
  const session = getOAuthSessionForCallback(state);
  if (!session) {
    return html(
      renderOAuthManualPage({
        message:
          "No active login session on this gateway. If you just approved access, copy this URL and paste it into the app's manual input.",
        url: request.url,
      })
    );
  }

  const result = await completeLoopbackCallback({ session, code, error, errorDescription });
  // 失败也返回 200：浏览器这一侧只需要一句人话，真正的失败态由面板轮询读到。
  return html(renderCodexResultPage(result.ok, result.message));
}

export async function POST() {
  return new NextResponse("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
}
