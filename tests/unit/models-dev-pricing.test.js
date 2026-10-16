/**
 * models.dev 定价提纯与多层级解析契约测试
 *
 * @author kevinjoy89
 * @since 2026-10-16
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseModelsDevData,
  setRuntimePricingCache,
  getPricingForModel,
  calculateCostFromTokens,
  isFreeModel,
  ZERO_PRICING,
} from "../../open-sse/providers/pricing.js";

describe("models.dev 定价解析与智能匹配引擎", () => {
  beforeEach(() => {
    // 每次测试前清理运行时缓存
    setRuntimePricingCache(null);
  });

  it("正确将 models.dev 原始数据提纯并提取关键费率字段", () => {
    const mockRaw = {
      deepinfra: {
        id: "deepinfra",
        models: {
          "anthropic/claude-fable-5": {
            id: "anthropic/claude-fable-5",
            canonical_model_id: "anthropic/claude-fable-5",
            cost: {
              input: 10,
              output: 50,
              cache_read: 1.0,
              cache_write: 12.5,
            },
          },
        },
      },
      openai: {
        id: "openai",
        models: {
          "gpt-4o-2026-custom": {
            id: "gpt-4o-2026-custom",
            cost: {
              input: 2.5,
              output: 10,
              cache_read: 1.25,
            },
          },
        },
      },
    };

    const parsed = parseModelsDevData(mockRaw);
    expect(parsed.modelCount).toBe(2);
    expect(parsed.lastUpdated).toBeTruthy();

    // 检查字段映射：cache_read 映射为 cached，cache_write 映射为 cache_creation
    const fablePricing = parsed.byProvider.deepinfra["anthropic/claude-fable-5"];
    expect(fablePricing).toBeDefined();
    expect(fablePricing.input).toBe(10);
    expect(fablePricing.output).toBe(50);
    expect(fablePricing.cached).toBe(1.0);
    expect(fablePricing.cache_creation).toBe(12.5);
    expect(fablePricing.reasoning).toBe(50);

    // 检查全局规范表按基础名收录
    expect(parsed.byModel["claude-fable-5"]).toBeDefined();
    expect(parsed.byModel["gpt-4o-2026-custom"]).toBeDefined();
  });

  it("cline-free 免费命名空间始终判定为零费率", () => {
    expect(isFreeModel("cline-free/deepseek-chat")).toBe(true);
    expect(isFreeModel("cline-free/claude-3-5-sonnet")).toBe(true);

    const pricing = getPricingForModel("openrouter", "cline-free/deepseek-chat");
    expect(pricing).toEqual(ZERO_PRICING);
    expect(pricing.input).toBe(0);
    expect(pricing.output).toBe(0);
  });

  it("多层级解析：models.dev 运行时缓存优先，未命中时平滑降级至内置离线兜底", () => {
    // 1. 未注入缓存时，调用内置模型
    const fallbackPrice = getPricingForModel("anthropic", "claude-sonnet-4-6");
    expect(fallbackPrice).toBeDefined();
    expect(fallbackPrice.input).toBe(3.0);

    // 2. 注入 models.dev 缓存后，优先采用 models.dev 实时数据
    const mockSlim = {
      byProvider: {
        anthropic: {
          "claude-sonnet-4-6": {
            input: 2.8,
            output: 14.0,
            cached: 0.28,
            reasoning: 14.0,
            cache_creation: 3.5,
          },
        },
      },
      byModel: {
        "claude-sonnet-4-6": {
          input: 2.8,
          output: 14.0,
          cached: 0.28,
          reasoning: 14.0,
          cache_creation: 3.5,
        },
        "deepseek-v4-super": {
          input: 0.15,
          output: 0.6,
          cached: 0.02,
          reasoning: 0.6,
          cache_creation: 0.15,
        },
      },
      modelCount: 2,
      lastUpdated: new Date().toISOString(),
    };
    setRuntimePricingCache(mockSlim);

    // 命中了 models.dev 的新价格
    const livePrice = getPricingForModel("anthropic", "claude-sonnet-4-6");
    expect(livePrice.input).toBe(2.8);

    // 命中了跨渠道的全新模型
    const newModelPrice = getPricingForModel("deepinfra", "deepseek-v4-super");
    expect(newModelPrice).toBeDefined();
    expect(newModelPrice.input).toBe(0.15);

    // 未在 models.dev 出现的模型，依旧可以从内置离线库回退
    const classicPrice = getPricingForModel("openai", "gpt-3.5-turbo");
    expect(classicPrice).toBeDefined();
    expect(classicPrice.input).toBe(0.5);
  });

  it("计算 Token 调用成本符合精准公式（考虑缓存扣减与百万比率）", () => {
    const pricing = {
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      reasoning: 15.0,
      cache_creation: 3.75,
    };

    const tokens = {
      prompt_tokens: 1000000,
      cached_tokens: 500000,
      completion_tokens: 100000,
    };

    // nonCachedInput = 1,000,000 - 500,000 = 500,000
    // cost = 500,000 * 3/1M + 500,000 * 0.3/1M + 100,000 * 15/1M
    //      = 1.5 + 0.15 + 1.5 = 3.15
    const cost = calculateCostFromTokens(tokens, pricing);
    expect(cost).toBeCloseTo(3.15, 4);
  });
});
