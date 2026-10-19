"use client";

import React, { useState, useEffect, useRef } from "react";
import SpeedtestSparkline from "./SpeedtestSparkline";
import SpeedtestNoticeBar from "./SpeedtestNoticeBar";
import Modal from "@/shared/components/Modal";
import { useSpeedtestI18n } from "../i18n";
import { useNotificationStore } from "@/store/notificationStore";
import type { SpeedtestResult, SpeedtestStatsItem } from "../types";

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
 * 供应商与前缀对应映射表（规范化历史数据中显示名称与接入前缀的对应关系）
 */
const KNOWN_PROVIDER_PREFIXES: Record<string, string> = {
  "agnes ai": "agnes",
  agnes: "agnes",
  opencsg: "ocsg",
  ocsg: "ocsg",
  "商汤日日新": "sensenova",
  sensenova: "sensenova",
  "codebuddy cn": "codebuddy-cn",
  codebuddy: "codebuddy-cn",
  "基元律动": "tokenrhythm",
  tokenrhythm: "tokenrhythm",
  aihub: "aihub",
  antdigital: "ant",
  ant: "ant",
  senseaudio: "senseaudio",
  qimeng: "qimeng",
  tokenrouter: "tr",
  stepfun: "stepfun",
  heading: "hd",
  "share llm": "sharellm",
  "charm™ hyper": "chyper",
  deepseek: "deepseek",
  ollama: "ollama",
  nvidia: "nvidia",
  gemini: "gemini",
  openrouter: "openrouter",
  "opencode-go": "opencode-go",
};

/**
 * 格式化输出完整的模型路径标识（如 agnes/agnes-3.0-flash）
 *
 * @param model 模型名称
 * @param provider 供应商名称或标识
 * @return 规整后的完整模型标识
 * @author iRouter
 * @since 2026-10-16
 */
function formatFullModelId(model: string, provider?: string): string {
  if (!model) return "-";

  // 若模型名已经包含前缀（如 "agnes ai/agnes-3.0-flash" 或 "openai-compatible-.../model"）
  if (model.includes("/")) {
    const slashIdx = model.indexOf("/");
    const rawPrefix = model.slice(0, slashIdx).trim().toLowerCase();
    const subModel = model.slice(slashIdx + 1);

    if (KNOWN_PROVIDER_PREFIXES[rawPrefix]) {
      return `${KNOWN_PROVIDER_PREFIXES[rawPrefix]}/${subModel}`;
    }

    if (rawPrefix.startsWith("openai-compatible") || rawPrefix.startsWith("anthropic-compatible")) {
      if (provider) {
        const pKey = provider.split("·")[0].trim().toLowerCase();
        const resolvedPrefix = KNOWN_PROVIDER_PREFIXES[pKey] || pKey.replace(/ai$/i, "").trim().replace(/[^a-z0-9_-]/g, "");
        if (resolvedPrefix) {
          return `${resolvedPrefix}/${subModel}`;
        }
      }
    }

    return model;
  }

  // 若模型名不含斜杠，则结合 provider 补全前缀
  if (provider && provider !== "Custom") {
    const pKey = provider.split("·")[0].trim().toLowerCase();
    const resolvedPrefix = KNOWN_PROVIDER_PREFIXES[pKey] || pKey.replace(/ai$/i, "").trim().replace(/[^a-z0-9_-]/g, "");
    if (resolvedPrefix) {
      return `${resolvedPrefix}/${model}`;
    }
  }

  return model;
}

/**
 * 测速历史记录与趋势分析看板组件 (TSX)
 *
 * @author iRouter
 * @since 2026-10-16
 */
