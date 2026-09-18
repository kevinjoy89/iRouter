import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDER_MODELS, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor, OPENCODE_FINGERPRINT_TOOLS } from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "muse-spark-1.2-contributor-free";
const PROVIDER = "opencode";

const input = [{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Think, then answer: 2 + 2?" }],
}];

describe("OpenCode Free Muse Spark thinking", () => {
  it("advertises reasoning and the requested model limits", () => {
    expect(PROVIDER_MODELS.oc?.some((model) => model.id === MODEL)).toBe(true);
    expect(PROVIDER_MODELS.oc?.some((model) => model.id === "muse-spark-1.3-contributor-free")).toBe(true);
    for (const m of [MODEL, "muse-spark-1.3-contributor-free", "muse-spark-1.4-contributor-free", "muse-spark-2.0-contributor-free"]) {
      expect(getCapabilitiesForModel(PROVIDER, m)).toMatchObject({
        reasoning: true,
        thinkingFormat: "openai",
        contextWindow: 1048576,
        maxOutput: 131072,
      });
      expect(getCapabilitiesForModel(PROVIDER, `oc/${m}`)).toMatchObject({
        reasoning: true,
        contextWindow: 1048576,
        maxOutput: 131072,
      });
      expect(getThinkingLevels(PROVIDER, m)).toEqual([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(getModelTargetFormat("oc", m)).toBe(FORMATS.OPENAI_RESPONSES);
      expect(getModelTargetFormat("opencode", m)).toBe(FORMATS.OPENAI_RESPONSES);
      expect(getModelTargetFormat("openrouter", m)).toBeNull();
    }
  });

  it("clamps max to xhigh and emits the Responses reasoning shape", () => {
    const body = {
      input,
      reasoning: { effort: "max" },
      max_tokens: 131072,
    };

    const out = new OpenCodeExecutor().transformRequest(MODEL, body, true, {
      connectionId: "opencode-muse-spark-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("leaves the other free models on Chat Completions", () => {
    const executor = new OpenCodeExecutor();
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 1024 };
    executor.transformRequest("big-pickle", body, true, {});
    expect(executor.buildUrl("big-pickle")).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(body.max_tokens).toBe(1024);
    expect(body.max_output_tokens).toBeUndefined();
  });

  it("translates Chat Completions max thinking into a Responses request", () => {
    const body = {
      model: `oc/${MODEL}`,
      messages: [{ role: "user", content: "Think, then answer: 2 + 2?" }],
      reasoning_effort: "max",
      max_tokens: 131072,
    };

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      MODEL,
      body,
      true,
      {},
      PROVIDER,
    );
    const out = new OpenCodeExecutor().transformRequest(MODEL, translated, true, {
      connectionId: "opencode-muse-spark-translation-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("routes muse-spark-1.3-contributor-free and future Muse Spark models to Responses API", () => {
    const executor = new OpenCodeExecutor();
    const futureModel = "muse-spark-1.4-contributor-free";

    for (const m of ["muse-spark-1.3-contributor-free", futureModel]) {
      expect(executor.buildUrl(m)).toBe("https://opencode.ai/zen/v1/responses");
      expect(executor.buildUrl(`${m}(high)`)).toBe("https://opencode.ai/zen/v1/responses");
      expect(getModelTargetFormat("oc", m)).toBe("openai-responses");

      const body = {
        model: `oc/${m}`,
        messages: [{ role: "user", content: "Hello" }],
        reasoning_effort: "high",
        max_tokens: 2048,
      };

      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        m,
        body,
        true,
        {},
        PROVIDER,
      );
      const out = executor.transformRequest(m, translated, true, {
        connectionId: "opencode-muse-spark-13-test",
      });

      expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
      expect(out.max_output_tokens).toBe(2048);
      expect(out.max_tokens).toBeUndefined();
    }
  });

  it("forces stream: true on outgoing requests", () => {
    const executor = new OpenCodeExecutor();
    const chatBody = { messages: [{ role: "user", content: "hi" }], stream: false };
    executor.transformRequest("big-pickle", chatBody, false, {});
    expect(chatBody.stream).toBe(true);

    const responsesBody = { input, stream: false };
    executor.transformRequest(MODEL, responsesBody, false, {});
    expect(responsesBody.stream).toBe(true);
  });

  it("injects agent fingerprint tools on chat and responses requests", () => {
    const executor = new OpenCodeExecutor();

    const chatBody = { messages: [{ role: "user", content: "hi" }] };
    executor.transformRequest("big-pickle", chatBody, true, {});
    expect(Array.isArray(chatBody.tools)).toBe(true);
    const chatToolNames = chatBody.tools.map((t) => t.function?.name || t.name);
    for (const expected of OPENCODE_FINGERPRINT_TOOLS) {
      expect(chatToolNames).toContain(expected);
    }

    const responsesBody = { input };
    executor.transformRequest(MODEL, responsesBody, true, {});
    expect(Array.isArray(responsesBody.tools)).toBe(true);
    const respToolNames = responsesBody.tools.map((t) => t.name);
    for (const expected of OPENCODE_FINGERPRINT_TOOLS) {
      expect(respToolNames).toContain(expected);
    }
    expect(responsesBody.tools.every((t) => t.type === "function" && t.parameters?.type === "object")).toBe(true);
  });

  it("preserves caller tools alongside the injected fingerprints", () => {
    const executor = new OpenCodeExecutor();
    const chatBody = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: {
          name: "my_custom_tool",
          description: "custom",
          parameters: { type: "object", properties: { a: { type: "string" } } },
        },
      }],
    };
    executor.transformRequest("big-pickle", chatBody, true, {});
    const chatToolNames = chatBody.tools.map((t) => t.function?.name || t.name);
    expect(chatToolNames).toContain("my_custom_tool");
    for (const expected of OPENCODE_FINGERPRINT_TOOLS) {
      expect(chatToolNames).toContain(expected);
    }
  });

  it("forces store: false and scrubs previous reasoning tokens on Responses", () => {
    const executor = new OpenCodeExecutor();
    const responsesBody = {
      input: [
        { type: "reasoning", encrypted_content: "stale-ciphertext", reasoning_encrypted_content: "stale" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next question" }] },
      ],
      store: true,
    };
    executor.transformRequest(MODEL, responsesBody, true, {});
    expect(responsesBody.store).toBe(false);
    expect(responsesBody.input.some((item) => item.type === "reasoning")).toBe(false);
    expect(responsesBody.input[0].encrypted_content).toBeUndefined();
    expect(responsesBody.input[0].reasoning_encrypted_content).toBeUndefined();
  });
});
