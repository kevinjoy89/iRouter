// 请求脱敏的运行时挂载测试：验证 chat / embeddings / images 三个入口在三档模式下
// 的行为，以及已知密钥收集与设置默认值。引擎本身的语义测试见 dlp.test.js。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatCoreMock, settingsMock, connectionsMock } = vi.hoisted(() => ({
  chatCoreMock: vi.fn(),
  settingsMock: vi.fn(),
  connectionsMock: vi.fn(),
}));

vi.mock("../../open-sse/handlers/chatCore.js", () => ({
  handleChatCore: chatCoreMock,
}));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: connectionsMock,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: settingsMock }));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({
    connectionId: "c1",
    connectionName: "a",
    accessToken: "t",
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
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));
vi.mock("@/lib/headroom/detect", () => ({
  DEFAULT_HEADROOM_URL: "http://localhost:8787",
}));
vi.mock("@/lib/pxpipe/loader.js", () => ({
  getTransform: vi.fn(async () => null),
}));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));

import { AI_TOKEN, OPAQUE_SECRET } from "./helpers/dlpTokens.js";
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const {
  invalidateKnownSecrets,
  collectKnownSecrets,
  logDlpOutcome,
  EXEMPT_START,
  EXEMPT_END,
} = await import("../../src/lib/dlp/index.js");
const { inspectRequestBody } = await import("../../open-sse/dlp/index.js");
const { DEFAULT_SETTINGS } = await import(
  "../../src/lib/db/repos/settingsRepo.js"
);

const TOKEN = AI_TOKEN; // 输入：真实形状的 token
const REDACTED = "[REDACTED:ai_tokens]"; // 输出：引擎写回的占位符

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

