"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY_ENABLED = "usage_auto_refresh_enabled";
const STORAGE_KEY_INTERVAL = "usage_auto_refresh_interval";
const DEFAULT_INTERVAL_SEC = 30;
const COOLDOWN_MS = 10000;

/**
 * “使用情况”页面自动刷新与前台唤醒刷新 Hook
 * 负责协调前台唤醒检测（防抖节流）、定时轮询及刷新状态管理
 *
 * @author wei
 * @since 2026-09-16
 * @param {Object} options 配置项
 * @param {Function} [options.onRefresh] 触发刷新时的外部异步回调
 * @return {Object} 自动刷新状态与控制方法
 */
export function useUsageAutoRefresh({ onRefresh } = {}) {
  // 惰性读取 localStorage，避免 useEffect 中同步 setState 产生多余渲染
  const [enabled, setEnabledState] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      const stored = localStorage.getItem(STORAGE_KEY_ENABLED);
      return stored === "true";
    } catch {
      return false;
    }
  });

  const [intervalSec, setIntervalSecState] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_INTERVAL_SEC;
    try {
      const stored = localStorage.getItem(STORAGE_KEY_INTERVAL);
      const parsed = parseInt(stored || "", 10);
      return !isNaN(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_SEC;
    } catch {
      return DEFAULT_INTERVAL_SEC;
    }
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // 记录最近一次成功刷新的时间戳，用于前台唤醒防抖冷却（初始置 0）
  const lastRefreshedAtRef = useRef(0);
  // 避免高频并发调用
  const isRefreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  // 组件挂载时初始化最近刷新时间为当前时间
  useEffect(() => {
    lastRefreshedAtRef.current = Date.now();
  }, []);

  /**
   * 切换自动刷新开关状态并持久化
   *
   * @param {boolean} nextVal 新的开启状态
   * @return {void}
   */
  const setEnabled = useCallback((nextVal) => {
    setEnabledState(nextVal);
    try {
      localStorage.setItem(STORAGE_KEY_ENABLED, String(nextVal));
    } catch (e) {}
  }, []);

  /**
   * 变更定时刷新间隔秒数并持久化
   *
   * @param {number} sec 轮询间隔秒数
   * @return {void}
   */
  const setIntervalSec = useCallback((sec) => {
    setIntervalSecState(sec);
    try {
      localStorage.setItem(STORAGE_KEY_INTERVAL, String(sec));
    } catch (e) {}
  }, []);

  /**
   * 触发刷新逻辑
   *
   * @param {Object} [triggerOpts] 触发配置
   * @param {boolean} [triggerOpts.force=false] 是否无视冷却时间强制刷新
   * @return {Promise<void>} 异步刷新完成 Promise
   */
  const triggerRefresh = useCallback(async ({ force = false } = {}) => {
    const now = Date.now();
    // 非强制刷新时进行 10 秒冷却校验
    if (!force && lastRefreshedAtRef.current > 0 && now - lastRefreshedAtRef.current < COOLDOWN_MS) {
      return;
    }
    if (isRefreshingRef.current) {
      return;
    }

    isRefreshingRef.current = true;
    setIsRefreshing(true);
    lastRefreshedAtRef.current = now;
    setRefreshKey((prev) => prev + 1);

    try {
      if (typeof onRefreshRef.current === "function") {
        await onRefreshRef.current();
      }
    } catch (err) {
      // 忽略刷新回调异常，保证状态平稳复位
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, []);

  // 监听前台切回与窗口聚焦（前台唤醒自动刷新）
  useEffect(() => {
    /**
     * 处理窗口前台唤醒与聚焦事件
     */
    const handleWakeup = () => {
      // 仅在页面处于可见状态时执行前台唤醒刷新
      if (document.visibilityState === "visible") {
        triggerRefresh({ force: false });
      }
    };

    document.addEventListener("visibilitychange", handleWakeup);
    window.addEventListener("focus", handleWakeup);

    return () => {
      document.removeEventListener("visibilitychange", handleWakeup);
      window.removeEventListener("focus", handleWakeup);
    };
  }, [triggerRefresh]);

  // 定时自动轮询逻辑
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const timer = setInterval(() => {
      // 后台标签页挂起：页面隐藏时不执行轮询，节约系统资源
      if (document.visibilityState === "visible") {
        triggerRefresh({ force: true });
      }
    }, intervalSec * 1000);

    return () => clearInterval(timer);
  }, [enabled, intervalSec, triggerRefresh]);

  return {
    enabled,
    setEnabled,
    intervalSec,
    setIntervalSec,
    isRefreshing,
    refreshKey,
    triggerRefresh: () => triggerRefresh({ force: true }),
  };
}
