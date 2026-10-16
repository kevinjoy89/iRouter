"use client";

import React, { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import SpeedtestConfigForm from "@/features/speedtest/components/SpeedtestConfigForm";
import SpeedtestBatchView from "@/features/speedtest/components/SpeedtestBatchView";
import SpeedtestHistoryView from "@/features/speedtest/components/SpeedtestHistoryView";
import { runSpeedtest, abortSpeedtest } from "@/features/speedtest/client";
import { useSpeedtestI18n } from "@/features/speedtest/i18n";
import type { BatchSpeedtestItem, SpeedtestProgress, SpeedtestResult, CurvePoint } from "@/features/speedtest/types";

/**
 * 测速主页面核心业务逻辑容器组件
 *
 * @author iRouter
 * @since 2026-10-16
 */
function SpeedtestDashboardContent() {
  const { t } = useSpeedtestI18n();
  const searchParams = useSearchParams();
  const initialModel = searchParams.get("model") || "";
  const initialProvider = searchParams.get("provider") || "";

  const [activeTab, setActiveTab] = useState<"runner" | "history">("runner");
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [totalItems, setTotalItems] = useState<number>(0);
  const [currentLabel, setCurrentLabel] = useState<string>("");
  const [currentProgress, setCurrentProgress] = useState<SpeedtestProgress | null>(null);
  const [liveCurvePoints, setLiveCurvePoints] = useState<CurvePoint[]>([]);
  const [batchResults, setBatchResults] = useState<SpeedtestResult[]>([]);

  /**
   * 启动批次串行测速执行
   *
   * @param items 待测条目列表
   */
  const handleStartBatch = async (items: BatchSpeedtestItem[]) => {
    if (items.length === 0 || isRunning) return;

    setIsRunning(true);
    setTotalItems(items.length);
    setBatchResults([]);

    const batchId = crypto.randomUUID();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const sid = crypto.randomUUID();
      setCurrentSessionId(sid);
      setCurrentIndex(i);
      setCurrentLabel(item.label);
      setCurrentProgress(null);
      setLiveCurvePoints([]);

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
            setCurrentProgress(progress);
            if (progress.latestCurvePoint) {
              setLiveCurvePoints((prev) => {
                const pt = progress.latestCurvePoint!;
                if (prev.length === 0 || prev[prev.length - 1].tokenIndex < pt.tokenIndex) {
                  return [...prev, pt];
                }
                return prev;
              });
            }
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

        setBatchResults((prev) => [...prev, enrichedResult]);

        // 持久化存储至 SQLite 数据库
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
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        setBatchResults((prev) => [...prev, failedResult]);
      }
    }

    setIsRunning(false);
    setCurrentProgress(null);
  };

  /**
   * 中止当前正在运行的任务
   */
  const handleAbort = async () => {
    if (currentSessionId) {
      await abortSpeedtest(currentSessionId);
      setIsRunning(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* 顶部工具栏：视图切换 Tabs 与单调时钟状态指示 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex p-1 rounded-xl bg-surface-2 border border-border text-xs self-start sm:self-auto shrink-0">
          <button
            type="button"
            className={`px-3.5 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              activeTab === "runner"
                ? "bg-surface text-primary shadow-sm font-semibold"
                : "text-text-muted hover:text-text-main"
            }`}
            onClick={() => setActiveTab("runner")}
          >
            <span className="material-symbols-outlined text-base">terminal</span>
            {t("tabRunner")}
          </button>
          <button
            type="button"
            className={`px-3.5 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              activeTab === "history"
                ? "bg-surface text-primary shadow-sm font-semibold"
                : "text-text-muted hover:text-text-main"
            }`}
            onClick={() => setActiveTab("history")}
          >
            <span className="material-symbols-outlined text-base">leaderboard</span>
            {t("tabHistory")}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono border border-emerald-500/20 whitespace-nowrap">
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {t("clockBadge")}
          </span>
        </div>
      </div>

      {/* 标签一：基准评测控制台自上而下流式交互工作台（全宽舒展体验） */}
      {activeTab === "runner" ? (
        <div className="flex flex-col gap-6">
          {/* 上半部分：基准配置与触发控制台 */}
          <SpeedtestConfigForm
            onStartBatch={handleStartBatch}
            isRunning={isRunning}
            onAbort={handleAbort}
            initialModel={initialModel}
            initialProvider={initialProvider}
          />

          {/* 下半部分：全宽实时遥测 HUD 与评测对比矩阵 */}
          <SpeedtestBatchView
            currentIndex={currentIndex}
            totalItems={totalItems}
            currentProgress={currentProgress}
            currentLabel={currentLabel}
            livePoints={liveCurvePoints}
            results={batchResults}
            isRunning={isRunning}
          />
        </div>
      ) : (
        /* 标签二：历史看板与天梯榜 */
        <SpeedtestHistoryView />
      )}
    </div>
  );
}

/**
 * 测速主页面入口（使用 Suspense 包裹以支持 useSearchParams）
 *
 * @author iRouter
 * @since 2026-10-16
 */
export default function SpeedtestPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center p-12 text-xs text-text-muted font-mono">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary animate-spin text-base">progress_activity</span>
            Loading...
          </div>
        </div>
      }
    >
      <SpeedtestDashboardContent />
    </Suspense>
  );
}
