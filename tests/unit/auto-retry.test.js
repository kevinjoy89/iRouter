import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_RETRY,
  resolveAutoRetry,
  isRetryable,
  isRetryableErrorText,
  computeWaitMs,
  parseRetryAfterHeader,
  sleepWithAbort,
  waitBeforeRetry,
  withAutoRetry,
} from "../../open-sse/services/autoRetry.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {} };
const errResponse = (status, message, headers = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers });

describe("resolveAutoRetry", () => {
  it("fills defaults for missing/partial settings", () => {
    expect(resolveAutoRetry({})).toEqual(DEFAULT_AUTO_RETRY);
    expect(resolveAutoRetry({ autoRetry: { maxRetries: 3 } })).toEqual({ ...DEFAULT_AUTO_RETRY, maxRetries: 3 });
  });
  it("repairs invalid values", () => {
    const cfg = resolveAutoRetry({ autoRetry: { maxRetries: -5, statusCodes: "x", intervalSeconds: 0, enabled: false } });
    expect(cfg.maxRetries).toBe(DEFAULT_AUTO_RETRY.maxRetries);
    expect(cfg.statusCodes).toEqual(DEFAULT_AUTO_RETRY.statusCodes);
    expect(cfg.intervalSeconds).toBe(DEFAULT_AUTO_RETRY.intervalSeconds);
    expect(cfg.enabled).toBe(false);
  });
});

describe("isRetryable", () => {
  const cfg = resolveAutoRetry({});
  it("matches whitelisted statuses", () => {
    expect(isRetryable(429, "", cfg)).toBe(true);
    expect(isRetryable(503, "", cfg)).toBe(true);
    expect(isRetryable(529, "", cfg)).toBe(true);
  });
  it("matches rate-limit text on non-whitelisted statuses", () => {
    expect(isRetryable(400, "inference exceeds tpm/rpm rate limit", cfg)).toBe(true);
    expect(isRetryable(502, "upstream overloaded", cfg)).toBe(true);
  });
  it("never retries 2xx/3xx or unrelated errors", () => {
    expect(isRetryable(200, "rate limit", cfg)).toBe(false);
    expect(isRetryable(404, "model not found", cfg)).toBe(false);
    expect(isRetryable(400, "invalid field", cfg)).toBe(false);
  });
  it("respects the enabled flag", () => {
    expect(isRetryable(429, "", { ...cfg, enabled: false })).toBe(false);
  });
});

describe("computeWaitMs", () => {
  const cfg = { intervalSeconds: 5, backoff: true, backoffMaxSeconds: 60, retryAfterMaxSeconds: 120 };
  it("progresses exponentially: 5s → 10s → 20s", () => {
    expect(computeWaitMs(cfg, 0, null, () => 0.5)).toBe(5000);
    expect(computeWaitMs(cfg, 1, null, () => 0.5)).toBe(10000);
    expect(computeWaitMs(cfg, 2, null, () => 0.5)).toBe(20000);
  });
  it("caps backoff at backoffMaxSeconds", () => {
    expect(computeWaitMs(cfg, 10, null, () => 0.5)).toBe(60000);
  });
  it("caps upstream Retry-After", () => {
    expect(computeWaitMs(cfg, 0, 300000, () => 0.5)).toBe(120000);
  });
  it("takes the max of Retry-After and backoff", () => {
    expect(computeWaitMs(cfg, 0, 7000, () => 0.5)).toBe(7000);
  });
  it("with backoff off, waits the fixed interval", () => {
    expect(computeWaitMs({ ...cfg, backoff: false }, 5, null, () => 0.5)).toBe(5000);
  });
  it("applies ±20% jitter at the bounds", () => {
    expect(computeWaitMs(cfg, 0, null, () => 0)).toBe(4000);
    expect(computeWaitMs(cfg, 0, null, () => 1)).toBe(6000);
  });
  it("retryAfterMaxSeconds=0 means no cap", () => {
    expect(computeWaitMs({ ...cfg, retryAfterMaxSeconds: 0 }, 0, 300000, () => 0.5)).toBe(300000);
  });
});

describe("parseRetryAfterHeader", () => {
  it("parses seconds and http-date", () => {
    expect(parseRetryAfterHeader("120")).toBe(120000);
    expect(parseRetryAfterHeader("Wed, 21 Oct 2015 07:28:00 GMT")).toBeTypeOf("number");
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader("garbage")).toBeNull();
  });
});