describe("请求脱敏：豁免标记同源", () => {
  // 面板向用户展示的那对标记，必须与 app 侧注入引擎的标记完全相同。
  // 不同源 = 用户照面板写标记、引擎却不认，防护形同虚设（静默失败）。
  const B = String.fromCharCode(91, 91),
    E = String.fromCharCode(93, 93);
  const secret = AI_TOKEN;

  beforeEach(() => {
    chatCoreMock.mockReset();
    settingsMock.mockReset();
    connectionsMock.mockReset();
    connectionsMock.mockResolvedValue([]);
    invalidateKnownSecrets();
  });

  it("注入的标记就是面板展示的那一对", () => {
    expect(EXEMPT_START).toBe(`${B}ALLOW_SENSITIVE${E}`);
    expect(EXEMPT_END).toBe(`${B}/ALLOW_SENSITIVE${E}`);
  });

  it("allowExemptions 开启：标记区间原样转发，标记本身被剥除", async () => {
    settingsMock.mockResolvedValue(
      settingsWith({ dlpMode: "redact", dlpAllowExemptions: true }),
    );
    chatCoreMock.mockResolvedValue({
      success: true,
      response: new Response("ok"),
    });
    const payload = {
      model: "openai/gpt-5",
      messages: [{ role: "user", content: EXEMPT_START + secret + EXEMPT_END }],
    };

    await handleChat(chatRequest(payload));

    const content = chatCoreMock.mock.calls[0][0].body.messages[0].content;
    expect(content).toBe(secret); // 豁免生效：明文原样，标记已剥除
  });

  it("allowExemptions 关闭：同一段内容照常脱敏", async () => {
    settingsMock.mockResolvedValue(
      settingsWith({ dlpMode: "redact", dlpAllowExemptions: false }),
    );
    chatCoreMock.mockResolvedValue({
      success: true,
      response: new Response("ok"),
    });
    const payload = {
      model: "openai/gpt-5",
      messages: [{ role: "user", content: EXEMPT_START + secret + EXEMPT_END }],
    };

    await handleChat(chatRequest(payload));

    const content = chatCoreMock.mock.calls[0][0].body.messages[0].content;
    expect(content).not.toContain(secret); // 标记不生效：真凭据被改写
    expect(content).toContain("[REDACTED:");
  });
});

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
    chatCoreMock.mockResolvedValue({
      success: true,
      response: new Response("ok"),
    });

    await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: TOKEN }],
      }),
    );

    expect(chatCoreMock.mock.calls[0][0].body.messages[0].content).toBe(TOKEN);
  });

  it("redact：转发给上游的 body 已脱敏", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "redact" }));
    chatCoreMock.mockResolvedValue({
      success: true,
      response: new Response("ok"),
    });

    await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: `key ${TOKEN}` }],
      }),
    );

    expect(chatCoreMock.mock.calls[0][0].body.messages[0].content).toBe(
      `key ${REDACTED}`,
    );
  });

  it("audit：只告警，转发内容不变", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "audit" }));
    chatCoreMock.mockResolvedValue({
      success: true,
      response: new Response("ok"),
    });

    await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: TOKEN }],
      }),
    );

    expect(chatCoreMock.mock.calls[0][0].body.messages[0].content).toBe(TOKEN);
  });

  it("block：返回 422 且不调用上游", async () => {
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "block" }));

    const res = await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: TOKEN }],
      }),
    );

    expect(res.status).toBe(422);
    const payload = await res.json();
    expect(payload.error.type).toBe("sensitive_data_blocked");
    expect(payload.error.rules).toContain("ai_tokens");
    expect(chatCoreMock).not.toHaveBeenCalled();
  });

  it("已知密钥命中：把本机凭据粘进 prompt 会被拦截", async () => {
    const secret = AI_TOKEN;
    connectionsMock.mockResolvedValue([
      { id: "c1", provider: "vendor", apiKey: secret },
    ]);
    settingsMock.mockResolvedValue(settingsWith({ dlpMode: "block" }));

    const res = await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: `here ${secret}` }],
      }),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error.rules).toContain("known_secret");
  });

  // 这条用例的凭据必须是「内置规则抓不到、只有已知密钥精确匹配能抓」的不透明串，
  // 否则命中的是规则路径，等于根本没在测 dlpKnownSecrets 开关。
  // OPAQUE_SECRET 的形状保证见 tests/unit/helpers/dlpTokens.js。
  it("dlpKnownSecrets=false 时不做已知密钥匹配", async () => {
    const secret = OPAQUE_SECRET;
    connectionsMock.mockResolvedValue([
      { id: "c1", provider: "vendor", apiKey: secret },
    ]);
    settingsMock.mockResolvedValue(
      settingsWith({ dlpMode: "block", dlpKnownSecrets: false }),
    );
    chatCoreMock.mockResolvedValue({
      success: true,
      response: new Response("ok"),
    });

    const res = await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: `here ${secret}` }],
      }),
    );

    expect(res.status).toBe(200);
  });

  // 正对照：同一份输入、同一份凭据，只把开关打开 → 必须拦截。
  // 没有这条，上面那条在「已知密钥功能整体失效」时也会通过。
  it("dlpKnownSecrets=true 时同一输入被拦截（正对照）", async () => {
    const secret = OPAQUE_SECRET;
    connectionsMock.mockResolvedValue([
      { id: "c1", provider: "vendor", apiKey: secret },
    ]);
    settingsMock.mockResolvedValue(
      settingsWith({ dlpMode: "block", dlpKnownSecrets: true }),
    );
    chatCoreMock.mockResolvedValue({
      success: true,
      response: new Response("ok"),
    });

    const res = await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: `here ${secret}` }],
      }),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error.rules).toContain("known_secret");
  });

  it("重试期间不会漏脱敏（脱敏后的 body 与重试共用）", async () => {
    settingsMock.mockResolvedValue(
      settingsWith({
        dlpMode: "redact",
        autoRetry: {
          enabled: true,
          intervalSeconds: 0.01,
          maxRetries: 2,
          backoff: false,
        },
      }),
    );
    let n = 0;
    chatCoreMock.mockImplementation(async () => {
      n++;
      return n === 1
        ? {
            success: false,
            status: 429,
            error: "rl",
            response: new Response("rl", { status: 429 }),
          }
        : { success: true, response: new Response("ok") };
    });

    await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: TOKEN }],
      }),
    );

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
      {
        id: "c1",
        apiKey: "abcdefgh",
        accessToken: "abcdefgh",
        refreshToken: "short",
      },
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
      { mode: "redact", rules: ["ai_tokens"] },
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
      { mode: "redact", rules: ["ai_tokens"] },
    );
    const { out, logger } = collect();
    logDlpOutcome(logger, "redact", r);
    expect(out[0][0]).toBe("warn");
    expect(out[0][2]).toMatch(/redacted rules=ai_tokens count=1/);
  });

  it("audit 命中但不改写 → matched(no-rewrite)，与 redact 区分开", () => {
    const r = inspectRequestBody(
      { input: TOKEN },
      { mode: "audit", rules: ["ai_tokens"] },
    );
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
    chatCoreMock.mockResolvedValue({
      success: true,
      response: new Response("ok"),
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleChat(
      chatRequest({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: "nothing secret here" }],
      }),
    );

    const dlpLines = spy.mock.calls
      .map((c) => c.join(" "))
      .filter((l) => l.includes("[DLP]"));
    spy.mockRestore();
    expect(dlpLines.length).toBeGreaterThan(0);
    expect(dlpLines.join("\n")).toMatch(/no match/);
  });
});
