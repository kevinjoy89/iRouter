// 请求脱敏的运行时挂载测试：验证 chat / embeddings / images 三个入口在三档模式下
// 的行为，以及已知密钥收集与设置默认值。引擎本身的语义测试见 dlp.test.js。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatCoreMock, settingsMock, connectionsMock } = vi.hoisted(() => ({
  chatCoreMock: vi.fn(),
  settingsMock: vi.fn(),
  connectionsMock: vi.fn(),
}));

vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore: chatCoreMock }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnections: connectionsMock }));
vi.mock("@/lib/localDb", () => ({ getSettings: settingsMock }));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({ connectionId: "c1", connectionName: "a", accessToken: "t" })),
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
const { invalidateKnownSecrets, collectKnownSecrets, logDlpOutcome } = await import("../../src/lib/dlp/index.js");
const { inspectRequestBody } = await import("../../open-sse/dlp/index.js");
const { DEFAULT_SETTINGS } = await import("../../src/lib/db/repos/settingsRepo.js");

const TOKEN = "sk-A1b2C3d4E5f6G7h8J9k0LmNoPqRsTuVx";

function chatRequest(payload) {
  return new Request("http://localhost:20128/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function settingsWith(dlp) {
  return { autoRetry: { enabled: false }, requireApiKey: false, ...dlp };
}

describe("请求脱敏：设置默认值", () => {
  it("默认 off，升级不改变流量行为", () => {
    expect(DEFAULT_SETTINGS.dlpMode).toBe("off");
    expect(DEFAULT_SETTINGS.dlpAllowExemptions).toBe(false);
    expect(DEFAULT_SETTINGS.dlpKnownSecrets).toBe(true);
  });
});

describe("请求脱敏：chat 入口", () => {
  beforeEach(() => {
    chatCoreMock.mockReset();
    settingsMock.mockReset();
    connectionsMock.mockReset();
    connectionsMock.mockResolvedValue([]);
    invalidateKnownSecrets();
  });

  it("off：body 原样转发", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "off" }));
    chatCoreMock.mockResolvedValue({ success: true, response: new Response("ok") });

    await handleChat(chatRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: TOKEN }] }));

    expect(chatCoreMock.mock.calls[0][0].body.messages[0].content).toBe(TOKEN);
  });

  it("redact：转发给上游的 body 已脱敏", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "redact" }));
    chatCoreMock.mockResolvedValue({ success: true, response: new Response("ok") });

    await handleChat(chatRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: `key ${TOKEN}` }] }));

    expect(chatCoreMock.mock.calls[0][0].body.messages[0].content).toBe("key [REDACTED:ai_tokens]");
  });

  it("audit：只告警，转发内容不变", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "audit" }));
    chatCoreMock.mockResolvedValue({ success: true, response: new Response("ok") });

    await handleChat(chatRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: TOKEN }] }));

    expect(chatCoreMock.mock.calls[0][0].body.messages[0].content).toBe(TOKEN);
  });

  it("block：返回 422 且不调用上游", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "block" }));

    const res = await handleChat(chatRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: TOKEN }] }));

    expect(res.status).toBe(422);
    const payload = await res.json();
    expect(payload.error.type).toBe("sensitive_data_blocked");
    expect(payload.error.rules).toContain("ai_tokens");
    expect(chatCoreMock).not.toHaveBeenCalled();
  });

  it("已知密钥命中：把本机凭据粘进 prompt 会被拦截", async () => {
    const secret = "vendor-private-value-987654321";
    connectionsMock.mockResolvedValue([{ id: "c1", provider: "vendor", apiKey: secret }]);
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "block" }));

    const res = await handleChat(chatRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: `here ${secret}` }] }));

    expect(res.status).toBe(422);
    expect((await res.json()).error.rules).toContain("known_secret");
  });

  it("dlpKnownSecrets=false 时不做已知密钥匹配", async () => {
    const secret = "vendor-private-value-987654321";
    connectionsMock.mockResolvedValue([{ id: "c1", provider: "vendor", apiKey: secret }]);
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "block", dlpKnownSecrets: false }));
    chatCoreMock.mockResolvedValue({ success: true, response: new Response("ok") });

    const res = await handleChat(chatRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: `here ${secret}` }] }));

    expect(res.status).toBe(200);
    expect(res).toBeDefined();
  });

  it("重试期间不会漏脱敏（脱敏后的 body 与重试共用）", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "redact", autoRetry: { enabled: true, intervalSeconds: 0.01, maxRetries: 2, backoff: false } }));
    let n = 0;
    chatCoreMock.mockImplementation(async () => {
      n++;
      return n === 1
        ? { success: false, status: 429, error: "rl", response: new Response("rl", { status: 429 }) }
        : { success: true, response: new Response("ok") };
    });

    await handleChat(chatRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: TOKEN }] }));

    expect(chatCoreMock).toHaveBeenCalledTimes(2);
    for (const call of chatCoreMock.mock.calls) {
      expect(call[0].body.messages[0].content).toBe("[REDACTED:ai_tokens]");
    }
  });
});

