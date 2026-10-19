"use client";

import { useSyncExternalStore } from "react";
import { runSpeedtest, abortSpeedtest } from "./client";
import { useNotificationStore } from "@/store/notificationStore";
import type { BatchSpeedtestItem, CurvePoint, SpeedtestProgress, SpeedtestResult } from "./types";

/**
 * 测速异常信息接口
 *
 * @author iRouter
 * @since 2026-10-19
 */
export interface SpeedtestRunnerError {
  /** 错误简要标题 */
  message: string;
  /** 详细报错原因 */
  detail?: string;
}

/**
 * 测速运行器全局状态快照接口
 *
 * @author iRouter
 * @since 2026-10-19
 */
export interface SpeedtestRunnerState {
  isRunning: boolean;
  batchId: string;
  currentIndex: number;
  totalItems: number;
  currentLabel: string;
  currentProgress: SpeedtestProgress | null;
  liveCurvePoints: CurvePoint[];
  batchResults: SpeedtestResult[];
  currentSessionId: string;
  lastError: SpeedtestRunnerError | null;
}

const DEFAULT_STATE: SpeedtestRunnerState = {
  isRunning: false,
  batchId: "",
  currentIndex: 0,
  totalItems: 0,
  currentLabel: "",
  currentProgress: null,
  liveCurvePoints: [],
  batchResults: [],
  currentSessionId: "",
  lastError: null,
};

/**
 * 测速执行器全局单例状态机
 *
 * 在模块级管理测速生命周期，确保用户切至其他页面再切回时，测速任务与观测视图无缝接续
 *
 * @author iRouter
 * @since 2026-10-19
 */
class SpeedtestRunnerManager {
  private state: SpeedtestRunnerState = { ...DEFAULT_STATE };
  private listeners: Set<() => void> = new Set();

  /**
   * 获取当前状态快照
   *
   * @return 当前状态快照
   */
  getSnapshot = (): SpeedtestRunnerState => {
    return this.state;
  };

  /**
   * 订阅状态变更通知
   *
   * @param listener 变更监听回调函数
   * @return 取消订阅函数
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * 触发所有已订阅的组件更新
   */
  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * 更新局部状态
   *
   * @param partial 新的部分状态
   */
  private setState(partial: Partial<SpeedtestRunnerState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  /**
   * 清除当前记录的运行报错
   */
  clearError = (): void => {
    this.setState({ lastError: null });
  };

  /**
   * 启动批次串行测速执行
   *
   * @param items 待测条目列表
   */
  async startBatch(items: BatchSpeedtestItem[]): Promise<void> {
    if (items.length === 0 || this.state.isRunning) return;

    const batchId = crypto.randomUUID();
    this.setState({
      isRunning: true,
      batchId,
      currentIndex: 0,
      totalItems: items.length,
      currentLabel: "",
      currentProgress: null,
      liveCurvePoints: [],
      batchResults: [],
      currentSessionId: "",
      lastError: null,
    });

    for (let i = 0; i < items.length; i++) {
      if (!this.state.isRunning) break;

      const item = items[i];
      const sid = crypto.randomUUID();

      this.setState({
        currentIndex: i,
        currentLabel: item.label,
        currentSessionId: sid,
        currentProgress: null,
        liveCurvePoints: [],
      });

      try {
        const result = await runSpeedtest(
          {
            sessionId: sid,
            targetUrl: item.targetUrl,
            protocol: item.protocol,
            apiKey: item.apiKey,
            model: item.rawModel || item.model,
            prompt: item.prompt,
            maxTokens: item.maxTokens,
            temperature: item.temperature,
            customHeaders: item.customHeaders,
          },
          (progress) => {
            if (!this.state.isRunning) return;
            const updatedPoints = [...this.state.liveCurvePoints];
            if (progress.latestCurvePoint) {
              const pt = progress.latestCurvePoint;
              if (updatedPoints.length === 0 || updatedPoints[updatedPoints.length - 1].tokenIndex < pt.tokenIndex) {
                updatedPoints.push(pt);
              }
            }
            this.setState({
              currentProgress: progress,
              liveCurvePoints: updatedPoints,
            });
          }
        );

        const enrichedResult: SpeedtestResult = {
          ...result,
          sessionId: sid,
          model: item.model,
          provider: item.provider,
          gatewayUrl: item.targetUrl,
          isGateway: item.isGateway,
        };

        this.setState({
          batchResults: [...this.state.batchResults, enrichedResult],
        });

        // 若业务判定失败，记录错误并提示
        if (!result.success) {
          const errMsg = result.errorMessage || "测速返回失败状态";
          this.setState({
            lastError: {
              message: `模型 [${item.label}] 评测未通过`,
              detail: errMsg,
            },
          });
          useNotificationStore.getState().error(`[${item.label}] ${errMsg}`, "评测异常");
        }

        // 持久化存储至数据库（绝不落盘原始 API Key）
        try {
          await fetch("/api/speedtest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...enrichedResult,
              batchId,
            }),
          });
        } catch (dbErr) {
          console.error("保存测速结果失败:", dbErr);
        }
      } catch (err: unknown) {
        console.error(`条目 [${item.label}] 测速异常:`, err);
        const errMsg = err instanceof Error ? err.message : String(err);
        const failedResult: SpeedtestResult = {
          sessionId: sid,
          model: item.model,
          provider: item.provider,
          gatewayUrl: item.targetUrl,
          success: false,
          ttftMs: 0,
          totalDurationMs: 0,
          generationDurationMs: 0,
          steadySpeed: 0,
          avgSpeed: 0,
          outputTokens: 0,
          tokensEstimated: false,
          chunkMetrics: { p50Ms: 0, p95Ms: 0, p99Ms: 0, jitterRatio: null },
          curvePoints: [],
          isGateway: item.isGateway,
          errorMessage: errMsg,
        };
        this.setState({
          batchResults: [...this.state.batchResults, failedResult],
          lastError: {
            message: `模型 [${item.label}] 评测异常失败`,
            detail: errMsg,
          },
        });
        useNotificationStore.getState().error(`[${item.label}] ${errMsg}`, "评测异常");

        // 评测异常时亦同步持久化保存失败记录到数据库
        try {
          await fetch("/api/speedtest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...failedResult,
              batchId,
            }),
          });
        } catch (dbErr) {
          console.error("保存失败测速结果异常:", dbErr);
        }
      }
    }

    this.setState({
      isRunning: false,
      currentProgress: null,
      currentSessionId: "",
    });
  }

  /**
   * 中止当前正在运行的任务
   */
  async abort(): Promise<void> {
    const sid = this.state.currentSessionId;
    this.setState({
      isRunning: false,
      currentProgress: null,
      currentSessionId: "",
    });
    if (sid) {
      await abortSpeedtest(sid);
    }
  }
}

// 模块级单例保持器
export const speedtestRunnerStore = new SpeedtestRunnerManager();

/**
 * React 状态订阅 Hook
 *
 * @return 响应式状态快照与操作函数对象
 */
export function useSpeedtestRunner() {
  const snapshot = useSyncExternalStore(
    speedtestRunnerStore.subscribe,
    speedtestRunnerStore.getSnapshot,
    speedtestRunnerStore.getSnapshot
  );

  return {
    ...snapshot,
    startBatch: (items: BatchSpeedtestItem[]) => speedtestRunnerStore.startBatch(items),
    abort: () => speedtestRunnerStore.abort(),
    clearError: () => speedtestRunnerStore.clearError(),
  };
}
