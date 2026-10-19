"use client";

import React, { useState } from "react";
import SpeedtestSparkline from "./SpeedtestSparkline";
import Modal from "@/shared/components/Modal";
import { useSpeedtestI18n } from "../i18n";
import type { SpeedtestRunnerError } from "../runnerStore";
import type { SpeedtestProgress, SpeedtestResult, CurvePoint } from "../types";

/**
 * 模态框通用组件类型适配器
 */
const ModalDialog = Modal as unknown as React.FC<{
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  size?: string;
  children?: React.ReactNode;
}>;

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
  /** 运行期捕获的最近一次错误信息 */
  lastError?: SpeedtestRunnerError | null;
  /** 清除错误提示回调函数 */
  onClearError?: () => void;
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
  lastError: _lastError = null,
  onClearError: _onClearError,
}: SpeedtestBatchViewProps) {
  const { t } = useSpeedtestI18n();

  const [sortKey, setSortKey] = useState<keyof SpeedtestResult>("steadySpeed");
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [modalItem, setModalItem] = useState<SpeedtestResult | null>(null);

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
              <span className="text-[11px] text-text-muted/80">高频流式采样</span>
            </div>
            <div className="p-2 sm:p-3 rounded-xl bg-surface-2 border border-border w-full">
              {livePoints.length > 0 ? (
                <SpeedtestSparkline points={livePoints} height={240} />
              ) : (
                <div
                  className="flex flex-col items-center justify-center gap-2 rounded-lg bg-surface/30 border border-dashed border-border/80 text-text-muted select-none w-full"
                  style={{ height: 240 }}
                >
                  <div className="flex items-center gap-2 text-xs font-medium text-primary">
                    <span className="material-symbols-outlined text-sm animate-spin">sync</span>
                    <span className="whitespace-nowrap">正在建立高速流式管道，等待首包吐词以绘制实时波形...</span>
                  </div>
                  <span className="text-[10px] text-text-muted font-mono whitespace-nowrap">
                    动态高频流式采样已就绪
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
                  const isFailed = !r.success;
                  const isTopSpeed = !isFailed && r.steadySpeed === bestSpeed && bestSpeed > 0;
                  const isLowestTtft = !isFailed && r.ttftMs === minTtft && minTtft < 999999;
                  // 根据模型评测特征赋予鲜明区隔度主题色：
                  // - 失败条目：醒目玫瑰红 #f43f5e (rose-500)
                  // - 矩阵冠军（最高速度）：亮橙色 #f97316 (orange-500)
                  // - 网关转发模式：紫罗兰/靛蓝 #6366f1 (indigo-500)
                  // - 专线直连模式：科技青蓝 #0ea5e9 (sky-500)
                  const curveColor = isFailed
                    ? "#f43f5e"
                    : isTopSpeed
                    ? "#f97316"
                    : r.isGateway
                    ? "#6366f1"
                    : "#0ea5e9";

                  return (
                    <tr
                      key={r.sessionId}
                      className={`hover:bg-surface-2 transition-colors ${
                        isFailed ? "bg-rose-500/5" : r.isGateway ? "bg-primary/5" : ""
                      }`}
                    >
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5 whitespace-nowrap">
                            <span className="font-semibold text-text-main max-w-[220px] truncate" title={r.model}>
                              {r.model}
                            </span>
                            {isFailed ? (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 font-sans shrink-0 font-medium"
                                title={r.errorMessage || "评测异常失败"}
                              >
                                失败
                              </span>
                            ) : r.isGateway ? (
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
                        {isFailed ? (
                          <span className="text-text-muted/60 text-xs" title={r.errorMessage || "评测失败"}>
                            -
                          </span>
                        ) : (
                          <div className="flex items-center gap-1.5 whitespace-nowrap">
                            <span className="text-text-main font-bold">{r.ttftMs?.toFixed(0)} ms</span>
                            {isLowestTtft && (
                              <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-sans shrink-0 font-medium">
                                {t("fastestTag")}
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      <td className="py-2.5 px-3 text-text-muted whitespace-nowrap">
                        {isFailed ? (
                          <span className="text-text-muted/60 text-xs">-</span>
                        ) : (
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
                        )}
                      </td>

                      <td className="py-2.5 px-3 text-text-muted whitespace-nowrap">
                        {isFailed ? "-" : `${r.avgSpeed?.toFixed(1)} t/s`}
                      </td>

                      <td className="py-2.5 px-3 text-text-muted whitespace-nowrap">
                        {isFailed ? "-" : `${r.chunkMetrics?.p50Ms?.toFixed(0)} / ${r.chunkMetrics?.p95Ms?.toFixed(0)} ms`}
                      </td>

                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {!isFailed && r.chunkMetrics?.jitterRatio ? (
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
                        {isFailed ? (
                          <button
                            type="button"
                            className="flex items-center justify-center gap-1 w-full py-1.5 px-2 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-[11px] font-sans font-medium transition-colors"
                            onClick={() => setModalItem(r)}
                            title={r.errorMessage || "查看失败详情"}
                          >
                            <span className="material-symbols-outlined text-xs">info</span>
                            <span>查看报错</span>
                          </button>
                        ) : (
                          <div
                            role="button"
                            tabIndex={0}
                            aria-label="查看波形图"
                            onClick={() => setModalItem(r)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setModalItem(r);
                              }
                            }}
                            className="group relative cursor-pointer rounded-md p-1 -m-1 transition-all hover:bg-surface-2 border border-transparent hover:border-border/60"
                            title="点击放大查看高清波形与抖动分析"
                          >
                            <SpeedtestSparkline
                              points={r.curvePoints || []}
                              height={36}
                              color={curveColor}
                            />
                            <div className="absolute inset-0 flex items-center justify-center rounded-md bg-surface/40 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:opacity-100">
                              <span className="material-symbols-outlined text-xs text-primary font-bold">zoom_in</span>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 矩阵单项高清波形与延迟离散度深度分析模态弹窗 */}
      <ModalDialog
        isOpen={Boolean(modalItem)}
        onClose={() => setModalItem(null)}
        title={modalItem?.success === false ? "模型评测异常详情" : "模型评测波形分析"}
        size="lg"
      >
        {modalItem && (
          <div className="flex flex-col gap-4 text-xs font-sans">
            {/* 顶部模型基本信息与核心指标 */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-surface-2 border border-border">
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-text-main font-bold text-sm truncate">
                    {modalItem.model}
                  </span>
                  {modalItem.success === false ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border font-mono border-rose-500/30 text-rose-600 dark:text-rose-400 bg-rose-500/10">
                      评测失败
                    </span>
                  ) : (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                        modalItem.isGateway
                          ? "border-indigo-500/30 text-indigo-600 dark:text-indigo-400 bg-indigo-500/10"
                          : "border-sky-500/30 text-sky-600 dark:text-sky-400 bg-sky-500/10"
                      }`}
                    >
                      {modalItem.isGateway ? t("gatewayTag") : t("directTag")}
                    </span>
                  )}
                </div>
                <span className="text-text-muted text-[11px] font-sans truncate max-w-md">
                  {modalItem.provider || "-"} {modalItem.gatewayUrl ? `· ${modalItem.gatewayUrl}` : ""}
                </span>
              </div>
              {modalItem.success !== false && (
                <div className="flex items-center gap-4 shrink-0">
                  <div className="flex flex-col text-right">
                    <span className="text-text-muted text-[10px]">TTFT</span>
                    <span className="text-text-main font-semibold">{modalItem.ttftMs?.toFixed(0)} ms</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="text-text-muted text-[10px]">净稳定速度</span>
                    <span className="text-primary font-bold text-sm">{modalItem.steadySpeed?.toFixed(1)} t/s</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="text-text-muted text-[10px]">输出 Tokens</span>
                    <span className="text-text-main font-semibold">{modalItem.outputTokens}</span>
                  </div>
                </div>
              )}
            </div>

            {/* 失败项专属报错卡片展示 */}
            {modalItem.success === false && (
              <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400">
                <span className="material-symbols-outlined text-base shrink-0 mt-0.5">error</span>
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <span className="font-semibold text-text-main text-xs sm:text-sm">
                    评测执行失败原因
                  </span>
                  <div className="font-mono text-[11px] leading-relaxed break-all select-all p-2.5 rounded-lg bg-surface/70 border border-border/50 text-text-main">
                    {modalItem.errorMessage || "未获取到返回数据，上游网络超时或连接失败"}
                  </div>
                </div>
              </div>
            )}

            {/* 高清波形图容器（仅成功采集到波形数据时展示） */}
            {modalItem.success !== false && (
              <div className="flex flex-col gap-2 p-3.5 rounded-xl bg-surface border border-border">
                <div className="flex items-center justify-between text-text-muted text-[11px] font-sans">
                  <span className="font-semibold text-text-main flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-primary text-sm">ssid_chart</span>
                    {t("sparklineTitle")}
                  </span>
                  <span className="font-mono text-[10px]">高频流式采样</span>
                </div>
                <SpeedtestSparkline
                  points={modalItem.curvePoints || []}
                  height={180}
                  color={
                    modalItem.steadySpeed === bestSpeed && bestSpeed > 0
                      ? "#f97316"
                      : modalItem.isGateway
                      ? "#6366f1"
                      : "#0ea5e9"
                  }
                />
              </div>
            )}

            {/* 块延迟与离散度指标（成功时展示） */}
            {modalItem.success !== false && modalItem.chunkMetrics && (
              <div className="grid grid-cols-3 gap-2.5 text-center">
                <div className="p-2.5 rounded-xl bg-surface-2 border border-border">
                  <span className="text-text-muted text-[10px] block">Chunk P50</span>
                  <span className="text-text-main font-bold text-xs mt-0.5 block">{modalItem.chunkMetrics.p50Ms?.toFixed(1)} ms</span>
                </div>
                <div className="p-2.5 rounded-xl bg-surface-2 border border-border">
                  <span className="text-text-muted text-[10px] block">Chunk P95</span>
                  <span className="text-text-main font-bold text-xs mt-0.5 block">{modalItem.chunkMetrics.p95Ms?.toFixed(1)} ms</span>
                </div>
                <div className="p-2.5 rounded-xl bg-surface-2 border border-border">
                  <span className="text-text-muted text-[10px] block">间隔离散比</span>
                  <span className="text-text-main font-bold text-xs mt-0.5 block">{modalItem.chunkMetrics.jitterRatio?.toFixed(2) ?? "-"}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </ModalDialog>
    </div>
  );
}
