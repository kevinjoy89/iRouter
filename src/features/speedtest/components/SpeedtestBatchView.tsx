"use client";

import React, { useState } from "react";
import SpeedtestSparkline from "./SpeedtestSparkline";
import { useSpeedtestI18n } from "../i18n";
import type { SpeedtestProgress, SpeedtestResult, CurvePoint } from "../types";

/**
 * 批次视图组件属性接口
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface SpeedtestBatchViewProps {
  currentIndex?: number;
  totalItems?: number;
  currentProgress?: SpeedtestProgress | null;
  currentLabel?: string;
  livePoints?: CurvePoint[];
  results?: SpeedtestResult[];
  isRunning?: boolean;
}

/**
 * 专业基准评测实时观测遥测大屏与对比矩阵组件 (TSX)
 *
 * @author iRouter
 * @since 2026-10-16
 */
export default function SpeedtestBatchView({
  currentIndex = 0,
  totalItems = 0,
  currentProgress = null,
  currentLabel = "",
  livePoints = [],
  results = [],
  isRunning = false,
}: SpeedtestBatchViewProps) {
  const { t } = useSpeedtestI18n();

  const [sortKey, setSortKey] = useState<keyof SpeedtestResult>("steadySpeed");
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  // 未运行且无评测结果时，保持工作台干净，不占用垂直空间
  if (!isRunning && results.length === 0) {
    return null;
  }

  // 排序结果列表
  const sortedResults = [...results].sort((a, b) => {
    let valA = a[sortKey];
    let valB = b[sortKey];
    if (valA === undefined || valA === null) valA = 0 as never;
    if (valB === undefined || valB === null) valB = 0 as never;
    return sortAsc ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
  });

  const bestSpeed = Math.max(...results.map((r) => r.steadySpeed || 0), 0);
  const minTtft = Math.min(...results.filter((r) => r.ttftMs > 0).map((r) => r.ttftMs), 999999);

  /**
   * 切换排序字段
   *
   * @param key 排序键名
   */
  const handleSort = (key: keyof SpeedtestResult) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === "ttftMs");
    }
  };

  /**
   * 计算 TTFT 性能评级说明与视觉样式
   *
   * @param ms 首包延迟毫秒数
   * @return 包含直观文本与悬浮提示的评级对象
   */
  const getTtftGrade = (ms: number) => {
    if (ms <= 0) {
      return {
        label: t("calculating"),
        tip: t("calculating"),
        color: "text-text-muted bg-surface-2 border-border",
      };
    }
    if (ms < 500) {
      return {
        label: t("gradeFast"),
        tip: `${t("gradeFast")} (< 500ms)`,
        color: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
      };
    }
    if (ms < 1500) {
      return {
        label: t("gradeGood"),
        tip: `${t("gradeGood")} (500 - 1500ms)`,
        color: "text-primary bg-primary/10 border-primary/30",
      };
    }
    if (ms < 3000) {
      return {
        label: t("gradeMedium"),
        tip: `${t("gradeMedium")} (1500 - 3000ms)`,
        color: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30",
      };
    }
    return {
      label: t("gradeSlow"),
      tip: `${t("gradeSlow")} (> 3000ms)`,
      color: "text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/30",
    };
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* 状态一：正在运行中的高刷新遥测 HUD */}
      {isRunning && (
        <div className="flex flex-col gap-4 p-4 sm:p-5 rounded-2xl bg-surface border border-primary/40 shadow-[var(--shadow-warm)] dark:shadow-[0_0_50px_rgba(6,182,212,0.15)] relative overflow-hidden transition-colors">
          {/* 顶部动态扫描光带 */}
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent animate-pulse" />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="relative flex size-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full size-2.5 bg-primary" />
              </span>
              <div>
                <span className="text-[10px] uppercase font-mono text-primary tracking-wider font-semibold">
                  {t("runningStatus")}
                </span>
                <h3 className="text-xs sm:text-sm font-semibold text-text-main truncate max-w-md">
                  {currentLabel}
                </h3>
              </div>
            </div>

            <span className="text-xs font-mono px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
              {currentIndex + 1} / {totalItems}
            </span>
          </div>

          {/* 核心四大实时指标仪表卡片（彻底杜绝压缩折行，自适应精致微排版） */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            {/* TTFT 首包（数值与单位基线绝对对齐，无圆点轻量微标签置于标题行右侧，杜绝任何截断压缩） */}
            <div className="flex flex-col justify-between p-2 sm:p-2.5 rounded-xl bg-surface-2 border border-border min-w-0">
              <div className="flex items-center justify-between text-[11px] text-text-muted whitespace-nowrap min-w-0 gap-1">
                <span className="font-sans font-medium whitespace-nowrap shrink-0" title={t("ttftLabel")}>
                  {t("ttftCardTitle") || "首包延迟"}
                </span>
                {currentProgress?.ttftMs ? (
                  <span
                    className={`text-[9.5px] px-1.5 py-0.2 rounded font-sans font-medium shrink-0 border cursor-default select-none leading-normal ${getTtftGrade(currentProgress.ttftMs).color}`}
                    title={getTtftGrade(currentProgress.ttftMs).tip}
                  >
                    {getTtftGrade(currentProgress.ttftMs).label}
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 whitespace-nowrap mt-1">
                {currentProgress?.ttftMs !== undefined && currentProgress?.ttftMs !== null ? (
                  <div className="flex items-baseline gap-1 whitespace-nowrap min-w-0">
                    <span className="text-base sm:text-lg lg:text-xl font-bold font-mono text-text-main tracking-tight">
                      {currentProgress.ttftMs.toFixed(0)}
                    </span>
                    <span className="text-[11px] font-mono text-text-muted">ms</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 whitespace-nowrap min-w-0 py-0.5">
                    <span className="material-symbols-outlined text-xs text-primary animate-spin shrink-0">progress_activity</span>
                    <span className="text-xs sm:text-sm font-medium text-text-muted whitespace-nowrap truncate">
                      {t("waitingFirstToken")}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* 实时速率 */}
            <div className="flex flex-col justify-between p-2 sm:p-2.5 rounded-xl bg-surface-2 border border-primary/30 min-w-0">
              <div className="text-[11px] text-text-muted whitespace-nowrap truncate">
                {t("speedLabel")}
              </div>
              <div className="min-w-0 whitespace-nowrap mt-1">
                {currentProgress?.currentSpeed ? (
                  <div className="flex items-baseline gap-1 whitespace-nowrap">
                    <span className="text-base sm:text-lg lg:text-xl font-bold font-mono text-primary tracking-tight">
                      {currentProgress.currentSpeed.toFixed(1)}
                    </span>
                    <span className="text-[11px] font-mono text-primary/70">t/s</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 whitespace-nowrap min-w-0 py-0.5">
                    <span className="relative flex size-2 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex rounded-full size-2 bg-primary" />
                    </span>
                    <span className="text-xs sm:text-sm font-medium text-text-muted whitespace-nowrap truncate">
                      {t("calculating")}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* 已生成 Tokens */}
            <div className="flex flex-col justify-between p-2 sm:p-2.5 rounded-xl bg-surface-2 border border-border min-w-0">
              <div className="text-[11px] text-text-muted whitespace-nowrap truncate">
                {t("tokensLabel")}
              </div>
              <div className="flex items-baseline gap-1 whitespace-nowrap min-w-0 mt-1">
                <span className="text-base sm:text-lg lg:text-xl font-bold font-mono text-text-main tracking-tight">
                  {currentProgress?.currentTokenCount || 0}
                </span>
                <span className="text-[11px] font-mono text-text-muted">tokens</span>
              </div>
            </div>

            {/* 持续耗时 */}
            <div className="flex flex-col justify-between p-2 sm:p-2.5 rounded-xl bg-surface-2 border border-border min-w-0">
              <div className="text-[11px] text-text-muted whitespace-nowrap truncate">
                {t("elapsedLabel")}
              </div>
              <div className="flex items-baseline gap-1 whitespace-nowrap min-w-0 mt-1">
                <span className="text-base sm:text-lg lg:text-xl font-bold font-mono text-text-main tracking-tight">
                  {currentProgress?.elapsedMs ? (currentProgress.elapsedMs / 1000).toFixed(2) : "0.00"}
                </span>
                <span className="text-[11px] font-mono text-text-muted">s</span>
              </div>
            </div>
          </div>

          {/* 实时速度波形折线图 */}
          <div className="flex flex-col gap-1.5 pt-1">
            <div className="flex items-center justify-between text-xs text-text-muted font-mono">
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-primary" />
                {t("sparklineTitle")}
              </span>
              <span>{t("sparklineSubtitle")}</span>
            </div>
            <div className="p-2 sm:p-3 rounded-xl bg-surface-2 border border-border">
              {livePoints.length > 0 ? (
                <SpeedtestSparkline points={livePoints} height={140} />
              ) : (
                <div
                  className="flex flex-col items-center justify-center gap-1.5 rounded-lg bg-surface/30 border border-dashed border-border/80 text-text-muted select-none"
                  style={{ height: 140 }}
                >
                  <div className="flex items-center gap-2 text-xs font-medium text-primary">
                    <span className="material-symbols-outlined text-sm animate-spin">sync</span>
                    <span className="whitespace-nowrap">正在建立高速流式管道，等待首包吐词以绘制实时波形...</span>
                  </div>
                  <span className="text-[10px] text-text-muted font-mono whitespace-nowrap">
                    16ms 硬件级动态采样引擎待命中
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 状态二：已完成评测的横向对比矩阵 */}
      {results.length > 0 && (
        <div className="flex flex-col gap-3 p-4 sm:p-5 rounded-2xl bg-surface border border-border shadow-[var(--shadow-warm)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.5)] transition-colors">
          <div className="flex items-center justify-between pb-2.5 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center size-7 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <span className="material-symbols-outlined text-base">leaderboard</span>
              </div>
              <h3 className="text-xs sm:text-sm font-semibold text-text-main tracking-wide uppercase">
                {t("matrixTitle")} ({results.length})
              </h3>
            </div>
            <span className="text-[11px] text-text-muted font-mono">{t("matrixSortTip")}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[760px] w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border text-text-muted font-mono text-[11px] whitespace-nowrap">
                  <th className="py-2.5 px-3 font-medium whitespace-nowrap">{t("colModelPath")}</th>
                  <th
                    className="py-2.5 px-3 font-medium cursor-pointer hover:text-primary select-none whitespace-nowrap"
                    onClick={() => handleSort("ttftMs")}
                  >
                    {t("colTtft")} {sortKey === "ttftMs" ? (sortAsc ? "▲" : "▼") : ""}
                  </th>
                  <th
                    className="py-2.5 px-3 font-medium cursor-pointer hover:text-primary select-none whitespace-nowrap"
                    onClick={() => handleSort("steadySpeed")}
                  >
                    {t("colSteadySpeed")} {sortKey === "steadySpeed" ? (sortAsc ? "▲" : "▼") : ""}
                  </th>
                  <th
                    className="py-2.5 px-3 font-medium cursor-pointer hover:text-primary select-none whitespace-nowrap"
                    onClick={() => handleSort("avgSpeed")}
                  >
                    {t("colAvgSpeed")} {sortKey === "avgSpeed" ? (sortAsc ? "▲" : "▼") : ""}
                  </th>
                  <th className="py-2.5 px-3 font-medium whitespace-nowrap">{t("colChunkP50P95")}</th>
                  <th className="py-2.5 px-3 font-medium whitespace-nowrap">{t("colJitterRatio")}</th>
                  <th className="py-2.5 px-3 font-medium text-center whitespace-nowrap">{t("colCurve")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-mono">
                {sortedResults.map((r) => {
                  const isTopSpeed = r.steadySpeed === bestSpeed && bestSpeed > 0;
                  const isLowestTtft = r.ttftMs === minTtft && minTtft < 999999;

                  return (
                    <tr
                      key={r.sessionId}
                      className={`hover:bg-surface-2 transition-colors ${
                        r.isGateway ? "bg-primary/5" : ""
                      }`}
                    >
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5 whitespace-nowrap">
                            <span className="font-semibold text-text-main max-w-[220px] truncate" title={r.model}>
                              {r.model}
                            </span>
                            {r.isGateway ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 font-sans shrink-0 font-medium">
                                {t("gatewayTag")}
                              </span>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-sans shrink-0 font-medium">
                                {t("directTag")}
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-text-muted font-sans truncate max-w-[240px]" title={r.provider || ""}>
                            {r.provider}
                          </span>
                        </div>
                      </td>

                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 whitespace-nowrap">
                          <span className="text-text-main font-bold">{r.ttftMs?.toFixed(0)} ms</span>
                          {isLowestTtft && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-sans shrink-0 font-medium">
                              {t("fastestTag")}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 whitespace-nowrap">
                          <span className="text-primary font-bold text-sm">
                            {r.steadySpeed?.toFixed(1)} t/s
                          </span>
                          {isTopSpeed && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-primary/10 text-primary font-sans shrink-0 font-medium">
                              {t("topSpeedTag")}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-2.5 px-3 text-text-muted whitespace-nowrap">
                        {r.avgSpeed?.toFixed(1)} t/s
                      </td>

                      <td className="py-2.5 px-3 text-text-muted whitespace-nowrap">
                        {r.chunkMetrics?.p50Ms?.toFixed(0)} / {r.chunkMetrics?.p95Ms?.toFixed(0)} ms
                      </td>

                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {r.chunkMetrics?.jitterRatio ? (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                              r.chunkMetrics.jitterRatio > 3
                                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold"
                                : "bg-surface-2 text-text-muted"
                            }`}
                          >
                            {r.chunkMetrics.jitterRatio.toFixed(2)}x
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>

                      <td className="py-2.5 px-3 w-32 whitespace-nowrap">
                        <SpeedtestSparkline
                          points={r.curvePoints || []}
                          height={36}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