describe("sleepWithAbort / waitBeforeRetry", () => {
  it("returns false immediately when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    expect(await sleepWithAbort(60000, ac.signal)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(50);
  });
  it("enforces the cumulative wait budget", async () => {
    const cfg = { ...resolveAutoRetry({}), intervalSeconds: 30, totalWaitBudgetSeconds: 10 };
    const state = { waitedMs: 0 };
    expect(await waitBeforeRetry({ cfg, attempt: 0, retryState: state, log })).toBe(false);
    expect(state.waitedMs).toBe(0);
  });
  it("sleeps and books the wait into the shared state", async () => {
    const cfg = { ...resolveAutoRetry({}), intervalSeconds: 0.01, backoff: false, totalWaitBudgetSeconds: 600 };
    const state = { waitedMs: 0 };
    expect(await waitBeforeRetry({ cfg, attempt: 0, retryState: state, log })).toBe(true);
    expect(state.waitedMs).toBeGreaterThan(0);
  });
});

describe("withAutoRetry", () => {
  const cfg = { ...resolveAutoRetry({}), intervalSeconds: 0.01, backoff: false };

  it("retries retryable failures and returns the first success", async () => {
    let calls = 0;
    const res = await withAutoRetry(async () => {
      calls++;
      return calls < 3 ? errResponse(429, "rate limit") : new Response("ok");
    }, cfg, { log });
    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("returns non-retryable errors untouched on the first attempt", async () => {
    let calls = 0;
    const res = await withAutoRetry(async () => {
      calls++;
      return errResponse(400, "invalid field");
    }, cfg, { log });
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("stops at maxRetries and returns the last error as-is", async () => {
    let calls = 0;
    const res = await withAutoRetry(async () => {
      calls++;
      return errResponse(429, "rate limit", { "retry-after": "0.01" });
    }, { ...cfg, maxRetries: 2 }, { log });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("0.01");
    expect(calls).toBe(3); // 首次 + 2 次重试
  });

  it("stops when the client disconnects during the wait", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const res = await withAutoRetry(async () => {
      calls++;
      return errResponse(429, "rate limit");
    }, cfg, { log, signal: ac.signal });
    expect(res.status).toBe(429);
    expect(calls).toBe(1);
  });

  it("stops when the total wait budget is exceeded", async () => {
    let calls = 0;
    const res = await withAutoRetry(async () => {
      calls++;
      return errResponse(429, "rate limit");
    }, { ...cfg, totalWaitBudgetSeconds: 0.001 }, { log });
    expect(res.status).toBe(429);
    expect(calls).toBe(1);
  });

  it("passes 2xx through without reading the body", async () => {
    const res = await withAutoRetry(async () => new Response("ok"), cfg, { log });
    expect(res.ok).toBe(true);
  });
});

describe("handleComboChat — member-level auto retry", () => {
  const memberCfg = { ...resolveAutoRetry({}), memberRetries: 1, intervalSeconds: 0.01, backoff: false };

  it("retries the same member on 429 before switching (memberRetries > 0)", async () => {
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "a/m" && calls.length === 1) {
        return errResponse(429, "inference exceeds tpm/rpm limit", { "retry-after": "0.01" });
      }
      return new Response("ok");
    };
    const res = await handleComboChat({
      body: { model: "c", messages: [] },
      models: ["a/m", "b/m"],
      handleSingleModel,
      log,
      comboName: "c",
      autoRetry: memberCfg,
      retryState: { waitedMs: 0 },
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["a/m", "a/m"]);
  });

  it("keeps switch-to-next-member semantics when memberRetries = 0", async () => {
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "a/m") return errResponse(429, "rate limit");
      return new Response("ok");
    };
    const res = await handleComboChat({
      body: { model: "c", messages: [] },
      models: ["a/m", "b/m"],
      handleSingleModel,
      log,
      comboName: "c",
      autoRetry: { ...resolveAutoRetry({}), memberRetries: 0, intervalSeconds: 0.01 },
      retryState: { waitedMs: 0 },
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["a/m", "b/m"]);
  });

  it("stops member retries when the client disconnects", async () => {
    const ac = new AbortController();
    ac.abort();
    const calls = [];
    const handleSingleModel = async (body, modelStr) => {
      calls.push(modelStr);
      return errResponse(429, "rate limit");
    };
    await handleComboChat({
      body: { model: "c", messages: [] },
      models: ["a/m", "b/m"],
      handleSingleModel,
      log,
      comboName: "c",
      autoRetry: memberCfg,
      retryState: { waitedMs: 0 },
      signal: ac.signal,
    });
    expect(calls).toEqual(["a/m"]);
  });
});