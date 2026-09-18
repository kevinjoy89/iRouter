/**
 * 账号重试、粘性策略尊重重试与429锁定时长配置的单元测试
 *
 * @author wei
 * @since 2026-09-18
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_AUTO_RETRY,
  resolveAutoRetry,
  normalizeAutoRetryConfig,
  waitBeforeRetry,
} from "../../open-sse/services/autoRetry.js";
import {
  getQuotaCooldown,
  checkFallbackError,
} from "../../open-sse/services/accountFallback.js";
import {
  getRotatedModels,
  resetComboRotation,
  recordComboSuccess,
  recordComboFailure,
  handleComboChat,
} from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, errorDetail: () => {} };
const errResponse = (status, message, headers = {}) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers });
const okResponse = (body = { result: "ok" }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("AutoRetry 配置归一化与新字段测试", () => {
  it("默认配置应包含账号重试、粘性尊重及429锁定时长参数", () => {
    const cfg = resolveAutoRetry({});
    expect(cfg.accountRetries).toBe(0);
    expect(cfg.comboStickyRespectRetries).toBe(false);
    expect(cfg.rateLimitLockMaxSeconds).toBe(120);
    expect(cfg.rateLimitLockBaseSeconds).toBe(2);
  });

  it("应允许配置成员重试高达50次与账号重试", () => {
    const normalized = normalizeAutoRetryConfig({
      memberRetries: 50,
      accountRetries: 10,
      rateLimitLockMaxSeconds: 3600,
      rateLimitLockBaseSeconds: 5,
      comboStickyRespectRetries: true,
    });
    expect(normalized.memberRetries).toBe(50);
    expect(normalized.accountRetries).toBe(10);
    expect(normalized.rateLimitLockMaxSeconds).toBe(3600);
    expect(normalized.rateLimitLockBaseSeconds).toBe(5);
    expect(normalized.comboStickyRespectRetries).toBe(true);
  });
});

describe("429 锁定时长与指数退避自定义测试", () => {
  it("应受 rateLimitLockMaxSeconds 封顶限制", () => {
    // 模拟高退避级别，若上限设为 10 秒，指数翻倍不能超过 10 秒
    const customConfig = {
      rateLimitLockMaxSeconds: 10,
      rateLimitLockBaseSeconds: 2,
      backoff: true,
    };
    // 退避级别为 6 时，原本 2 * 2^5 = 64s，现应被钳制在 10s
    const cd = getQuotaCooldown(6, customConfig);
    expect(cd).toBe(10000);
  });

  it("当 rateLimitLockMaxSeconds 为 0 时应禁用锁定", () => {
    const customConfig = {
      rateLimitLockMaxSeconds: 0,
      rateLimitLockBaseSeconds: 2,
    };
    const cd = getQuotaCooldown(3, customConfig);
    expect(cd).toBe(0);
  });

  it("当 backoff 为 false 时应使用固定基础时长不发生指数翻倍", () => {
    const customConfig = {
      rateLimitLockMaxSeconds: 300,
      rateLimitLockBaseSeconds: 5,
      backoff: false,
    };
    for (let level = 1; level <= 5; level++) {
      const cd = getQuotaCooldown(level, customConfig);
      expect(cd).toBe(5000);
    }
  });

  it("checkFallbackError 应透传自定义配置给 getQuotaCooldown", () => {
    const customConfig = {
      rateLimitLockMaxSeconds: 8,
      rateLimitLockBaseSeconds: 2,
    };
    const res = checkFallbackError(429, "rate limit exceeded", 0, customConfig);
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBeLessThanOrEqual(8000);
  });
});

describe("Combo 粘性策略优先尊重单模型重试测试", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("开启 deferStickyIncrement 时 getRotatedModels 不提前递增使用计数", () => {
    const models = ["provider/model-a", "provider/model-b"];
    const combo = "test-combo";

    // 连续两次调用，不应推进粘性计数
    const r1 = getRotatedModels(models, combo, "round-robin", 2, { deferStickyIncrement: true });
    const r2 = getRotatedModels(models, combo, "round-robin", 2, { deferStickyIncrement: true });
    expect(r1[0]).toBe("provider/model-a");
    expect(r2[0]).toBe("provider/model-a");
  });

  it("recordComboSuccess 仅在履约成功后推进计数并在达标时轮转", () => {
    const models = ["provider/model-a", "provider/model-b"];
    const combo = "test-combo";

    // 第一次调用并在 model-a 成功履约
    getRotatedModels(models, combo, "round-robin", 2, { deferStickyIncrement: true });
    recordComboSuccess(combo, models, "provider/model-a", 2);

    // 第二次调用，仍应为 model-a
    const r2 = getRotatedModels(models, combo, "round-robin", 2, { deferStickyIncrement: true });
    expect(r2[0]).toBe("provider/model-a");

    // 第二次履约成功，累计达标 2 次，游标应当切换至下一模型
    recordComboSuccess(combo, models, "provider/model-a", 2);

    // 第三次调用，应轮转到 model-b
    const r3 = getRotatedModels(models, combo, "round-robin", 2, { deferStickyIncrement: true });
    expect(r3[0]).toBe("provider/model-b");
  });

  it("handleComboChat 中启用 comboStickyRespectRetries 时在重试成功后消耗粘性", async () => {
    const models = ["provider/model-a", "provider/model-b"];
    let callCount = 0;

    const handleSingleModel = async (body, modelStr) => {
      callCount++;
      if (modelStr === "provider/model-a") {
        // 第一次调用报 429，重试后返回 200
        if (callCount === 1) {
          return errResponse(429, "rate limited");
        }
        return okResponse({ reply: "success on retry" });
      }
      return okResponse({ reply: "b" });
    };

    const autoRetry = {
      ...DEFAULT_AUTO_RETRY,
      enabled: true,
      memberRetries: 2,
      intervalSeconds: 1,
      comboStickyRespectRetries: true,
    };

    // 执行请求，model-a 重试成功
    const res = await handleComboChat({
      body: {},
      models,
      handleSingleModel,
      log,
      comboName: "respect-test",
      comboStrategy: "round-robin",
      comboStickyLimit: 2,
      comboStickyRespectRetries: true,
      autoRetry,
    });

    expect(res.ok).toBe(true);
    expect(callCount).toBe(2);

    // 下一次请求由于粘性 limit=2 且才成功 1 次，仍应优先命中 model-a
    const nextRotated = getRotatedModels(models, "respect-test", "round-robin", 2, { deferStickyIncrement: true });
    expect(nextRotated[0]).toBe("provider/model-a");
  });

  it("全模型失败时 recordComboFailure 推进游标避免卡死", () => {
    const models = ["provider/model-a", "provider/model-b"];
    const combo = "fail-combo";

    getRotatedModels(models, combo, "round-robin", 2, { deferStickyIncrement: true });
    recordComboFailure(combo, models);

    // 失败后游标直接推进到 model-b
    const next = getRotatedModels(models, combo, "round-robin", 2, { deferStickyIncrement: true });
    expect(next[0]).toBe("provider/model-b");
  });
});

describe("账号级原地等待重试（accountRetries）行为测试", () => {
  it("账号遇到429时原地重试成功不应故障转移且不锁定账号", async () => {
    let attempts = 0;
    const accountRetries = 2;
    const retryConfig = {
      ...DEFAULT_AUTO_RETRY,
      enabled: true,
      accountRetries,
      intervalSeconds: 1,
    };
    const retryState = { totalWaitMs: 0 };
    const mockAccounts = ["account-1", "account-2"];
    const lockedAccounts = [];

    const callWithAccount = async (account) => {
      attempts++;
      if (account === "account-1") {
        if (attempts === 1) return errResponse(429, "rate limit");
        return okResponse({ reply: "account-1 recovered" });
      }
      return okResponse({ reply: "account-2" });
    };

    // 模拟 handleSingleModelChat 中的账号循环
    let finalRes = null;
    for (const acc of mockAccounts) {
      let res = await callWithAccount(acc);
      if (!res.ok && res.status === 429 && retryConfig.accountRetries > 0) {
        for (let a = 0; a < retryConfig.accountRetries; a++) {
          const proceed = await waitBeforeRetry({
            cfg: retryConfig,
            attempt: a,
            retryState,
            label: "ACCOUNT-RETRY",
          });
          if (!proceed) break;
          const retried = await callWithAccount(acc);
          if (retried.ok) {
            res = retried;
            break;
          }
        }
      }

      if (res.ok) {
        finalRes = res;
        break;
      } else {
        lockedAccounts.push(acc);
      }
    }

    expect(finalRes).not.toBeNull();
    expect(finalRes.ok).toBe(true);
    const data = await finalRes.json();
    expect(data.reply).toBe("account-1 recovered");
    // 验证账号1原地重试成功，没有切到账号2，也没有锁定账号1
    expect(attempts).toBe(2);
    expect(lockedAccounts).toEqual([]);
  });

  it("账号遇到429原地重试耗尽后锁定并故障转移到下一账号", async () => {
    let attempts = 0;
    const accountRetries = 1;
    const retryConfig = {
      ...DEFAULT_AUTO_RETRY,
      enabled: true,
      accountRetries,
      intervalSeconds: 1,
    };
    const retryState = { totalWaitMs: 0 };
    const mockAccounts = ["account-1", "account-2"];
    const lockedAccounts = [];

    const callWithAccount = async (account) => {
      attempts++;
      if (account === "account-1") {
        return errResponse(429, "rate limit");
      }
      return okResponse({ reply: "account-2 success" });
    };

    let finalRes = null;
    for (const acc of mockAccounts) {
      let res = await callWithAccount(acc);
      if (!res.ok && res.status === 429 && retryConfig.accountRetries > 0) {
        for (let a = 0; a < retryConfig.accountRetries; a++) {
          const proceed = await waitBeforeRetry({
            cfg: retryConfig,
            attempt: a,
            retryState,
            label: "ACCOUNT-RETRY",
          });
          if (!proceed) break;
          const retried = await callWithAccount(acc);
          if (retried.ok) {
            res = retried;
            break;
          }
        }
      }

      if (res.ok) {
        finalRes = res;
        break;
      } else {
        lockedAccounts.push(acc);
      }
    }

    expect(finalRes).not.toBeNull();
    expect(finalRes.ok).toBe(true);
    const data = await finalRes.json();
    expect(data.reply).toBe("account-2 success");
    // 账号1尝试了1次初始 + 1次重试 = 2次，失败后锁定，然后切账号2尝试1次 = 总共3次
    expect(attempts).toBe(3);
    expect(lockedAccounts).toEqual(["account-1"]);
  });
});
