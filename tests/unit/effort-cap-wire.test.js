import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

// 线上值钳制回归（自维护特性 ADR 0003）：声明上限必须约束翻译产出的最终档位，
// 而非仅客户端输入意图——各格式映射非单调（deepseek 把 xhigh 升为 max），
// 客户端意图还可能是 budget 形状（Claude Code 的 thinking.budget_tokens）。
// 真实案例：sensenova/deepseek-v4-flash 声明 [low..xhigh]，Claude Code budget
// 意图被映射成 reasoning_effort:"max"，上游 400 "field ReasoningEffort invalid,
// should be one of: low, medium, high, xhigh, none"。

const CAP_XHIGH = ["low", "medium", "high", "xhigh"];

// 自定义 openai 兼容供应商 + deepseek-v4-flash → pattern 表给出 thinkingFormat:"deepseek"
function deepseekWire(body, effortCap) {
  return applyThinking("openai", "deepseek-v4-flash", body, "custom-openai", undefined, effortCap);
}

describe("applyThinking — declared effort cap clamps the WIRE level", () => {
  it("deepseek format: reasoning_effort max → xhigh (was escalated to max)", () => {
    const out = deepseekWire({ reasoning_effort: "max" }, CAP_XHIGH);
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("deepseek format: Claude-Code-style thinking budget → xhigh (the real-world bug)", () => {
    const out = deepseekWire({ thinking: { type: "enabled", budget_tokens: 128000 } }, CAP_XHIGH);
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("deepseek format: budget intent without a declared cap keeps legacy max passthrough", () => {
    const out = deepseekWire({ thinking: { type: "enabled", budget_tokens: 128000 } }, null);
    expect(out.reasoning_effort).toBe("max");
  });

  it("deepseek format: high within the cap passes through", () => {
    const out = deepseekWire({ reasoning_effort: "high" }, CAP_XHIGH);
    expect(out.reasoning_effort).toBe("high");
  });

  it("model suffix level override is clamped too", () => {
    const out = applyThinking("openai", "deepseek-v4-flash(max)", {}, "custom-openai", undefined, CAP_XHIGH);
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("openai format: max over a low cap degrades to the cap", () => {
    const out = applyThinking("openai", "gpt-5", { reasoning_effort: "max" }, "openai", undefined, ["low", "medium"]);
    expect(out.reasoning_effort).toBe("medium");
  });

  it("kimi format: xhigh maps up to max then clamps back to the cap", () => {
    const out = applyThinking("openai", "kimi-k2.7", { reasoning_effort: "xhigh" }, "kimi", undefined, ["low", "high"]);
    expect(out.reasoning_effort).toBe("high");
  });

  it("zai format: GLM max mapping clamps to the cap", () => {
    const out = applyThinking("openai", "glm-5.3", { reasoning_effort: "max" }, "glm-cn", undefined, ["low", "high"]);
    expect(out.reasoning_effort).toBe("high");
  });

  it("no cap behaves exactly as before (deepseek max passthrough)", () => {
    const out = deepseekWire({ reasoning_effort: "max" }, null);
    expect(out.reasoning_effort).toBe("max");
  });
});