// Guards the refactored USAGE_HANDLERS dispatch: unsupported → message, supported → routed.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub network so handlers don't hit real APIs; each call resolves an empty 200.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "{}",
  })),
}));

const load = () => import("../../open-sse/services/usage.js");
const SUPPORTED = [
  "github", "gemini-cli", "antigravity", "claude", "codex", "kiro",
  "qoder", "qoder-cn", "iflow", "ollama", "glm", "glm-cn",
  "minimax", "minimax-cn", "vercel-ai-gateway", "grok-cli", "kimi",
  "deepseek", "opencode-go", "zed", "commandcode",
];

describe("usage dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unsupported provider → not-implemented message", async () => {
    const { getUsageForProvider } = await load();
    const res = await getUsageForProvider({ provider: "totally-unknown" });
    expect(res).toEqual({ message: "Usage API not implemented for totally-unknown" });
    // open-sse/services/usage.js 的模块图很大（隔离跑约 2.5s），全量并发下光 import
    // 就可能超过默认 5s 超时——曾因此在 CI 上报过一次假回归。
  }, 20000);

  it("every supported provider routes to its handler (no fallback message)", async () => {
    const { getUsageForProvider } = await load();
    for (const provider of SUPPORTED) {
      const res = await getUsageForProvider({ provider, accessToken: "t", apiKey: "k" });
      // Routed handler must return an object and never the unsupported fallback
      expect(res, `${provider} routed`).toBeTypeOf("object");
      expect(res?.message).not.toBe(`Usage API not implemented for ${provider}`);
    }
  }, 20000);
});
