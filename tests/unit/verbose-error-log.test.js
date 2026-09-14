// 完整异常日志开关（settings.verboseErrorLog）的运行时约束：
// 默认关 → errorDetail 不输出；开启后输出 REQ（发给 LLM 的请求体）与 RES（LLM 返回原文）
// 两条；请求体与错误响应体不截断，仅流式累积设上限；上游原始报文由 parseUpstreamError 带出。
import { afterEach, describe, expect, it, vi } from "vitest";

const log = await import("../../src/sse/utils/logger.js");
const { DEFAULT_SETTINGS } = await import("../../src/lib/db/repos/settingsRepo.js");
const { parseUpstreamError } = await import("../../open-sse/utils/error.js");
const { logVerboseExchange, createUpstreamCapture } = await import("../../open-sse/utils/verboseLog.js");
const { VERBOSE_STREAM_CAPTURE_MAX_BYTES } = await import("../../open-sse/config/runtimeConfig.js");

// 打印内容的取证：把 console.log 的实参拼成一行文本
const printed = (spy) => spy.mock.calls.map((c) => c.join(" ")).join("\n");

afterEach(() => {
  log.setVerboseErrors(false);
  vi.restoreAllMocks();
});

describe("完整异常日志开关", () => {
  it("默认关闭", () => {
    expect(DEFAULT_SETTINGS.verboseErrorLog).toBe(false);
  });

  it("关时不打印、开时打印；errorLine 不受开关影响", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    log.errorDetail("T", "✗", "hidden");
    expect(spy).not.toHaveBeenCalled();

    log.errorLine("T", "✗", "always");
    expect(spy).toHaveBeenCalledTimes(1);

    log.setVerboseErrors(true);
    log.errorDetail("T", "✗", "shown");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toContain("shown");
  });

  it("parseUpstreamError 带出上游原始报文", async () => {
    const body = JSON.stringify({
      error: { message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Content Exists Risk" },
    });
    const { statusCode, message, rawBody } = await parseUpstreamError(new Response(body, { status: 400 }));

    expect(statusCode).toBe(400);
    expect(message).toContain("Content Exists Risk");
    expect(rawBody).toBe(body);
  });

  // 主场景（内容审核 400）：上游错误报文 + 发出去的完整 prompt 都要能看到
  it("上游非 2xx：打印完整请求体与上游原始错误报文", async () => {
    log.setVerboseErrors(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const raw = JSON.stringify({
      error: { message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Content Exists Risk" },
    });
    const { statusCode, message, rawBody } = await parseUpstreamError(new Response(raw, { status: 400 }));
    const requestBody = { model: "hd/deepseek-v4.1-flash", messages: [{ role: "user", content: "要发的完整提示词" }] };

    logVerboseExchange(log, "T", {
      stage: "UPSTREAM", status: statusCode, provider: "hd", model: "deepseek-v4.1-flash",
      url: "https://api.example/v1/chat/completions",
      requestBody, responseText: rawBody,
    });

    const out = printed(spy);
    expect(out).toContain("REQ · UPSTREAM · hd/deepseek-v4.1-flash · https://api.example/v1/chat/completions · status=400");
    expect(out).toContain("要发的完整提示词");
    expect(out).toContain("Content Exists Risk");
    expect(message).toContain("Content Exists Risk");
  });

  it("关时 REQ/RES 都不打印（且不做序列化）", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let touched = false;
    const requestBody = { get messages() { touched = true; return []; } };

    logVerboseExchange(log, "T", { stage: "UPSTREAM", requestBody, responseText: "upstream body" });

    expect(spy).not.toHaveBeenCalled();
    expect(touched).toBe(false); // 关时不碰 body，避免大 body 的白白序列化
  });

  it("开时打印完整请求体与响应体（不截断）", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.setVerboseErrors(true);

    // 远超旧的 4KB 上限，且含换行/中文，用于证明「完整打印」与可读格式化
    const big = "x".repeat(5000);
    logVerboseExchange(log, "T", {
      stage: "UPSTREAM", status: 400, provider: "hd", model: "deepseek-v4.1-flash", url: "https://up.example/v1",
      requestBody: { model: "m", messages: [{ role: "user", content: big }] },
      responseText: '{"error":{"message":"Content Exists Risk"}}',
    });

    const out = printed(spy);
    expect(spy).toHaveBeenCalledTimes(2); // REQ + RES
    expect(out).toContain("REQ · UPSTREAM · hd/deepseek-v4.1-flash");
    expect(out).toContain("status=400");
    expect(out).toContain(big); // 请求体不截断
    expect(out).toContain("RES · UPSTREAM");
    expect(out).toContain("Content Exists Risk");
    expect(out).not.toContain("[truncated");
    // JSON 格式化（换行 + 缩进）便于人读原文
    expect(out).toContain('\n  "messages"');
  });

  it("流式累积：关时不收集，开时按上限截断并只取出一次", () => {
    expect(createUpstreamCapture(log, {})).toBeNull(); // 默认关 → 零分配

    log.setVerboseErrors(true);
    const cap = createUpstreamCapture(log, { provider: "p", model: "m", reqTag: "T", requestBody: { model: "m" } });
    cap.push(new TextEncoder().encode("data: {\"a\":1}\n\n"));
    cap.push("data: [DONE]\n\n");
    expect(cap.take()).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(cap.take()).toBeNull(); // 取出即释放，重复异常出口不会重复打印

    const big = createUpstreamCapture(log, {});
    big.push("y".repeat(VERBOSE_STREAM_CAPTURE_MAX_BYTES + 100));
    const clipped = big.take();
    expect(clipped).toContain(`[truncated at ${VERBOSE_STREAM_CAPTURE_MAX_BYTES}B]`);
    expect(clipped.length).toBeLessThan(VERBOSE_STREAM_CAPTURE_MAX_BYTES + 100);
  });

  it("dump 打印请求体与已累积原文，且只打一次", () => {
    log.setVerboseErrors(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const cap = createUpstreamCapture(log, { provider: "p", model: "m", reqTag: "T", requestBody: { model: "m" } });

    cap.push('data: {"partial":true}\n\n');
    cap.dump({ status: "chunks=1 bytes=25" });
    expect(printed(spy)).toContain('data: {"partial":true}');
    expect(printed(spy)).toContain("REQ · STREAM · p/m");

    const before = spy.mock.calls.length;
    cap.dump({ status: "again" });
    expect(spy.mock.calls.length).toBe(before); // 不重复刷屏
  });

  // 端到端：流式中途失败（stall/网络重置）也要能看到「发出去什么、收到什么」。
  // 用真实的 pipeWithDisconnect + 上游流报错，验证 dump 挂在异常出口上。
  it("流式中途失败时打印请求体与已收到的原始 SSE", async () => {
    const { pipeWithDisconnect } = await import("../../open-sse/utils/streamHandler.js");

    log.setVerboseErrors(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    // pull 驱动：先让一个 chunk 真正流过 tap，再报错（模拟中途断连）
    let pulls = 0;
    const upstream = new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
        else controller.error(new Error("socket hang up"));
      },
    });
    const controller = {
      signal: undefined,
      startTime: Date.now(),
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    };
    const transform = new TransformStream({ transform(c, enq) { enq.enqueue(c); } });

    const out = pipeWithDisconnect(new Response(upstream), transform, controller, null, 60_000, {
      provider: "hd", model: "deepseek-v4.1-flash", reqTag: "T", requestBody: { model: "m", messages: [{ role: "user", content: "hello" }] }, log,
    });
    for await (const _ of out) { /* 消费到流结束 */ }

    expect(controller.handleError).toHaveBeenCalled();
    const text = printed(spy);
    expect(text).toContain("REQ · STREAM · hd/deepseek-v4.1-flash");
    expect(text).toContain("hello"); // 发出去的请求体
    expect(text).toContain('data: {"delta":"hi"}'); // 已收到的原始 SSE
  });

  // 回归：verbose 开关开着时，SSE→JSON 路径的上游错误信息必须照常透出。
  // 曾因新增的 logVerboseExchange 引用 finalBody，撞上同函数更下方的
  // `const finalBody`（TDZ）而抛 ReferenceError，被 catch 吞成
  // "Failed to convert streaming response to JSON"——错误信息整体丢失。
  it("开启时 SSE→JSON 仍透出上游错误原文（不被 TDZ/catch 吞掉）", async () => {
    const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

    log.setVerboseErrors(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const raw = [
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
      'data: {"error":{"message":"Kiro stream ended incompletely","code":"kiro_missing_terminal"}}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    const result = await handleForcedSSEToJson({
      providerResponse: new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(raw));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: "openai",
      provider: "kiro",
      model: "kr/claude-opus-4.8",
      body: { model: "kr/claude-opus-4.8", messages: [{ role: "user", content: "hi" }] },
      translatedBody: { model: "kr/claude-opus-4.8", messages: [{ role: "user", content: "hi" }] },
      finalBody: null,
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "c1",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      reqTag: "T",
      log,
    });

    const json = await result.response.json();
    expect(json.error.message).toContain("Kiro stream ended incompletely");
    // 同时完整异常日志要打出请求体与上游原始 SSE
    const text = printed(spy);
    expect(text).toContain("REQ · UPSTREAM-SSE · kiro/kr/claude-opus-4.8");
    expect(text).toContain('"content": "hi"');
    expect(text).toContain("kiro_missing_terminal");
  });
});