export default function SpeedtestHistoryView() {
  const { t } = useSpeedtestI18n();

  const [history, setHistory] = useState<SpeedtestResult[]>([]);
  const [stats, setStats] = useState<SpeedtestStatsItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);
  const [statsPage, setStatsPage] = useState<number>(1);
  const [modalItem, setModalItem] = useState<SpeedtestResult | null>(null);
  const [exporting, setExporting] = useState<boolean>(false);
  const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false);
  const [clearing, setClearing] = useState<boolean>(false);
  const [exportNotice, setExportNotice] = useState<{
    type: "success" | "error";
    message: string;
    path?: string;
  } | null>(null);
  const awaitingExportPathRef = useRef<boolean>(false);
  const exportFallbackTimerRef = useRef<NodeJS.Timeout | null>(null);
  const STATS_PAGE_SIZE = 10;

  // 监听 Tauri 桌面端壳层回报的真实落盘绝对路径（单次精准提示，杜绝重复弹出）
  useEffect(() => {
    const api =
      typeof window !== "undefined"
        ? (window as unknown as { irouterShell?: { onDownloadSaved?: (cb: (payload: { path?: string }) => void) => () => void } }).irouterShell
        : null;
    if (!api?.onDownloadSaved) return undefined;

    const unlisten = api.onDownloadSaved((payload) => {
      if (!awaitingExportPathRef.current) return;
      awaitingExportPathRef.current = false;

      // 收到壳层绝对路径，清除兜底定时器
      if (exportFallbackTimerRef.current) {
        clearTimeout(exportFallbackTimerRef.current);
        exportFallbackTimerRef.current = null;
      }

      const savedPath = payload?.path;
      if (!savedPath) return;

      setExportNotice({
        type: "success",
        message: "评测历史记录已导出完成",
        path: savedPath,
      });
      useNotificationStore.getState().success(`文件已保存至：${savedPath}`, "导出成功");
    });

    return () => {
      if (typeof unlisten === "function") unlisten();
      if (exportFallbackTimerRef.current) {
        clearTimeout(exportFallbackTimerRef.current);
        exportFallbackTimerRef.current = null;
      }
    };
  }, []);

  /**
   * 刷新拉取历史记录与聚合统计数据
   */
  const fetchData = async () => {
    setLoading(true);
    try {
      const [histRes, statsRes] = await Promise.all([
        fetch(`/api/speedtest?page=${page}&limit=10`),
        fetch("/api/speedtest?action=stats"),
      ]);

      if (histRes.ok) {
        const histData = await histRes.json();
        setHistory(histData.records || []);
        setTotal(histData.total || 0);
      }
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData.stats || []);
      }
    } catch (err) {
      console.error("加载测速看板数据失败:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [page]);

  /**
   * 在当前页面直接下载 JSONL 格式历史记录文件并反馈保存路径
   */
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const res = await fetch("/api/speedtest?action=export");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const fileName = `speedtest-history-${new Date().toISOString().slice(0, 10)}.jsonl`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;

      // 检测是否具备桌面端壳层落盘回调能力
      const hasDesktopShell =
        typeof window !== "undefined" &&
        Boolean(
          (window as unknown as { irouterShell?: { onDownloadSaved?: unknown } }).irouterShell?.onDownloadSaved
        );

      if (hasDesktopShell) {
        // 桌面端环境：置位等待标志，由 onDownloadSaved 回调触发唯一的一条真实落盘通知
        awaitingExportPathRef.current = true;
        if (exportFallbackTimerRef.current) {
          clearTimeout(exportFallbackTimerRef.current);
        }
        // 兜底保护：若壳层在 3 秒内未回执，降级弹出单次通知
        exportFallbackTimerRef.current = setTimeout(() => {
          if (awaitingExportPathRef.current) {
            awaitingExportPathRef.current = false;
            const fallbackPath = `~/Downloads/${fileName}`;
            setExportNotice({
              type: "success",
              message: `评测历史记录已导出为 ${fileName}`,
              path: fallbackPath,
            });
            useNotificationStore.getState().success(`文件已保存至：${fallbackPath}`, "导出成功");
          }
        }, 3000);
      } else {
        // 纯 Web 浏览器环境：无壳层回调，直接触发唯一单次通知
        const defaultPath = `~/Downloads/${fileName}`;
        setExportNotice({
          type: "success",
          message: `评测历史记录已导出为 ${fileName}`,
          path: defaultPath,
        });
        useNotificationStore.getState().success(`文件已保存至：${defaultPath}`, "导出成功");
      }

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("导出测速记录失败:", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      setExportNotice({
        type: "error",
        message: `导出失败：${errMsg}`,
      });
      useNotificationStore.getState().error(`导出失败：${errMsg}`, "导出异常");
    } finally {
      setExporting(false);
    }
  };

  /**
   * 确认执行清空历史审计记录（天梯榜聚合统计永久保留）
   */
  const handleExecuteClear = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/speedtest", { method: "DELETE" });
      if (res.ok) {
        setShowClearConfirm(false);
        setPage(1);
        fetchData();
      }
    } catch (err) {
      console.error("清理测速记录失败:", err);
    } finally {
      setClearing(false);
    }
  };

  const maxLadderSpeed = Math.max(...stats.map((s) => s.avgSteadySpeed || 0), 10);
  const totalStatsPages = Math.max(1, Math.ceil(stats.length / STATS_PAGE_SIZE));
  const currentStatsPage = Math.min(Math.max(1, statsPage), totalStatsPages);
  const paginatedStats = stats.slice(
    (currentStatsPage - 1) * STATS_PAGE_SIZE,
    currentStatsPage * STATS_PAGE_SIZE
  );

  return (
    <div className="flex flex-col gap-5 text-text-main">
      {/* 顶部天梯榜统计卡片 */}
      {stats.length > 0 && (
        <div className="flex flex-col gap-3.5 p-4 sm:p-5 rounded-2xl bg-surface border border-border shadow-[var(--shadow-warm)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.5)] transition-colors">
          <div className="flex items-center justify-between pb-2.5 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center size-7 rounded-lg bg-primary/10 text-primary border border-primary/20">
                <span className="material-symbols-outlined text-base">monitoring</span>
              </div>
              <div>
                <h3 className="text-xs sm:text-sm font-semibold text-text-main tracking-wide uppercase">
                  {t("leaderboardTitle")}
                </h3>
                <span className="text-[10px] text-text-muted font-mono">
                  {t("leaderboardSubtitle")}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {paginatedStats.map((s, idx) => {
              const rank = (currentStatsPage - 1) * STATS_PAGE_SIZE + idx + 1;
              const pct = Math.min(100, Math.max(8, (s.avgSteadySpeed / maxLadderSpeed) * 100));
              const isFirst = rank === 1;
              const itemKey = `${s.model}__${s.gatewayUrl || "direct"}`;
              const isGateway = Boolean(
                s.gatewayUrl &&
                (s.gatewayUrl.includes("127.0.0.1") ||
                  s.gatewayUrl.includes("localhost") ||
                  s.gatewayUrl.includes(":20128"))
              );

              return (
                <div key={itemKey} className="flex flex-col gap-1 p-2 rounded-xl bg-surface-2 border border-border">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className={`font-mono text-xs font-bold px-1.5 py-0.2 rounded ${
                          isFirst
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30"
                            : "bg-surface text-text-muted border border-border"
                        }`}
                      >
                        #{rank}
                      </span>
                      <span
                        className="font-semibold text-text-main font-mono truncate"
                        title={`${formatFullModelId(s.model)} (${s.gatewayUrl || (isGateway ? t("gatewayTag") : t("directTag"))})`}
                      >
                        {formatFullModelId(s.model)}
                      </span>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded border font-mono shrink-0 font-medium ${
                          isGateway
                            ? "border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10"
                            : "border-blue-500/30 text-blue-600 dark:text-blue-400 bg-blue-500/10"
                        }`}
                      >
                        {isGateway ? t("gatewayTag") : t("directTag")}
                      </span>
                      <span className="text-[10px] text-text-muted">({s.runCount})</span>
                    </div>
                    <div className="flex items-center gap-3 font-mono shrink-0">
                      <span className="text-text-muted text-[11px]">TTFT ~{s.avgTtft}ms</span>
                      <span className="font-bold text-primary text-xs sm:text-sm">{s.avgSteadySpeed} t/s</span>
                    </div>
                  </div>

                  <div className="w-full h-1.5 rounded-full bg-surface border border-border overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-200 ${
                        isFirst
                          ? "bg-primary shadow-sm"
                          : "bg-text-muted/40"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* 天梯榜分页控制条 */}
          {stats.length > STATS_PAGE_SIZE && (
            <div className="flex items-center justify-between pt-2.5 border-t border-border text-xs text-text-muted font-mono">
              <span>
                {t("totalRecords", { total: stats.length, page: currentStatsPage })}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={currentStatsPage <= 1}
                  className="px-2 py-1 rounded-lg bg-surface border border-border disabled:opacity-30 hover:bg-surface-2 text-text-main"
                  onClick={() => setStatsPage((p) => Math.max(1, p - 1))}
                >
                  {t("prevPage")}
                </button>
                <button
                  type="button"
                  disabled={currentStatsPage >= totalStatsPages}
                  className="px-2 py-1 rounded-lg bg-surface border border-border disabled:opacity-30 hover:bg-surface-2 text-text-main"
                  onClick={() => setStatsPage((p) => Math.min(totalStatsPages, p + 1))}
                >
                  {t("nextPage")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 历史明细表格 */}
      <div className="flex flex-col gap-3.5 p-4 sm:p-5 rounded-2xl bg-surface border border-border shadow-[var(--shadow-warm)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.5)] transition-colors">
        <div className="flex items-center justify-between pb-2.5 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center size-7 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
              <span className="material-symbols-outlined text-base">history</span>
            </div>
            <div>
              <h3 className="text-xs sm:text-sm font-semibold text-text-main tracking-wide uppercase">
                {t("historyTitle")} ({total})
              </h3>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-2.5 py-1.5 rounded-lg border border-border bg-surface-2 hover:bg-surface text-xs font-medium text-text-main transition-colors flex items-center gap-1.5 disabled:opacity-40"
              onClick={handleExport}
              disabled={exporting || total === 0}
            >
              <span className={`material-symbols-outlined text-sm text-primary ${exporting ? "animate-spin" : ""}`}>
                {exporting ? "progress_activity" : "download"}
              </span>
              {t("btnExportJsonl")}
            </button>
            <button
              type="button"
              className="px-2.5 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-xs font-medium text-rose-600 dark:text-rose-400 transition-colors flex items-center gap-1 disabled:opacity-40"
              onClick={() => setShowClearConfirm(true)}
              disabled={total === 0}
            >
              <span className="material-symbols-outlined text-sm">delete</span>
              {t("btnClearHistory")}
            </button>
          </div>
        </div>

        {/* 导出结果交互提示条（复用 SpeedtestNoticeBar 通用组件） */}
        <SpeedtestNoticeBar
          notice={exportNotice}
          onClose={() => setExportNotice(null)}
        />

        {history.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="overflow-x-auto">
              <table className="min-w-[680px] w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border text-text-muted font-mono text-[11px] whitespace-nowrap">
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">{t("colModelEndpoint")}</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">{t("colTtft")}</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">{t("colSteadySpeed")}</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">{t("colOutputTokens")}</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">{t("colRecordedTime")}</th>
                    <th className="py-2.5 px-3 font-medium text-right whitespace-nowrap">{t("colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono">
                  {history.map((row) => {
                    const rowKey = ((row as unknown as { id?: string }).id) || row.sessionId || "";
                    return (
                      <tr key={rowKey} className="hover:bg-surface-2 transition-colors">
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5 whitespace-nowrap">
                              <span
                                className="font-semibold text-text-main max-w-[200px] truncate"
                                title={formatFullModelId(row.model, row.provider)}
                              >
                                {formatFullModelId(row.model, row.provider)}
                              </span>
                              {row.isGateway && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 font-sans shrink-0 font-medium">
                                  {t("gatewayTag")}
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-text-muted truncate block max-w-xs font-sans" title={row.gatewayUrl || ""}>
                              {row.gatewayUrl}
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-text-main whitespace-nowrap">{row.ttftMs?.toFixed(0)} ms</td>
                        <td className="py-2.5 px-3 text-primary font-bold whitespace-nowrap">{row.steadySpeed?.toFixed(1)} t/s</td>
                        <td className="py-2.5 px-3 text-text-muted whitespace-nowrap">{row.outputTokens}</td>
                        <td className="py-2.5 px-3 text-text-muted text-[11px] font-sans whitespace-nowrap">
                          {row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}
                        </td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline font-sans cursor-pointer inline-flex items-center gap-1"
                            onClick={() => setModalItem(row)}
                          >
                            <span className="material-symbols-outlined text-[13px]">show_chart</span>
                            {t("btnCurveChart")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 分页控制 */}
            {total > 10 && (
              <div className="flex items-center justify-between pt-2.5 border-t border-border text-xs text-text-muted font-mono">
                <span>
                  {t("totalRecords", { total, page })}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={page <= 1}
                    className="px-2 py-1 rounded-lg bg-surface border border-border disabled:opacity-30 hover:bg-surface-2 text-text-main"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    {t("prevPage")}
                  </button>
                  <button
                    type="button"
                    disabled={page * 10 >= total}
                    className="px-2 py-1 rounded-lg bg-surface border border-border disabled:opacity-30 hover:bg-surface-2 text-text-main"
                    onClick={() => setPage((p) => p + 1)}
                  >
                    {t("nextPage")}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="py-10 text-center text-xs text-text-muted font-mono">
            {loading ? t("syncingHistory") : t("noHistory")}
          </div>
        )}
      </div>

      {/* 速度波形图弹窗 */}
      <ModalDialog
        isOpen={!!modalItem}
        onClose={() => setModalItem(null)}
        title={t("sparklineModalTitle")}
        size="xl"
      >
        {modalItem && (
          <div className="flex flex-col gap-4 text-xs font-mono">
            {/* 模型与端点信息卡片 */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-surface-2 border border-border">
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-text-main font-bold text-sm truncate">
                    {formatFullModelId(modalItem.model, modalItem.provider)}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                      modalItem.isGateway
                        ? "border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10"
                        : "border-blue-500/30 text-blue-600 dark:text-blue-400 bg-blue-500/10"
                    }`}
                  >
                    {modalItem.isGateway ? t("gatewayTag") : t("directTag")}
                  </span>
                </div>
                <span className="text-text-muted text-[11px] font-sans truncate max-w-md">
                  {modalItem.gatewayUrl || "-"}
                </span>
              </div>
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
            </div>

            {/* 高清波形图容器 */}
            <div className="flex flex-col gap-2 p-3.5 rounded-xl bg-surface border border-border">
              <div className="flex items-center justify-between text-text-muted text-[11px] font-sans">
                <span className="font-semibold text-text-main flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-primary text-sm">ssid_chart</span>
                  {t("sparklineTitle")}
                </span>
                <span className="font-mono text-[10px]">{t("sparklineSubtitle")}</span>
              </div>
              <SpeedtestSparkline
                points={modalItem.curvePoints || []}
                height={180}
              />
            </div>

            {/* 块延迟与离散度指标 */}
            {modalItem.chunkMetrics && (
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

      {/* 清空历史记录二次确认模态弹窗 */}
      <ModalDialog
        isOpen={showClearConfirm}
        onClose={() => !clearing && setShowClearConfirm(false)}
        title="清空评测历史记录"
        size="md"
      >
        <div className="flex flex-col gap-4 text-xs font-sans">
          <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400">
            <span className="material-symbols-outlined text-lg shrink-0 mt-0.5">warning</span>
            <div className="flex flex-col gap-1 leading-relaxed">
              <span className="font-semibold text-text-main">请确认是否清空评测历史记录</span>
              <span>清空操作将仅删除本地评测历史审计日志流水。天梯榜的基准性能聚合统计数据将完整保留不受影响。此操作无法撤销。</span>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              disabled={clearing}
              className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-surface-2 text-text-muted hover:text-text-main font-medium transition-colors"
              onClick={() => setShowClearConfirm(false)}
            >
              取消
            </button>
            <button
              type="button"
              disabled={clearing}
              className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium transition-colors flex items-center gap-1.5"
              onClick={handleExecuteClear}
            >
              {clearing && <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>}
              确认清空
            </button>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
}
