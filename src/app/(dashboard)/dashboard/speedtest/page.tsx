"use client";

import React, { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import SpeedtestConfigForm from "@/features/speedtest/components/SpeedtestConfigForm";
import SpeedtestBatchView from "@/features/speedtest/components/SpeedtestBatchView";
import SpeedtestHistoryView from "@/features/speedtest/components/SpeedtestHistoryView";
import { useSpeedtestRunner } from "@/features/speedtest/runnerStore";
import { useSpeedtestI18n } from "@/features/speedtest/i18n";

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

  // 接入全局单例 Store，确保路由切换或切回页面时接续展示测速状态与波形
  const {
    isRunning,
    currentIndex,
    totalItems,
    currentLabel,
    currentProgress,
    liveCurvePoints,
    batchResults,
    startBatch,
    abort,
    lastError,
    clearError,
  } = useSpeedtestRunner();

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* 顶部工具栏：视图切换 Tabs */}
      <div className="flex items-center justify-between">
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
      </div>

      {/* 标签一：基准评测控制台自上而下流式交互工作台（全宽舒展体验） */}
      {activeTab === "runner" ? (
        <div className="flex flex-col gap-6">
          {/* 上半部分：基准配置与触发控制台 */}
          <SpeedtestConfigForm
            onStartBatch={startBatch}
            isRunning={isRunning}
            onAbort={abort}
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
            lastError={lastError}
            onClearError={clearError}
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
