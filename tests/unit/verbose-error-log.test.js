// 完整异常日志开关（settings.verboseErrorLog）的运行时约束：
// 默认关 → errorDetail 不输出；开启后输出；上游原始报文由 parseUpstreamError 带出。
import { afterEach, describe, expect, it, vi } from "vitest";

const log = await import("../../src/sse/utils/logger.js");
const { DEFAULT_SETTINGS } = await import("../../src/lib/db/repos/settingsRepo.js");
const { parseUpstreamError } = await import("../../open-sse/utils/error.js");

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
});
