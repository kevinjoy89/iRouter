import { describe, expect, it } from "vitest";
import { handleComboChat, reorderByEffortCap } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

const EFFORT_CAPS = {
  "providerA/deepseek-v4-flash": ["low", "medium", "high", "xhigh", "max"],
  "providerB/deepseek-v4-flash": ["low", "medium", "high", "xhigh"],
  "providerC/deepseek-v4-flash": ["low", "medium", "high"],
};

const INVALID_EFFORT_MSG = "fieldReasoningEffort invalid, should be one of: low,medium, high, xhigh";
const errResponse = (status, message) => new Response(JSON.stringify({ error: { message } }), { status });

describe("reorderByEffortCap", () => {
  it("floats members that natively support the requested level and sinks capped ones (stable)", () => {
    const models = ["providerB/deepseek-v4-flash", "providerA/deepseek-v4-flash", "providerC/deepseek-v4-flash"];
    expect(reorderByEffortCap(models, EFFORT_CAPS, "max")).toEqual([
      "providerA/deepseek-v4-flash",
      "providerB/deepseek-v4-flash",
      "providerC/deepseek-v4-flash",
    ]);
  });

  it("sinks only members whose cap is below the requested level", () => {
    const models = ["providerC/deepseek-v4-flash", "providerB/deepseek-v4-flash", "providerA/deepseek-v4-flash"];
    expect(reorderByEffortCap(models, EFFORT_CAPS, "xhigh")).toEqual([
      "providerB/deepseek-v4-flash",
      "providerA/deepseek-v4-flash",
      "providerC/deepseek-v4-flash",
    ]);
  });

  it("keeps order when every member supports the level", () => {
    const models = ["providerC/deepseek-v4-flash", "providerA/deepseek-v4-flash", "providerB/deepseek-v4-flash"];
    expect(reorderByEffortCap(models, EFFORT_CAPS, "high")).toEqual(models);
  });

  it("treats undeclared members as capable (no reorder)", () => {
    const models = ["providerX/deepseek-v4-flash", "providerC/deepseek-v4-flash"];
    expect(reorderByEffortCap(models, EFFORT_CAPS, "max")).toEqual(models);
  });
});

describe("handleComboChat — effort-aware routing", () => {
  it("routes straight to the max-capable member when effort-aware is on", async () => {
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push({ model: modelStr, effort: body.reasoning_effort });
      return new Response("ok", { status: 200 });
    };
    const res = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
      models: ["providerB/deepseek-v4-flash", "providerA/deepseek-v4-flash"],
      handleSingleModel,
      log,
      comboName: "my-combo",
      effortCaps: EFFORT_CAPS,
      effortAwareRoute: true,
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ model: "providerA/deepseek-v4-flash", effort: "max" }]);
  });

  it("keeps original order when effort-aware is off", async () => {
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push({ model: modelStr, effort: body.reasoning_effort });
      return new Response("ok", { status: 200 });
    };
    const res = await handleComboChat({
      body: { model: "my-combo", messages: [], reasoning_effort: "max" },
      models: ["providerB/deepseek-v4-flash", "providerA/deepseek-v4-flash"],
      handleSingleModel,
      log,
      comboName: "my-combo",
      effortCaps: EFFORT_CAPS,
      effortAwareRoute: false,
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ model: "providerB/deepseek-v4-flash", effort: "max" }]);
  });
});

describe("handleComboChat — reactive degrade retry", () => {
  it("degrades max → xhigh on the same member when it rejects max", async () => {
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push({ model: modelStr, effort: body.reasoning_effort });
      if (body.reasoning_effort === "max") {
        return errResponse(400, INVALID_EFFORT_MSG);
      }
      return new Response("ok", { status: 200 });
    };
    const res = await handleComboChat({
      body: { model: "my-combo", messages: [], reasoning_effort: "max" },
      models: ["providerB/deepseek-v4-flash"],
      handleSingleModel,
      log,
      comboName: "my-combo",
      effortCaps: EFFORT_CAPS,
      effortAwareRoute: false,
    });
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.effort)).toEqual(["max", "xhigh"]);
  });

  it("steps down through the declared set only (skips undeclared gaps)", async () => {
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push({ model: modelStr, effort: body.reasoning_effort });
      if (body.reasoning_effort !== "medium") {
        return errResponse(400, INVALID_EFFORT_MSG);
      }
      return new Response("ok", { status: 200 });
    };
    const res = await handleComboChat({
      body: { model: "my-combo", messages: [], reasoning_effort: "max" },
      models: ["providerC/deepseek-v4-flash"],
      handleSingleModel,
      log,
      comboName: "my-combo",
      effortCaps: EFFORT_CAPS,
      effortAwareRoute: false,
    });
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.effort)).toEqual(["max", "high", "medium"]);
  });

  it("falls to the next member with the ORIGINAL effort after exhausting degrade steps", async () => {
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push({ model: modelStr, effort: body.reasoning_effort });
      if (modelStr.startsWith("providerC")) {
        return errResponse(400, INVALID_EFFORT_MSG);
      }
      return new Response("ok", { status: 200 });
    };
    const res = await handleComboChat({
      body: { model: "my-combo", messages: [], reasoning_effort: "max" },
      models: ["providerC/deepseek-v4-flash", "providerB/deepseek-v4-flash"],
      handleSingleModel,
      log,
      comboName: "my-combo",
      effortCaps: EFFORT_CAPS,
      effortAwareRoute: false,
    });
    expect(res.ok).toBe(true);
    const memberCCalls = calls.filter((c) => c.model.startsWith("providerC"));
    expect(memberCCalls.map((c) => c.effort)).toEqual(["max", "high", "medium", "low"]);
    expect(calls.find((c) => c.model.startsWith("providerB"))).toEqual({
      model: "providerB/deepseek-v4-flash",
      effort: "max",
    });
  });

  it("does not degrade-retry unrelated 400 errors (surfaces them like before)", async () => {
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push({ model: modelStr, effort: body.reasoning_effort });
      return errResponse(400, "context length exceeded");
    };
    const res = await handleComboChat({
      body: { model: "my-combo", messages: [], reasoning_effort: "max" },
      models: ["providerB/deepseek-v4-flash", "providerA/deepseek-v4-flash"],
      handleSingleModel,
      log,
      comboName: "my-combo",
      effortCaps: EFFORT_CAPS,
      effortAwareRoute: false,
    });
    // 无 effort-aware 排序时按原序尝试两个成员，各一次（无降级重试）
    expect(calls.map((c) => c.effort)).toEqual(["max", "max"]);
    expect(res.status).toBe(400);
  });
});