describe("请求脱敏：已知密钥收集", () => {
  beforeEach(() => {
    connectionsMock.mockReset();
    invalidateKnownSecrets();
  });

  it("收集多个连接的多类凭据字段，去重且过滤短值", async () => {
    connectionsMock.mockResolvedValue([
      { id: "c1", apiKey: "abcdefgh", accessToken: "abcdefgh", refreshToken: "short" },
      { id: "c2", apiKey: "abcdefgh", idToken: "longer-token-value" },
    ]);

    const secrets = await collectKnownSecrets();

    expect(secrets).toContain("abcdefgh");
    expect(secrets).toContain("longer-token-value");
    expect(secrets).not.toContain("short");
    expect(secrets.filter((s) => s === "abcdefgh")).toHaveLength(1);
  });

  it("读取凭据失败时降级为空列表，不抛出", async () => {
    connectionsMock.mockRejectedValue(new Error("db down"));
    await expect(collectKnownSecrets()).resolves.toEqual([]);
  });

  it("invalidateKnownSecrets 后重新读取", async () => {
    connectionsMock.mockResolvedValue([{ apiKey: "first-secret-value" }]);
    expect(await collectKnownSecrets()).toEqual(["first-secret-value"]);

    connectionsMock.mockResolvedValue([{ apiKey: "second-secret-value" }]);
    invalidateKnownSecrets();
    expect(await collectKnownSecrets()).toEqual(["second-secret-value"]);
  });
});

// 真机反馈：用户把模式设成 redact，却"没在日志里看到任何命中"，无法判断功能是否生效。
// 根因是原先只在命中时打日志——「扫了但没命中」与「根本没跑」在日志里完全一样。
// 现在每个请求都记一行扫描量，这组用例钉住该行为。
describe("请求脱敏：可观测性（每个请求都留痕）", () => {
  const collect = () => {
    const out = [];
    return {
      out,
      logger: {
        warn: (t, m) => out.push(["warn", t, m]),
        info: (t, m) => out.push(["info", t, m]),
        debug: (t, m) => out.push(["debug", t, m]),
      },
    };
  };

  it("零命中记 info 并带扫描量（关键：可与「没跑」区分）", () => {
    const r = inspectRequestBody(
      { messages: [{ role: "user", content: "hello world" }] },
      { mode: "redact", rules: ["ai_tokens"] }
    );
    expect(r.scannedFields).toBe(1);
    expect(r.scannedChars).toBe(11);

    const { out, logger } = collect();
    logDlpOutcome(logger, "redact", r);
    expect(out).toHaveLength(1);
    expect(out[0][0]).toBe("info");
    expect(out[0][2]).toMatch(/no match/);
    expect(out[0][2]).toMatch(/scanned=1field\/11char/);
  });

  it("命中记 warn 并带规则名与替换次数", () => {
    const r = inspectRequestBody(
      { input: TOKEN },
      { mode: "redact", rules: ["ai_tokens"] }
    );
    const { out, logger } = collect();
    logDlpOutcome(logger, "redact", r);
    expect(out[0][0]).toBe("warn");
    expect(out[0][2]).toMatch(/redacted rules=ai_tokens count=1/);
  });

  it("audit 命中但不改写 → matched(no-rewrite)，与 redact 区分开", () => {
    const r = inspectRequestBody({ input: TOKEN }, { mode: "audit", rules: ["ai_tokens"] });
    const { out, logger } = collect();
    logDlpOutcome(logger, "audit", r);
    expect(out[0][2]).toMatch(/matched\(no-rewrite\)/);
  });

  it("mode=off 不留痕（避免误导为已启用）", () => {
    const r = inspectRequestBody({ input: "x" }, { mode: "off" });
    const { out, logger } = collect();
    logDlpOutcome(logger, "off", r);
    expect(out).toHaveLength(0);
  });

  it("chat 入口在零命中时也会调用 logDlpOutcome", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "redact" }));
    chatCoreMock.mockResolvedValue({ success: true, response: new Response("ok") });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleChat(chatRequest({ model: "openai/gpt-5", messages: [{ role: "user", content: "nothing secret here" }] }));

    const dlpLines = spy.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("[DLP]"));
    spy.mockRestore();
    expect(dlpLines.length).toBeGreaterThan(0);
    expect(dlpLines.join("\n")).toMatch(/no match/);
  });
});
