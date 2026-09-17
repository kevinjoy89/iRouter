import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode.js";

/**
 * 构造模拟的凭证对象
 *
 * @param {Object} [overrides={}] 覆盖属性
 * @return {Object} 凭证对象
 */
function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_custom_sub2api",
    rawHeaders: {},
    apiKey: "sk-sub2api-test-key",
    providerSpecificData: {
      baseUrl: "https://sub2api.example.com/v1",
    },
    ...overrides,
  };
}

/**
 * 模拟 sub2api 的 resolveOpenCodeSessionID 提取规则
 *
 * @param {Object} headers 发送的请求头
 * @param {Object} body 发送的请求体
 * @return {string} 提取出的会话标识或空字符串
 */
function mockSub2apiResolveSession(headers = {}, body = {}) {
  // 1. 优先读取入站 Header
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "x-opencode-session" && v) return v;
  }
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if ((lower === "session_id" || lower === "x-session-id" || lower === "x-claude-code-session-id") && v) return v;
  }

  // 2. 检查请求体 prompt_cache_key 与 metadata.user_id
  if (body?.prompt_cache_key && typeof body.prompt_cache_key === "string") {
    return body.prompt_cache_key.trim();
  }
  if (body?.metadata?.user_id && typeof body.metadata.user_id === "string") {
    const uid = body.metadata.user_id.trim();
    if (uid.startsWith("{")) {
      try {
        const parsed = JSON.parse(uid);
        if (parsed?.session_id) return parsed.session_id.trim();
      } catch {
        // 忽略非标准 JSON 解析错误
      }
    }
    return uid;
  }

  // 3. 兜底回退标识（当全部缺失时 sub2api 会退回随机 uuid 导致脱靶）
  return "FALLBACK_UUID";
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("自定义 OpenAI 兼容提供商 (openai-compatible-*) 会话与缓存连续性", () => {
  const providerName = "openai-compatible-sub2api-1234";

  it("正确识别兼容提供商并挂载符合 OpenCode 规范的会话标识", () => {
    const executor = getExecutor(providerName);
    const sourceCreds = makeCredentials();

    const prepared = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hello" }] },
      credentials: sourceCreds,
      providerSessionId: "conversation-task-42",
      clientTool: "claude",
    });

    // 确保原始凭证对象未被污染
    expect(sourceCreds._compatibleSession).toBeUndefined();

    // 挂载的会话必须符合 OpenCode 官方规范 (ses_ + 12位十六进制 + 14位Base62)
    expect(prepared._compatibleSession).toBeDefined();
    expect(prepared._compatibleSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._compatibleSession).toHaveLength(30);
  });

  it("在 buildHeaders 中注入 x-opencode-session、x-session-id 与 session_id", () => {
    const executor = getExecutor(providerName);
    const credentials = executor.prepareRequestCredentials({
      credentials: makeCredentials(),
      providerSessionId: "session-alpha",
      clientTool: "cursor",
    });

    const headers = executor.buildHeaders(credentials, true);

    expect(headers["x-opencode-session"]).toBe(credentials._compatibleSession);
    expect(headers["x-session-id"]).toBe(credentials._compatibleSession);
    expect(headers["session_id"]).toBe(credentials._compatibleSession);
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
  });

  it("在 transformRequest 中向请求体注入 prompt_cache_key 形成双重保障", () => {
    const executor = getExecutor(providerName);
    const credentials = executor.prepareRequestCredentials({
      credentials: makeCredentials(),
      providerSessionId: "session-beta",
      clientTool: "generic",
    });

    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "ping" }],
    };

    const transformed = executor.transformRequest("gpt-4o", body, true, credentials);

    expect(transformed.prompt_cache_key).toBe(credentials._compatibleSession);
    expect(transformed.prompt_cache_key).toMatch(OPENCODE_SESSION_RE);
  });

  it("若下游已显式提供 prompt_cache_key 则予以保留不覆盖", () => {
    const executor = getExecutor(providerName);
    const credentials = executor.prepareRequestCredentials({
      credentials: makeCredentials(),
      providerSessionId: "session-gamma",
    });

    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "ping" }],
      prompt_cache_key: "custom-existing-cache-key",
    };

    const transformed = executor.transformRequest("gpt-4o", body, true, credentials);

    expect(transformed.prompt_cache_key).toBe("custom-existing-cache-key");
  });

  it("模拟 sub2api 提取流程：确保 sub2api 100% 提取出同一规范会话而不触发脱靶 UUID", () => {
    const executor = getExecutor(providerName);
    const credentials = executor.prepareRequestCredentials({
      credentials: makeCredentials(),
      providerSessionId: "conversation-sub2api-sync",
      clientTool: "claude",
    });

    const body = { messages: [{ role: "user", content: "prompt caching test" }] };
    const transformedBody = executor.transformRequest("deepseek-chat", body, true, credentials);
    const headers = executor.buildHeaders(credentials, true);

    // 场景 1：反向代理正常保留 Headers
    const resolvedNormal = mockSub2apiResolveSession(headers, transformedBody);
    expect(resolvedNormal).toBe(credentials._compatibleSession);
    expect(resolvedNormal).toMatch(OPENCODE_SESSION_RE);
    expect(resolvedNormal).not.toBe("FALLBACK_UUID");

    // 场景 2：反向代理剥离了全部自定义 Header，仅保留请求体
    const headersWithoutSession = { "content-type": "application/json", "authorization": headers["Authorization"] };
    const resolvedStrippedHeaders = mockSub2apiResolveSession(headersWithoutSession, transformedBody);
    expect(resolvedStrippedHeaders).toBe(credentials._compatibleSession);
    expect(resolvedStrippedHeaders).toMatch(OPENCODE_SESSION_RE);
    expect(resolvedStrippedHeaders).not.toBe("FALLBACK_UUID");
  });

  it("通过 execute 执行时 fetch 请求携带了正确的请求头和请求体会话键", async () => {
    const executor = getExecutor(providerName);
    const credentials = makeCredentials();

    await executor.execute({
      model: "deepseek-chat",
      body: { messages: [{ role: "user", content: "test call" }] },
      stream: true,
      credentials,
      providerSessionId: "chat-turn-1",
      clientTool: "claude",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchMock.mock.calls[0];

    expect(calledUrl).toBe("https://sub2api.example.com/v1/chat/completions");
    expect(calledOptions.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(calledOptions.headers["x-session-id"]).toMatch(OPENCODE_SESSION_RE);

    const parsedSentBody = JSON.parse(calledOptions.body);
    expect(parsedSentBody.prompt_cache_key).toBe(calledOptions.headers["x-opencode-session"]);
  });
});

describe("自定义 Anthropic 兼容提供商 (anthropic-compatible-*) 会话连续性", () => {
  const providerName = "anthropic-compatible-sub2api-5678";

  it("向 Claude 格式请求体注入 metadata.user_id 并注入会话头", () => {
    const executor = getExecutor(providerName);
    const credentials = executor.prepareRequestCredentials({
      credentials: makeCredentials(),
      providerSessionId: "anthropic-session-1",
      clientTool: "claude",
    });

    const body = {
      model: "claude-3-7-sonnet",
      messages: [{ role: "user", content: "hello claude" }],
    };

    const transformed = executor.transformRequest("claude-3-7-sonnet", body, true, credentials);
    const headers = executor.buildHeaders(credentials, true);

    expect(transformed.metadata?.user_id).toBe(credentials._compatibleSession);
    expect(transformed.metadata?.user_id).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session"]).toBe(credentials._compatibleSession);

    // sub2api 模拟校验
    const resolved = mockSub2apiResolveSession(headers, transformed);
    expect(resolved).toBe(credentials._compatibleSession);
    expect(resolved).not.toBe("FALLBACK_UUID");
  });
});

describe("OpenCode Go 执行器会话规范化与中转支持", () => {
  it("生成的 Session ID 符合 OpenCode 官方规范正则", () => {
    const executor = getExecutor("opencode-go");
    const credentials = executor.prepareRequestCredentials({
      credentials: makeCredentials(),
      providerSessionId: "raw-external-session-id",
      clientTool: "opencode-go",
    });

    const session = credentials._opencodeGoSession;
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(session).toHaveLength(30);
  });

  it("在 transformRequest 中向请求体注入 prompt_cache_key", () => {
    const executor = getExecutor("opencode-go");
    const credentials = executor.prepareRequestCredentials({
      credentials: makeCredentials(),
      providerSessionId: "spark-session-id",
    });

    const body = {
      model: "muse-spark-1.2-contributor-free",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "calc" }] }],
    };

    const transformed = executor.transformRequest("muse-spark-1.2-contributor-free", body, true, credentials);
    expect(transformed.prompt_cache_key).toBe(credentials._opencodeGoSession);
    expect(transformed.prompt_cache_key).toMatch(OPENCODE_SESSION_RE);
  });

  it("支持自定义 Base URL 中转 Responses 模型而不是强行硬编码至官方地址", () => {
    const executor = getExecutor("opencode-go");
    const credentialsWithCustomBase = makeCredentials({
      providerSpecificData: {
        baseUrl: "https://my-sub2api.com/zen/go/v1",
      },
    });

    const customUrl = executor.buildUrl("muse-spark-1.2-contributor-free", true, 0, credentialsWithCustomBase);
    expect(customUrl).toBe("https://my-sub2api.com/zen/go/v1/responses");

    // 默认未提供自定义地址时回退到官方地址
    const defaultUrl = executor.buildUrl("muse-spark-1.2-contributor-free", true, 0, makeCredentials({ providerSpecificData: {} }));
    expect(defaultUrl).toBe("https://opencode.ai/zen/go/v1/responses");
  });
});
