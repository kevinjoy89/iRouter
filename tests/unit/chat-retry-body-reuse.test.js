// 回归：请求级自动重试（ADR 0003）曾整体失效——`request.json()` 位于 withAutoRetry
// 闭包内，第 2 次尝试重读已消费的 Body 抛 `TypeError: Body is unusable`，
// handleChatOnce 捕获后返回 400 "Invalid JSON body"。
// 修复：解析提到重试之外，重试复用同一 body 对象。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatCoreMock, settingsMock } = vi.hoisted(() => ({
  chatCoreMock: vi.fn(),
  settingsMock: vi.fn(),
}));

vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore: chatCoreMock }));

vi.mock("@/lib/localDb", () => ({ getSettings: settingsMock }));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({
    connectionId: "conn-1",
    connectionName: "acct-1",
    accessToken: "tok",
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => "sk-test"),
  isValidApiKey: vi.fn(async () => true),
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "openai", model: "gpt-5" })),
  getComboModels: vi.fn(async () => null),
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => null),
  clearAntigravityStrikes: vi.fn(),
}));

vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => null) }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

// 默认设置：重试开启、间隔极短，让用例快速跑到第 2 次尝试
const BASE_SETTINGS = {
  autoRetry: { enabled: true, intervalSeconds: 0.01, maxRetries: 3, backoff: false },
  requireApiKey: false,
};

function makeRequest(payload) {
  return new Request("http://localhost:20128/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("chat request-level retry: body reuse across attempts", () => {
  beforeEach(() => {
    chatCoreMock.mockReset();
    settingsMock.mockReset();
    settingsMock.mockResolvedValue(BASE_SETTINGS);
  });

  it("retries instead of failing with 400 when the first attempt is retryable", async () => {
    const seenBodies = [];
    chatCoreMock.mockImplementation(async ({ body }) => {
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        // 真实 chatCore 的失败结果恒带 response（open-sse/utils/error.js createErrorResult）
        return { success: false, status: 429, error: "rate limited", response: new Response("rate limited", { status: 429 }) };
      }
      return { success: true, response: new Response("ok", { status: 200 }) };
    });

    const res = await handleChat(makeRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // 修复前：第 2 次尝试在 request.json() 抛错 → 400 且 chatCore 只被调用 1 次
    expect(chatCoreMock).toHaveBeenCalledTimes(2);
    expect(seenBodies[1]).toMatchObject({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] });
  });

  it("does not mutate the caller's raw request body between attempts", async () => {
    const payload = { model: "openai/gpt-5", messages: [{ role: "user", content: "keep me" }] };
    const snapshots = [];
    chatCoreMock.mockImplementation(async ({ body }) => {
      snapshots.push(JSON.stringify(body.messages));
      return snapshots.length === 1
        ? { success: false, status: 503, error: "overloaded", response: new Response("overloaded", { status: 503 }) }
        : { success: true, response: new Response("ok", { status: 200 }) };
    });

    await handleChat(makeRequest(payload));

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(payload.messages[0].content).toBe("keep me");
  });

  it("still returns the last error when retries are exhausted", async () => {
    chatCoreMock.mockResolvedValue({ success: false, status: 429, error: "rate limited", response: new Response("nope", { status: 429 }) });

    const res = await handleChat(makeRequest({ model: "openai/gpt-5", messages: [] }));

    expect(res.status).toBe(429);
    // maxRetries 3 → 首次 + 3 次重试
    expect(chatCoreMock).toHaveBeenCalledTimes(4);
  });

  it("rejects an invalid JSON body once, without entering the retry loop", async () => {
    const bad = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    const res = await handleChat(bad);

    expect(res.status).toBe(400);
    expect(chatCoreMock).not.toHaveBeenCalled();
  });

  it("runs a single attempt when auto-retry is disabled", async () => {
    settingsMock.mockResolvedValue({ autoRetry: { enabled: false }, requireApiKey: false });
    chatCoreMock.mockResolvedValue({ success: false, status: 429, error: "rate limited", response: new Response("nope", { status: 429 }) });

    const res = await handleChat(makeRequest({ model: "openai/gpt-5", messages: [] }));

    expect(res.status).toBe(429);
    expect(chatCoreMock).toHaveBeenCalledTimes(1);
  });
});
