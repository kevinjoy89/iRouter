import { describe, expect, it } from "vitest";
import {
  getDeclaredLevels,
  clampLevel,
  resolveRequestedEffort,
  applyEffortToBody,
  nextLowerLevel,
  isInvalidEffortError,
} from "../../open-sse/services/effortCaps.js";

const SETTINGS = {
  effortCaps: {
    "providerA/deepseek-v4-flash": ["low", "medium", "high", "xhigh"],
    "providerB/deepseek-v4-flash": ["low", "medium", "high"],
    "providerC/deepseek-v4-flash": ["high"],
  },
};

describe("getDeclaredLevels", () => {
  it("returns the declared set for provider/model", () => {
    expect(getDeclaredLevels(SETTINGS, "providerA/deepseek-v4-flash")).toEqual(["low", "medium", "high", "xhigh"]);
  });
  it("returns null when undeclared or no caps configured", () => {
    expect(getDeclaredLevels(SETTINGS, "providerD/deepseek-v4-flash")).toBeNull();
    expect(getDeclaredLevels({}, "providerA/deepseek-v4-flash")).toBeNull();
  });
  it("strips the thinking suffix before lookup", () => {
    expect(getDeclaredLevels(SETTINGS, "providerA/deepseek-v4-flash(max)")).toEqual(["low", "medium", "high", "xhigh"]);
  });
});

describe("clampLevel", () => {
  it("passes supported levels through unchanged", () => {
    expect(clampLevel("high", ["low", "medium", "high", "xhigh"])).toBe("high");
  });
  it("degrades max → xhigh / high when the set caps lower", () => {
    expect(clampLevel("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(clampLevel("max", ["low", "medium", "high"])).toBe("high");
  });
  it("upgrades to the set floor when the whole set is above the request", () => {
    expect(clampLevel("low", ["high"])).toBe("high");
  });
  it("leaves non-ladder values (none/auto) untouched", () => {
    expect(clampLevel("none", ["low", "medium", "high"])).toBe("none");
    expect(clampLevel("auto", ["low", "medium", "high"])).toBe("auto");
  });
  it("skips gaps in the set (max over [low,high] lands on high)", () => {
    expect(clampLevel("max", ["low", "high"])).toBe("high");
  });
});

describe("resolveRequestedEffort", () => {
  it("reads reasoning_effort from the body", () => {
    expect(resolveRequestedEffort({ reasoning_effort: "max" })).toEqual({ level: "max", viaSuffix: false, shape: "reasoning_effort" });
  });
  it("reads output_config.effort (claude shape)", () => {
    expect(resolveRequestedEffort({ output_config: { effort: "high" } })).toEqual({ level: "high", viaSuffix: false, shape: "output_config" });
  });
  it("reads reasoning.effort (responses shape)", () => {
    expect(resolveRequestedEffort({ reasoning: { effort: "xhigh" } })).toEqual({ level: "xhigh", viaSuffix: false, shape: "reasoning" });
  });
  it("model suffix wins over the body (matches applyThinking override precedence)", () => {
    expect(resolveRequestedEffort({ reasoning_effort: "high" }, "providerA/deepseek-v4-flash(max)")).toEqual({ level: "max", viaSuffix: true, shape: null });
  });
  it("returns null when there is no level intent", () => {
    expect(resolveRequestedEffort({ reasoning_effort: "none" })).toBeNull();
    expect(resolveRequestedEffort({})).toBeNull();
  });
});

describe("applyEffortToBody", () => {
  it("rewrites reasoning_effort", () => {
    const body = { reasoning_effort: "max" };
    applyEffortToBody(body, "reasoning_effort", "xhigh");
    expect(body.reasoning_effort).toBe("xhigh");
  });
  it("rewrites output_config.effort and keeps sibling keys", () => {
    const body = { output_config: { effort: "max", summary: "auto" } };
    applyEffortToBody(body, "output_config", "high");
    expect(body.output_config).toEqual({ effort: "high", summary: "auto" });
  });
  it("rewrites nested gemini thinkingConfig and keeps siblings", () => {
    const body = { generationConfig: { thinkingConfig: { thinkingLevel: "high" }, maxOutputTokens: 8192 } };
    applyEffortToBody(body, "thinkingConfig-gen", "medium");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("medium");
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
  });
});

describe("nextLowerLevel", () => {
  it("steps one rung down the ladder without a declared set", () => {
    expect(nextLowerLevel("max", null)).toBe("xhigh");
    expect(nextLowerLevel("high", null)).toBe("medium");
  });
  it("jumps to the next declared level below (skips gaps)", () => {
    expect(nextLowerLevel("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(nextLowerLevel("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(nextLowerLevel("max", ["low", "high"])).toBe("high");
  });
  it("stops at the declared floor / ladder bottom", () => {
    expect(nextLowerLevel("low", ["low", "medium", "high"])).toBeNull();
    expect(nextLowerLevel("minimal", null)).toBeNull();
  });
});

describe("isInvalidEffortError", () => {
  it("matches the real provider rejection message", () => {
    expect(isInvalidEffortError(400, "fieldReasoningEffort invalid, should be one of: low,medium, high, xhigh")).toBe(true);
  });
  it("matches status 422 variants too", () => {
    expect(isInvalidEffortError(422, "reasoning_effort is not supported by this model")).toBe(true);
  });
  it("rejects unrelated errors and statuses", () => {
    expect(isInvalidEffortError(400, "context length exceeded")).toBe(false);
    expect(isInvalidEffortError(429, "rate limit")).toBe(false);
    expect(isInvalidEffortError(500, "reasoning_effort boom")).toBe(false);
  });
});