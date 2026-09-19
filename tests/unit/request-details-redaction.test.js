import { describe, it, expect } from "vitest";
import { redactDetails } from "@/app/api/usage/request-details/route.js";

describe("request-details redaction", () => {
  it("脱敏成功请求中的对话内容，但保留请求配置与消息角色结构", () => {
    const details = [{
      id: "abc",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      timestamp: "2026-08-05T00:00:00Z",
      status: "success",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: {
        model: "deepseek-v4-flash-free",
        stream: true,
        temperature: 0.7,
        messages: [{ role: "user", content: "secret prompt" }],
      },
      providerRequest: {
        model: "deepseek-v4-flash-free",
        messages: [{ role: "user", content: "secret prompt" }],
      },
      providerResponse: { choices: [{ message: { content: "secret answer" } }] },
      response: { content: "secret answer" },
    }];

    const out = redactDetails(details)[0];
    expect(out.id).toBe("abc");
    expect(out.provider).toBe("opencode");
    expect(out.model).toBe("deepseek-v4-flash-free");
    expect(out.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });

    // 请求配置与角色保留，正文被脱敏遮蔽
    expect(out.request.model).toBe("deepseek-v4-flash-free");
    expect(out.request.stream).toBe(true);
    expect(out.request.temperature).toBe(0.7);
    expect(out.request.messages[0].role).toBe("user");
    expect(out.request.messages[0].content).toBe("[REDACTED (13 chars)]");

    // 成功响应内容被安全脱敏
    expect(out.providerResponse).toEqual({ redacted: true });
    expect(out.response).toEqual({ redacted: true });
  });

  it("保留错误请求的关键排错上下文（HTTP 状态码、错误消息与提供商原始报错）", () => {
    const details = [{
      id: "err-1",
      provider: "sensenova",
      model: "kimi-k3",
      timestamp: "2026-09-19T11:58:36Z",
      status: "error",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      latency: { ttft: 0, total: 179 },
      request: {
        model: "kimi-k3",
        messages: [{ role: "user", content: "hello" }],
      },
      providerResponse: {
        error: {
          code: 400,
          message: "Model kimi-k3 is not supported on this endpoint",
        },
      },
      response: {
        status: 400,
        error: "Model kimi-k3 is not supported on this endpoint",
      },
    }];

    const out = redactDetails(details)[0];
    expect(out.id).toBe("err-1");
    expect(out.status).toBe("error");

    // 错误信息与上游报错报文必须完整保留以供排错
    expect(out.response.status).toBe(400);
    expect(out.response.error).toBe("Model kimi-k3 is not supported on this endpoint");
    expect(out.providerResponse).toEqual({
      error: {
        code: 400,
        message: "Model kimi-k3 is not supported on this endpoint",
      },
    });

    // 请求结构保留，正文脱敏
    expect(out.request.model).toBe("kimi-k3");
    expect(out.request.messages[0].role).toBe("user");
    expect(out.request.messages[0].content).toBe("[REDACTED (5 chars)]");
  });

  it("正确处理空详情列表", () => {
    expect(redactDetails([])).toEqual([]);
    expect(redactDetails(null)).toEqual([]);
    expect(redactDetails(undefined)).toEqual([]);
  });

  it("保持非敏感字段和多模态消息安全脱敏", () => {
    const details = [{
      id: "x",
      status: "error",
      latency: { total: 100 },
      request: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "describe this image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
          ],
        }],
      },
      response: { error: "Network timeout", status: 504 },
    }];

    const out = redactDetails(details)[0];
    expect(out.id).toBe("x");
    expect(out.status).toBe("error");
    expect(out.latency).toEqual({ total: 100 });
    expect(out.response.status).toBe(504);
    expect(out.response.error).toBe("Network timeout");

    // 多模态内容部分脱敏
    const parts = out.request.messages[0].content;
    expect(parts[0].text).toBe("[REDACTED (19 chars)]");
    expect(parts[1].source).toBe("[REDACTED_MEDIA]");
  });
});
