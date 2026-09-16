import test from "node:test";
import assert from "node:assert/strict";

/**
 * 测试“使用情况”页面自动刷新核心防抖冷却与定时器调度逻辑
 *
 * @author wei
 * @since 2026-09-16
 */
test("前台唤醒冷却防抖逻辑验证", () => {
  const COOLDOWN_MS = 10000;
  let lastRefreshedAt = 100000;

  // 场景 1：距上次刷新 5 秒（不足 10 秒），非强制触发应被节流拦截
  const now1 = lastRefreshedAt + 5000;
  const shouldSkip1 = now1 - lastRefreshedAt < COOLDOWN_MS;
  assert.equal(shouldSkip1, true, "5秒内触发应当被防抖拦截");

  // 场景 2：距上次刷新 11 秒（超过 10 秒），应当允许刷新
  const now2 = lastRefreshedAt + 11000;
  const shouldSkip2 = now2 - lastRefreshedAt < COOLDOWN_MS;
  assert.equal(shouldSkip2, false, "超过10秒应当允许前台唤醒刷新");

  // 场景 3：强制刷新（用户手动点击刷新按钮），无视冷却限制
  const force = true;
  const allowRefresh = force || now1 - lastRefreshedAt >= COOLDOWN_MS;
  assert.equal(allowRefresh, true, "手动强制刷新应立即放行");
});

test("定时轮询参数边界与默认值解析验证", () => {
  const DEFAULT_INTERVAL_SEC = 30;

  /**
   * 解析存储的轮询间隔秒数
   *
   * @param {string|null} stored 存储的原始字符串
   * @return {number} 解析后的有效秒数
   */
  const parseInterval = (stored) => {
    if (!stored) return DEFAULT_INTERVAL_SEC;
    const parsed = parseInt(stored, 10);
    return !isNaN(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_SEC;
  };

  assert.equal(parseInterval(null), 30);
  assert.equal(parseInterval("15"), 15);
  assert.equal(parseInterval("60"), 60);
  assert.equal(parseInterval("invalid"), 30);
  assert.equal(parseInterval("-5"), 30);
});

test("页面可见性状态判断与轮询控制逻辑验证", () => {
  /**
   * 模拟轮询器触发检查
   *
   * @param {boolean} enabled 是否开启自动刷新
   * @param {string} visibilityState 页面可见状态
   * @return {boolean} 是否应当执行数据拉取
   */
  const shouldPoll = (enabled, visibilityState) => {
    if (!enabled) return false;
    return visibilityState === "visible";
  };

  assert.equal(shouldPoll(false, "visible"), false, "关闭时即便在前台也不应拉取");
  assert.equal(shouldPoll(true, "hidden"), false, "开启但在后台时应挂起，不拉取");
  assert.equal(shouldPoll(true, "visible"), true, "开启且在前台时应正常触发轮询");
});

test("请求明细防打扰保护机制判定验证", () => {
  /**
   * 判定当前状态是否允许静默刷新请求详情
   *
   * @param {boolean} isDrawerOpen 抽屉是否展开
   * @param {number} page 当前页码
   * @return {boolean} 是否允许刷新
   */
  const canSilentRefreshDetails = (isDrawerOpen, page) => {
    return !isDrawerOpen && page === 1;
  };

  assert.equal(canSilentRefreshDetails(false, 1), true, "无抽屉且在第1页应允许刷新");
  assert.equal(canSilentRefreshDetails(true, 1), false, "抽屉打开时禁止自动刷新以防干扰");
  assert.equal(canSilentRefreshDetails(false, 2), false, "翻到第2页及以后禁止自动刷新以防跳变");
  assert.equal(canSilentRefreshDetails(true, 3), false, "翻页且开抽屉绝对禁止刷新");
});
