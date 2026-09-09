import { describe, expect, it } from "vitest";
import { parseLogLine, matchesFilters, LOG_LEVELS } from "../../src/lib/consoleLogParser.js";

describe("parseLogLine", () => {
  it("parses error lines with tag", () => {
    const e = parseLogLine("[15:41:40] ❌ [CHAT] Model a/m failed, trying next");
    expect(e.level).toBe("ERROR");
    expect(e.tag).toBe("CHAT");
    expect(e.time).toBe("15:41:40");
    expect(e.text).toBe("Model a/m failed, trying next");
  });

  it("parses warn lines including variation selector (⚠️ = ⚠ + FE0F)", () => {
    const e = parseLogLine("[12:34:29] ⚠️ [AUTH] 1373 locked for 64s");
    expect(e.level).toBe("WARN");
    expect(e.tag).toBe("AUTH");
  });

  it("parses info ℹ️ and debug 🔍", () => {
    expect(parseLogLine("[00:00:01] ℹ️  [CHAT] hello").level).toBe("INFO");
    expect(parseLogLine("[00:00:01] 🔍 [AUTH] key masked").level).toBe("DEBUG");
  });

  it("treats session color dots and unknown icons as LOG", () => {
    const e = parseLogLine("[12:34:24] 🟢 ▶ POST deepseek-v4-flash · 2250 MSG");
    expect(e.level).toBe("LOG");
    expect(e.tag).toBe("");
    expect(e.text).toBe("▶ POST deepseek-v4-flash · 2250 MSG");
  });

  it("passes through plain console output as LOG", () => {
    const e = parseLogLine("✓ Running next.config took 3ms");
    expect(e.level).toBe("LOG");
    expect(e.raw).toBe("✓ Running next.config took 3ms");
  });

  it("handles RETRY tag and empty input", () => {
    const e = parseLogLine("[15:41:33] ℹ️ [RETRY] waiting 33.4s before retry (attempt 1)");
    expect(e.level).toBe("INFO");
    expect(e.tag).toBe("RETRY");
    expect(parseLogLine("")).toEqual({ time: "", icon: "", tag: "", text: "", level: "LOG", raw: "" });
  });

  it("covers all levels in LOG_LEVELS", () => {
    expect(LOG_LEVELS).toEqual(["ERROR", "WARN", "INFO", "DEBUG", "LOG"]);
  });
});

describe("matchesFilters", () => {
  const err = parseLogLine("[00:00:01] ❌ [CHAT] boom");
  const info = parseLogLine("[00:00:02] ℹ️ [RETRY] waiting 5s");
  const plain = parseLogLine("some plain output");

  it("filters by level set (empty set = all)", () => {
    const levels = new Set(["ERROR"]);
    expect(matchesFilters(err, { levels })).toBe(true);
    expect(matchesFilters(info, { levels })).toBe(false);
    expect(matchesFilters(err, {})).toBe(true);
  });

  it("matches query against the raw line, case-insensitive", () => {
    expect(matchesFilters(info, { query: "retry" })).toBe(true);
    expect(matchesFilters(err, { query: "retry" })).toBe(false);
  });

  it("combines level + query", () => {
    const levels = new Set(["ERROR"]);
    expect(matchesFilters(err, { levels, query: "boom" })).toBe(true);
    expect(matchesFilters(err, { levels, query: "waiting" })).toBe(false);
  });
});