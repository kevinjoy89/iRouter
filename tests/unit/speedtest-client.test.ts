import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSpeedtest, abortSpeedtest, isTauriEnvironment } from "@/features/speedtest/client";
import { resolveUpstreamModel, resolveFullModel } from "@/features/speedtest/modelUtils";

/**
 * 前端测速客户端抽象模块单元测试
 *
 * @author iRouter
 * @since 2026-10-16
 */
describe("speedtest client (TypeScript)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("在普通 Node/浏览器无 __TAURI_INTERNALS__ 环境下判定非桌面端", () => {
    expect(isTauriEnvironment()).toBe(false);
  });

  it("Web 降级模式下正确发起 fetch 并流式消费 SSE 事件", async () => {
    const encoder = new TextEncoder();
    const mockEvents = [
      `data: ${JSON.stringify({ sessionId: "s1", step: "streaming", currentSpeed: 45.5, currentTokenCount: 10 })}\n\n`,
      `data: ${JSON.stringify({
        sessionId: "s1",
        step: "completed",
        currentSpeed: 50.0,
        result: {
          sessionId: "s1",
          model: "gpt-4o",
          success: true,
          ttftMs: 200,
          totalDurationMs: 1000,
          generationDurationMs: 800,
          steadySpeed: 50.0,
          avgSpeed: 40.0,
          outputTokens: 40,
          tokensEstimated: false,
          chunkMetrics: { p50Ms: 10, p95Ms: 20, p99Ms: 30, jitterRatio: 2.0 },
          curvePoints: [],
        },
      })}\n\n`,
    ];

    let readIndex = 0;
    const mockStream = new ReadableStream({
      pull(controller) {
        if (readIndex < mockEvents.length) {
          controller.enqueue(encoder.encode(mockEvents[readIndex++]));
        } else {
          controller.close();
        }
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockStream,
    });

    const progressSteps: string[] = [];
    const result = await runSpeedtest(
      {
        sessionId: "s1",
        targetUrl: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o",
        prompt: "Hello",
      },
      (p) => {
        progressSteps.push(p.step);
      }
    );

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.model).toBe("gpt-4o");
    expect(result.steadySpeed).toBe(50.0);
    expect(progressSteps).toContain("streaming");
    expect(progressSteps).toContain("completed");
  });

  it("支持通过 abortSpeedtest 发送取消中断信号", async () => {
    const aborted = await abortSpeedtest("non-existent-session");
    expect(aborted).toBe(false);
  });

  it("正确剥离上游直连模型路由前缀，避免上游 404 拒绝服务", () => {
    // 典型场景：用户选择了带 hd/ 前缀的模型，直连时应纯净剥离为 deepseek-v4-flash
    expect(resolveUpstreamModel("hd/deepseek-v4-flash", "hd")).toBe("deepseek-v4-flash");
    expect(resolveUpstreamModel("HD/deepseek-v4-flash", "hd")).toBe("deepseek-v4-flash");
    // 未带前缀时直接保留
    expect(resolveUpstreamModel("deepseek-v4-flash", "hd")).toBe("deepseek-v4-flash");
    // 兼容使用 providerId 作为前缀的情况
    expect(resolveUpstreamModel("custom-node/deepseek-v4-flash", undefined, "custom-node")).toBe("deepseek-v4-flash");
    // 嵌套/包含斜杠的第三方模型（如 openrouter/openai/gpt-4o）
    expect(resolveUpstreamModel("or/openai/gpt-4o", "or")).toBe("openai/gpt-4o");
  });

  it("正确构造带统一前缀的全局路由模型标识用于展示和网关转发", () => {
    expect(resolveFullModel("deepseek-v4-flash", "hd")).toBe("hd/deepseek-v4-flash");
    expect(resolveFullModel("hd/deepseek-v4-flash", "hd")).toBe("hd/deepseek-v4-flash");
    expect(resolveFullModel("gpt-4o", "")).toBe("gpt-4o");
    expect(resolveFullModel("gpt-4o", undefined)).toBe("gpt-4o");
  });
});

