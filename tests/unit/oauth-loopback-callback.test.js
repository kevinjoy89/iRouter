/**
 * 通用供应商 OAuth 回环：/callback 在服务端换取 + 面板轮询。
 *
 * 钉住的契约（对应 ADR-0007 的 OAuth 一节）：
 *   - 只有经 register-session 登记过的 state 才会被换取；/callback 只读不建会话
 *   - state 精确命中且一次性消费（重放不得二次换取）
 *   - 非 loopback Origin 一律拒绝（跨站页面 fetch 到 127.0.0.1 的登录 CSRF）
 *   - 失败信息必须被 HTML 转义（provider 的报错可能内嵌响应体）
 *   - 轮询返回值里永远没有 codeVerifier / meta
 *   - 裸 GET /callback 仍返回 200 HTML（桌面壳的就绪探针依赖它）且保留手粘兜底
 *
 * 注意：这里**不 mock** `@/lib/oauth/utils/server`——要测的就是它。它的重依赖
 * （providers / models）在函数内部惰性 import，故在下方按模块 mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => {
  class MockNextResponse {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.headers = new Headers(init.headers || {});
    }
    async text() {
      return String(this.body);
    }
    async json() {
      return JSON.parse(this.body);
    }
  }
  MockNextResponse.json = (body, init) =>
    new MockNextResponse(JSON.stringify(body), init);
  return { NextResponse: MockNextResponse };
});

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(async () => ({
    accessToken: "sk-access",
    refreshToken: "rt-1",
    expiresIn: 3600,
  })),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async (d) => ({
    id: "conn-1",
    email: "user@example.com",
    ...d,
  })),
}));

vi.mock("open-sse/shared/mimoAccount.js", () => ({
  readDesktopPassToken: vi.fn(async () => null),
}));

vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));

const { exchangeTokens } = await import("@/lib/oauth/providers");
const { createProviderConnection } = await import("@/models");
const {
  registerOAuthSession,
  getOAuthSession,
  getOAuthSessionForCallback,
  sweepOAuthSessions,
} = await import("../../src/lib/oauth/utils/server.js");

const { GET: callbackGET, POST: callbackPOST } = await import(
  "../../src/app/callback/route.js"
);
const { GET: oauthGET, POST: oauthPOST } = await import(
  "../../src/app/api/oauth/[provider]/[action]/route.js"
);

const REDIRECT_URI = "http://localhost:20128/callback";

const callbackReq = (query = "", headers = {}) =>
  new Request(`http://localhost:20128/callback${query}`, { headers });

const registerViaApi = (provider, payload) =>
  oauthPOST(
    new Request(`http://localhost/api/oauth/${provider}/register-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ provider, action: "register-session" }) },
  );

const poll = (provider, state) =>
  oauthGET(
    new Request(
      `http://localhost/api/oauth/${provider}/poll-status?state=${encodeURIComponent(state)}`
    ),
    { params: Promise.resolve({ provider, action: "poll-status" }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  // 每个用例从干净的注册表开始
  sweepOAuthSessions(Number.MAX_SAFE_INTEGER);
  exchangeTokens.mockResolvedValue({
    accessToken: "sk-access",
    refreshToken: "rt-1",
    expiresIn: 3600,
  });
});

describe("/callback 通用回环：换取与安全边界", () => {
  it("happy path：登记过的 state 被服务端换取并落库，且会话一次性消费", async () => {
    registerOAuthSession({
      provider: "claude",
      state: "S1",
      codeVerifier: "V1",
      redirectUri: REDIRECT_URI,
      meta: { clientId: "cid" },
    });

    const res = await callbackGET(callbackReq("?code=C1&state=S1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    expect(exchangeTokens).toHaveBeenCalledTimes(1);
    expect(exchangeTokens.mock.calls[0].slice(0, 5)).toEqual([
      "claude",
      "C1",
      REDIRECT_URI,
      "V1",
      "S1",
    ]);
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    expect(createProviderConnection.mock.calls[0][0].provider).toBe("claude");
    expect(createProviderConnection.mock.calls[0][0].authType).toBe("oauth");

    // 成功后不得把 code 回显进页面
    expect(await res.text()).not.toContain("C1");
  });

  it("state 不匹配：不换取，且原会话仍可继续", async () => {
    registerOAuthSession({
      provider: "claude",
      state: "S1",
      codeVerifier: "V1",
      redirectUri: REDIRECT_URI,
    });

    const res = await callbackGET(callbackReq("?code=C1&state=S2"));
    expect(res.status).toBe(200);
    expect(exchangeTokens).not.toHaveBeenCalled();
    expect(getOAuthSessionForCallback("S1").status).toBe("pending");
  });

  it("无会话时不换取、也不创建会话（/callback 只读不建）", async () => {
    const res = await callbackGET(callbackReq("?code=C1&state=NOPE"));
    expect(res.status).toBe(200);
    expect(exchangeTokens).not.toHaveBeenCalled();
    expect(getOAuthSessionForCallback("NOPE")).toBeNull();
    expect(await res.text()).toContain("Copy this URL");
  });

  it("缺少 state 时返回 200 手粘兜底页（桌面壳就绪探针裸打 /callback）", async () => {
    const res = await callbackGET(callbackReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Copy this URL");
  });

  it("重放：第二次提交同一 state 不再换取", async () => {
    registerOAuthSession({
      provider: "claude",
      state: "S1",
      codeVerifier: "V1",
      redirectUri: REDIRECT_URI,
    });

    await callbackGET(callbackReq("?code=C1&state=S1"));
    const second = await callbackGET(callbackReq("?code=C1&state=S1"));

    expect(exchangeTokens).toHaveBeenCalledTimes(1);
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(200);
    expect(await second.text()).not.toContain("C1");
  });

  it("provider 报错被转义，且错误态可从轮询读到", async () => {
    exchangeTokens.mockRejectedValueOnce(
      new Error('<script>alert(1)</script> Token exchange failed: code=secret123')
    );
    registerOAuthSession({
      provider: "claude",
      state: "S1",
      codeVerifier: "V1",
      redirectUri: REDIRECT_URI,
    });

    const res = await callbackGET(callbackReq("?code=C1&state=S1"));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
    // code= 回显被脱敏
    expect(body).not.toContain("secret123");

    const polled = await poll("claude", "S1");
    const data = await polled.json();
    expect(data.status).toBe("error");
    expect(data.error).toBeTruthy();
  });

  it("提供方返回 error 参数时记录错误而不换取", async () => {
    registerOAuthSession({
      provider: "claude",
      state: "S1",
      codeVerifier: "V1",
      redirectUri: REDIRECT_URI,
    });

    const res = await callbackGET(
      callbackReq("?error=access_denied&error_description=User+denied&state=S1")
    );
    expect(res.status).toBe(200);
    expect(exchangeTokens).not.toHaveBeenCalled();
    expect(getOAuthSessionForCallback("S1").status).toBe("error");
  });

  it("拒绝带非 loopback Origin 的跨站请求", async () => {
    registerOAuthSession({
      provider: "claude",
      state: "S1",
      codeVerifier: "V1",
      redirectUri: REDIRECT_URI,
    });

    const res = await callbackGET(
      callbackReq("?code=C1&state=S1", { origin: "https://evil.example" })
    );
    expect(res.status).toBe(403);
    expect(exchangeTokens).not.toHaveBeenCalled();
    expect(getOAuthSessionForCallback("S1").status).toBe("pending");
  });

  it("loopback Origin 与无 Origin（顶层导航）均放行", async () => {
    registerOAuthSession({
      provider: "claude",
      state: "S1",
      codeVerifier: "V1",
      redirectUri: REDIRECT_URI,
    });
    const ok = await callbackGET(
      callbackReq("?code=C1&state=S1", { origin: "http://127.0.0.1:20128" })
    );
    expect(ok.status).toBe(200);
    expect(exchangeTokens).toHaveBeenCalledTimes(1);
  });

  it("非 GET 方法返回 405", async () => {
    const res = await callbackPOST();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("TTL 过期后不再换取", async () => {
    registerOAuthSession({
      provider: "claude",
      state: "S1",
      codeVerifier: "V1",
      redirectUri: REDIRECT_URI,
    });
    // 超过 5 分钟 TTL
    sweepOAuthSessions(Date.now() + 6 * 60 * 1000);

    const res = await callbackGET(callbackReq("?code=C1&state=S1"));
    expect(res.status).toBe(200);
    expect(exchangeTokens).not.toHaveBeenCalled();
    expect(getOAuthSessionForCallback("S1")).toBeNull();
  });
});

describe("register-session → /callback → poll-status 端到端", () => {
  it("登记、换取、轮询到 done，且轮询结果不含 codeVerifier / meta", async () => {
    const reg = await registerViaApi("claude", {
      state: "E2E",
      codeVerifier: "VERIFIER-SECRET",
      redirectUri: REDIRECT_URI,
      meta: { clientId: "cid", clientSecret: "SECRET" },
    });
    expect(reg.status).toBe(200);
    expect((await reg.json()).success).toBe(true);

    const before = await (await poll("claude", "E2E")).json();
    expect(before.status).toBe("pending");
    expect(JSON.stringify(before)).not.toContain("VERIFIER-SECRET");

    await callbackGET(callbackReq("?code=C9&state=E2E"));

    const after = await (await poll("claude", "E2E")).json();
    expect(after.status).toBe("done");
    expect(after.connectionId).toBe("conn-1");
    // 安全：轮询体里绝不能出现 PKCE verifier 或 meta 里的密钥
    expect(JSON.stringify(after)).not.toContain("VERIFIER-SECRET");
    expect(JSON.stringify(after)).not.toContain("SECRET");
  });

  it("未知 state 仍返回 unknown（与既有代理路径语义一致）", async () => {
    const res = await poll("claude", "never-registered");
    expect(await res.json()).toEqual({ status: "unknown" });
  });

  it("缺 codeVerifier / redirectUri 时登记被拒（回落手粘路径的信号）", async () => {
    const res = await registerViaApi("claude", { state: "S-BAD" });
    expect(res.status).toBe(400);
    expect(getOAuthSession("S-BAD")).toBeNull();
  });

  it("会话登记后 getOAuthSession 只暴露安全字段", async () => {
    await registerViaApi("claude", {
      state: "SAFE",
      codeVerifier: "VERIFIER-SECRET",
      redirectUri: REDIRECT_URI,
      meta: { clientSecret: "SECRET" },
    });
    const safe = getOAuthSession("SAFE");
    expect(safe).toMatchObject({ provider: "claude", status: "pending" });
    expect(safe).not.toHaveProperty("codeVerifier");
    expect(safe).not.toHaveProperty("meta");
    expect(JSON.stringify(safe)).not.toContain("VERIFIER-SECRET");
  });
});
