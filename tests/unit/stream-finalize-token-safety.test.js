import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("流式生命周期与 Token 结算安全性测试", () => {
  const sampleBody = {
    model: "glm-5.3",
    messages: [{ role: "user", content: "请用中文写一篇关于宇宙起源的短文" }],
  };

  it("客户端在收到 [DONE] 后，onStreamComplete 稳定触发并完成 Token 估算", async () => {
    let completedUsage = null;
    let completedContent = null;
    let completedTtft = null;

    const onStreamComplete = vi.fn((contentObj, usage, ttftAt) => {
      completedContent = contentObj;
      completedUsage = usage;
      completedTtft = ttftAt;
    });

    const transformStream = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "heading",
      null,
      null,
      "glm-5.3",
      "conn-123",
      sampleBody,
      onStreamComplete
    );

    const encoder = new TextEncoder();
    const upstreamLines = [
      'data: {"choices":[{"delta":{"content":"宇宙起源于一场"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"大爆炸"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const upstreamStream = new ReadableStream({
      start(controller) {
        for (const line of upstreamLines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });

    const piped = upstreamStream.pipeThrough(transformStream);
    const reader = piped.getReader();

    // 客户端持续读取数据流直到结束
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    // 验证结算回调已被触发
    expect(onStreamComplete).toHaveBeenCalled();
    expect(completedContent?.content).toContain("宇宙起源于一场大爆炸");
    expect(completedUsage).not.toBeNull();
    // 即使上游未传 usage，也应成功兜底估算输入与输出 Token
    expect(completedUsage.prompt_tokens).toBeGreaterThan(0);
    expect(completedUsage.completion_tokens).toBeGreaterThan(0);
    expect(completedTtft).toBeGreaterThan(0);
  });

  it("当上游输出内容为空字符（totalContentLength === 0）时，输入 Token 依然保底估算，绝不归零", async () => {
    let completedUsage = null;

    const onStreamComplete = vi.fn((_, usage) => {
      completedUsage = usage;
    });

    const transformStream = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "heading",
      null,
      null,
      "glm-5.3",
      "conn-123",
      sampleBody,
      onStreamComplete
    );

    const encoder = new TextEncoder();
    const upstreamStream = new ReadableStream({
      start(controller) {
        // 直接发送 [DONE]，模拟上游没有产生任何输出内容即完成
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const piped = upstreamStream.pipeThrough(transformStream);
    const reader = piped.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(onStreamComplete).toHaveBeenCalled();
    expect(completedUsage).not.toBeNull();
    // 验证 Prompt Token 不为 0
    expect(completedUsage.prompt_tokens).toBeGreaterThan(0);
    expect(completedUsage.completion_tokens).toBe(0);
  });

  it("客户端在推流中途主动断开时，createDisconnectAwareStream 兜底触发 finalizeStream 结算", async () => {
    let completedUsage = null;
    let completedContent = null;

    const onStreamComplete = vi.fn((contentObj, usage) => {
      completedContent = contentObj;
      completedUsage = usage;
    });

    const transformStream = createPassthroughStreamWithLogger(
      "heading",
      null,
      "glm-5.3",
      "conn-123",
      sampleBody,
      onStreamComplete
    );

    const fakeStreamController = {
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
    };

    const encoder = new TextEncoder();
    const upstreamStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"已输出前半段文本"}}]}\n\n'));
      },
    });

    const piped = upstreamStream.pipeThrough(transformStream);
    const disconnectAwareStream = createDisconnectAwareStream(
      {
        readable: piped,
        writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
      },
      fakeStreamController,
      null,
      transformStream
    );

    const reader = disconnectAwareStream.getReader();
    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);

    // 用户中途取消请求（停止生成）
    await reader.cancel("user_aborted");

    // 验证控制器被通知断开
    expect(fakeStreamController.handleDisconnect).toHaveBeenCalled();
    // 验证中途产生的数据和 Token 依然被结算落盘
    expect(onStreamComplete).toHaveBeenCalled();
    expect(completedContent?.content).toContain("已输出前半段文本");
    expect(completedUsage?.prompt_tokens).toBeGreaterThan(0);
    expect(completedUsage?.completion_tokens).toBeGreaterThan(0);
  });

  it("针对 OpenAI 目标端点，流式请求自动注入 stream_options，非流式请求自动剔除", () => {
    // 1. 流式请求测试
    const streamRequest = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "glm-5.3",
      { ...sampleBody },
      true
    );
    expect(streamRequest.stream_options).toEqual({ include_usage: true });

    // 2. 非流式请求测试
    const nonStreamRequest = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "glm-5.3",
      { ...sampleBody, stream_options: { include_usage: true } },
      false
    );
    expect(nonStreamRequest.stream_options).toBeUndefined();
  });
});
