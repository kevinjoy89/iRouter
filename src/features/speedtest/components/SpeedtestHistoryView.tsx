"use client";

import React, { useState, useEffect } from "react";
import SpeedtestSparkline from "./SpeedtestSparkline";
import { useSpeedtestI18n } from "../i18n";
import type { SpeedtestResult, SpeedtestStatsItem } from "../types";

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
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
   * 导出全部历史数据为 JSONL 文件
   */
  const handleExport = () => {
    window.open("/api/speedtest?action=export", "_blank");
  };

  /**
   * 清空全部历史记录
   */
  const handleClear = async () => {
    if (!window.confirm("确定要清空全部本地测速历史数据吗？此操作无法撤销。")) {
      return;
    }
    try {
      const res = await fetch("/api/speedtest", { method: "DELETE" });
      if (res.ok) {
        fetchData();
      }
    } catch (err) {
      console.error("清理测速记录失败:", err);
    }
  };

  const maxLadderSpeed = Math.max(...stats.map((s) => s.avgSteadySpeed || 0), 10);

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
            {stats.map((s, idx) => {
              const pct = Math.min(100, Math.max(8, (s.avgSteadySpeed / maxLadderSpeed) * 100));
              const isFirst = idx === 0;

              return (
                <div key={idx} className="flex flex-col gap-1 p-2 rounded-xl bg-surface-2 border border-border">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className={`font-mono text-xs font-bold px-1.5 py-0.2 rounded ${
                          isFirst
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30"
                            : "bg-surface text-text-muted border border-border"
                        }`}
                      >
                        #{idx + 1}
                      </span>
                      <span className="font-semibold text-text-main font-mono truncate" title={formatFullModelId(s.model)}>
                        {formatFullModelId(s.model)}
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
                      className={`h-full rounded-full transition-all duration-700 ${
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
              <span className="text-[10px] text-text-muted font-mono">{t("historySubtitle")}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-2.5 py-1.5 rounded-lg border border-border bg-surface-2 hover:bg-surface text-xs font-medium text-text-main transition-colors flex items-center gap-1 disabled:opacity-40"
              onClick={handleExport}
              disabled={history.length === 0}
            >
              <span className="material-symbols-outlined text-sm text-primary">download</span>
              {t("btnExportJsonl")}
            </button>
            <button
              type="button"
              className="px-2.5 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-xs font-medium text-rose-600 dark:text-rose-400 transition-colors flex items-center gap-1 disabled:opacity-40"
              onClick={handleClear}
              disabled={history.length === 0}
            >
              <span className="material-symbols-outlined text-sm">delete</span>
              {t("btnClearHistory")}
            </button>
          </div>
        </div>

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
                    const isExpanded = Boolean(expandedId && expandedId === rowKey);
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
                            className="text-xs text-primary hover:underline font-sans cursor-pointer"
                            onClick={() => setExpandedId(isExpanded ? null : rowKey)}
                          >
                            {isExpanded ? t("btnCollapseCurve") : t("btnExpandCurve")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 展开的 Sparkline 曲线抽屉 */}
            {expandedId && (
              <div className="p-3 bg-surface-2 rounded-xl border border-border mt-1">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-mono text-primary flex items-center gap-2">
                    <span>{t("sparklineTitle")}</span>
                    {(() => {
                      const item = history.find((h) => (((h as unknown as { id?: string }).id) || h.sessionId) === expandedId);
                      return item ? <span className="text-text-muted text-[11px] font-sans">({item.model})</span> : null;
                    })()}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-text-muted hover:text-text-main"
                    onClick={() => setExpandedId(null)}
                  >
                    {t("btnCollapseCurve")}
                  </button>
                </div>
                <SpeedtestSparkline
                  points={history.find((h) => (((h as unknown as { id?: string }).id) || h.sessionId) === expandedId)?.curvePoints || []}
                  height={90}
                />
              </div>
            )}

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
    </div>
  );
}
