import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveSpeedtestResult,
  getSpeedtestHistory,
  getSpeedtestStats,
  exportSpeedtestHistoryJsonl,
  clearSpeedtestHistory,
} from "@/lib/db/repos/speedtestRepo.js";
import * as driver from "@/lib/db/driver.js";

/**
 * 测速指标数据库仓储服务测试套件
 *
 * @author iRouter
 * @since 2026-10-16
 */

describe("speedtestRepo 测速数据持久化与脱敏测试", () => {
  let mockRows = [];
  let mockDb = null;

  beforeEach(() => {
    mockRows = [];
    mockDb = {
      run: vi.fn(async (sql, params) => {
        if (sql.includes("INSERT INTO speedtestResults")) {
          const row = {
            id: params[0],
            batchId: params[1],
            model: params[2],
            provider: params[3],
            gatewayUrl: params[4],
            protocol: params[5],
            promptTemplate: params[6],
            rounds: params[7],
            ttftMs: params[8],
            totalDurationMs: params[9],
            generationDurationMs: params[10],
            steadySpeed: params[11],
            avgSpeed: params[12],
            outputTokens: params[13],
            tokensEstimated: params[14],
            chunkP50Ms: params[15],
            chunkP95Ms: params[16],
            chunkP99Ms: params[17],
            jitterRatio: params[18],
            curvePointsJson: params[19],
            rawMetricsJson: params[20],
            keyFingerprint: params[21],
            createdAt: params[22],
          };
          mockRows.push(row);
          return { changes: 1 };
        }
        if (sql.includes("DELETE FROM speedtestResults")) {
          const prevLen = mockRows.length;
          mockRows = [];
          return { changes: prevLen };
        }
        return { changes: 0 };
      }),
      get: vi.fn(async (sql) => {
        if (sql.includes("COUNT(*)")) {
          return { total: mockRows.length };
        }
        return null;
      }),
      all: vi.fn(async (sql) => {
        if (sql.includes("GROUP BY model, gatewayUrl")) {
          return [
            {
              model: "gpt-4o",
              gatewayUrl: "https://api.openai.com/v1",
              runCount: 2,
              avgTtft: 250.5,
              minTtft: 200.0,
              avgSteadySpeed: 80.2,
              maxSteadySpeed: 85.0,
              avgChunkP50: 12.5,
              avgJitterRatio: 1.8,
            },
          ];
        }
        return mockRows;
      }),
    };

    vi.spyOn(driver, "getAdapter").mockResolvedValue(mockDb);
  });

  it("保存测速结果时自动将原始 API Key 脱敏转换为指纹", async () => {
    const rawKey = "sk-test-secret-key-1234567890";
    const recordId = await saveSpeedtestResult({
      model: "gpt-4o",
      gatewayUrl: "https://api.openai.com/v1",
      protocol: "openai",
      apiKey: rawKey,
      ttftMs: 250,
      totalDurationMs: 2000,
      generationDurationMs: 1750,
      steadySpeed: 75.5,
      avgSpeed: 60.0,
      outputTokens: 120,
      chunkMetrics: { p50Ms: 15, p95Ms: 30, p99Ms: 45, jitterRatio: 2.0 },
      curvePoints: [{ tokenIndex: 50, elapsedMs: 1000, speed: 70 }],
    });

    expect(recordId).toBeDefined();
    expect(mockRows.length).toBe(1);
    const stored = mockRows[0];
    expect(stored.model).toBe("gpt-4o");
    // 断言数据库落盘的 keyFingerprint 绝不等于原始 key
    expect(stored.keyFingerprint).not.toBe(rawKey);
    expect(stored.keyFingerprint.startsWith("sk-te")).toBe(true);
    expect(stored.keyFingerprint.endsWith("7890")).toBe(true);
    expect(stored.keyFingerprint.includes("****")).toBe(true);
  });

  it("支持分页查询测速历史并解析 JSON 字段", async () => {
    await saveSpeedtestResult({
      model: "claude-3-5-sonnet",
      gatewayUrl: "https://api.anthropic.com",
      ttftMs: 300,
      totalDurationMs: 2500,
      generationDurationMs: 2200,
      steadySpeed: 65,
      avgSpeed: 55,
      outputTokens: 140,
      curvePoints: [{ tokenIndex: 20, elapsedMs: 400, speed: 60 }],
    });

    const result = await getSpeedtestHistory({ page: 1, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.records.length).toBe(1);
    expect(result.records[0].model).toBe("claude-3-5-sonnet");
    expect(Array.isArray(result.records[0].curvePoints)).toBe(true);
    expect(result.records[0].curvePoints.length).toBe(1);
  });

  it("导出历史记录为标准 JSONL 文本格式", async () => {
    await saveSpeedtestResult({
      model: "qwen-2.5-72b",
      gatewayUrl: "https://api.together.xyz",
      ttftMs: 180,
      totalDurationMs: 1500,
      generationDurationMs: 1320,
      steadySpeed: 95,
      avgSpeed: 80,
      outputTokens: 100,
    });

    const jsonl = await exportSpeedtestHistoryJsonl();
    expect(typeof jsonl).toBe("string");
    const parsed = JSON.parse(jsonl.split("\n")[0]);
    expect(parsed.model).toBe("qwen-2.5-72b");
    expect(parsed.curvePointsJson).toBeUndefined();
  });

  it("获取多模型聚合统计看板数据", async () => {
    const stats = await getSpeedtestStats();
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBe(1);
    expect(stats[0].model).toBe("gpt-4o");
    expect(stats[0].avgSteadySpeed).toBe(80.2);
  });

  it("执行清理测速历史记录时仅清空流水明细表且保留统计表", async () => {
    mockRows.push({ id: "item-1" });
    const count = await clearSpeedtestHistory();
    expect(count).toBe(1);
    expect(mockDb.run).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM speedtestResults"));
    expect(mockDb.run).not.toHaveBeenCalledWith(expect.stringContaining("DELETE FROM speedtestStats"));
  });
});
