// 用量记录的写入去重语义。
//
// 背景（修复前的真实缺陷）：写入路径按 (timestamp, provider, model, account, key,
// tokens) 找同款记录并合并，而 timestamp 只有毫秒精度——于是同一毫秒内形状相同的
// **不同**请求会被并成一条。压测实测 100 条并行只落 1 条、50 条落 13 条，使用量
// 统计因此静默少算（db-concurrent.test.js 里三条断言都在报这个）。
//
// 现在只有「能补全已存记录缺失的 endpoint」时才合并。本文件同时钉住两侧：
//   · 互不相同的记录一条都不能丢（哪怕字段完全一样、同一毫秒）
//   · 同一次请求的先缺后补仍然合并，不重复计数
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-dedup-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const entry = (over = {}) => ({
  provider: "openai",
  model: "gpt-4",
  connectionId: "c1",
  tokens: { prompt_tokens: 10, completion_tokens: 5 },
  status: "ok",
  ...over,
});

describe("usage recording — dedup semantics", () => {
  it("字段完全相同、同一毫秒的并行写入，一条都不能少", async () => {
    const N = 50;
    const ts = "2026-09-30T10:00:00.000Z";
    // 显式传同一个 timestamp：把「同一毫秒」变成确定性条件，而不是靠运气撞上
    await Promise.all(
      Array.from({ length: N }, () => db.saveRequestUsage(entry({ timestamp: ts }))),
    );

    const hist = await db.getUsageHistory({ provider: "openai" });
    expect(hist.length).toBe(N);

    const stats = await db.getUsageStats("24h");
    expect(stats.byProvider.openai.requests).toBe(N);
    expect(stats.byProvider.openai.promptTokens).toBe(N * 10);
  });

  it("同一次请求先不带 endpoint、后带上 → 合并成一条并补全，不重复计数", async () => {
    const ts = "2026-09-30T11:00:00.000Z";
    await db.saveRequestUsage(entry({ provider: "merge-me", timestamp: ts }));
    await db.saveRequestUsage(
      entry({ provider: "merge-me", timestamp: ts, endpoint: "/v1/chat/completions" }),
    );

    const hist = await db.getUsageHistory({ provider: "merge-me" });
    expect(hist.length, "两次记录应合并为一条").toBe(1);
    expect(hist[0].endpoint).toBe("/v1/chat/completions");

    const stats = await db.getUsageStats("24h");
    expect(stats.byProvider["merge-me"].requests, "合并后只算一次").toBe(1);
  });

  it("已存记录已有 endpoint 时，后来者不再被吞（这是修复前的丢数据点）", async () => {
    const ts = "2026-09-30T12:00:00.000Z";
    await db.saveRequestUsage(
      entry({ provider: "keep-both", timestamp: ts, endpoint: "/v1/chat/completions" }),
    );
    await db.saveRequestUsage(
      entry({ provider: "keep-both", timestamp: ts, endpoint: "/v1/chat/completions" }),
    );

    const stats = await db.getUsageStats("24h");
    expect(stats.byProvider["keep-both"].requests).toBe(2);
  });
});
