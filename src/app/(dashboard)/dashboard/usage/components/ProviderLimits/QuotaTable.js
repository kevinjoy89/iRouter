"use client";

import { useEffect, useMemo, useState } from "react";
import { translate } from "@/i18n/runtime";
import {
  formatResetTime,
  getRemainingPercentage,
  calculateQuotaPagination,
  DEFAULT_QUOTA_TABLE_PAGE_SIZE as DEFAULT_PAGE_SIZE,
} from "./utils";

/**
 * Format reset time display (Today, 12:00 PM)
 */
function formatResetTimeDisplay(resetTime) {
  if (!resetTime) return null;

  try {
    const date = new Date(resetTime);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let dayStr = "";
    if (date >= today && date < tomorrow) {
      dayStr = translate("Today");
    } else if (date >= tomorrow && date < new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)) {
      dayStr = translate("Tomorrow");
    } else {
      dayStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    return `${dayStr}, ${timeStr}`;
  } catch {
    return null;
  }
}

/**
 * Get color classes based on remaining percentage
 */
function getColorClasses(remainingPercentage) {
  if (remainingPercentage > 70) {
    return {
      text: "text-green-600 dark:text-green-400",
      bg: "bg-green-500",
      bgLight: "bg-green-500/10",
      emoji: "🟢",
    };
  }

  if (remainingPercentage >= 30) {
    return {
      text: "text-yellow-600 dark:text-yellow-400",
      bg: "bg-yellow-500",
      bgLight: "bg-yellow-500/10",
      emoji: "🟡",
    };
  }

  return {
    text: "text-red-600 dark:text-red-400",
    bg: "bg-red-500",
    bgLight: "bg-red-500/10",
    emoji: "🔴",
  };
}

function sortQuotas(quotas, sortMode) {
  if (sortMode === "remaining-asc") {
    return [...quotas].sort((a, b) => a.remaining - b.remaining || a.name.localeCompare(b.name));
  }

  if (sortMode === "remaining-desc") {
    return [...quotas].sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  }

  return quotas;
}

/**
 * 配额表格组件，按表格形态展示配额使用率与重置周期
 *
 * @param {Object} props 组件入参
 * @param {Array} [props.quotas=[]] 配额数据项列表
 * @param {boolean} [props.compact=false] 是否紧凑排版
 * @param {string} [props.sortMode="default"] 排序模式
 * @param {boolean} [props.showSortLabel=false] 是否展示排序标签
 * @param {Function|null} [props.onHideQuota=null] 隐藏配额行回调
 * @param {number} [props.pageSize=DEFAULT_PAGE_SIZE] 每页展示条数，默认为 3 条
 * @return {JSX.Element|null} 配额表格渲染内容
 */
export default function QuotaTable({
  quotas = [],
  compact = false,
  sortMode = "default",
  showSortLabel = false,
  onHideQuota = null,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  const [page, setPage] = useState(1);

  const normalizedQuotas = useMemo(
    () => quotas.map((quota, index) => ({
      ...quota,
      index,
      remaining: getRemainingPercentage(quota),
    })),
    [quotas],
  );

  const sortedQuotas = useMemo(
    () => sortQuotas(normalizedQuotas, sortMode),
    [normalizedQuotas, sortMode],
  );

  // 计算生效的分页信息
  const { totalPages, pageStart, pageEnd, effectivePageSize } = calculateQuotaPagination(
    sortedQuotas.length,
    pageSize,
    page,
  );

  useEffect(() => {
    setPage(1);
  }, [sortMode, quotas]);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, totalPages));
  }, [totalPages]);

  if (!quotas || quotas.length === 0) {
    return null;
  }

  // 截取当前页数据
  const currentPageRows = sortedQuotas.slice(
    (page - 1) * effectivePageSize,
    page * effectivePageSize,
  );

  const cellPad = compact ? "py-1 px-1.5" : "py-2 px-3";
  const nameText = compact ? "text-[11px]" : "text-sm";
  const resetPrimary = compact ? "text-[11px]" : "text-sm";
  const resetSecondary = compact ? "text-[10px] leading-tight" : "text-xs";
  const sortLabel = "Sorted by account remaining";
  const hasHideAction = typeof onHideQuota === "function";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-text-muted">
          {`${sortedQuotas.length} ${sortedQuotas.length > 1 ? "quotas" : "quota"}`}
        </div>
        {showSortLabel && (
          <div className="rounded-md border border-black/10 bg-black/[0.02] px-2 py-1 text-[10px] text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
            {translate(sortLabel)}
          </div>
        )}
      </div>

      <div className="space-y-px">
        {currentPageRows.map((quota) => {
          const isUnlimited = quota.unlimited === true;
          const isCreditBalance = quota.isCreditBalance === true;
          const colors = isCreditBalance
            ? { text: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500", bgLight: "bg-blue-500/10", emoji: "💰" }
            : getColorClasses(quota.remaining);
          // Qoder flags open-ended plans with `neverExpires` (its API reports a
          // year-9999 sentinel). Return "-"/"Never expires" rather than an empty
          // countdown: the render below branches on `countdown !== "-"`, so an
          // empty string would fall through to the "in " label.
          const countdown = quota.neverExpires ? "-" : formatResetTime(quota.resetAt);
          // Providers that expose a detail page but no per-bucket reset date
          // (Qoder add-on grants) get a pointer to it instead of a bare "N/A".
          const seeDetails = !quota.neverExpires && !quota.resetAt && Boolean(quota.detailUrl);
          const resetDisplay = quota.neverExpires
            ? translate("Never expires")
            : seeDetails
              ? translate("See details")
              : formatResetTimeDisplay(quota.resetAt);
          const resetSecondaryText = seeDetails && quota.detailUrl ? quota.detailUrl : resetDisplay;
          // recurring defaults true: a missing flag means the quota
          // refreshes at resetAt. Bonus/one-shot packs set recurring:false
          // and their resetAt is a hard expiry, so word it as "expires".
          const recurring = quota.recurring !== false;
          const countdownLabel = recurring ? `in ${countdown}` : `expires in ${countdown}`;

          // "See details" rows are a link to the provider's own usage page —
          // used where the API exposes no per-bucket date (Qoder add-on grants).
          const renderResetCell = (className) =>
            seeDetails ? (
              <a
                href={quota.detailUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${className} inline-flex items-center gap-0.5 hover:text-text-primary hover:underline`}
                title={`Open usage details: ${resetSecondaryText}`}
                aria-label={`Open usage details for ${quota.name}`}
              >
                {resetDisplay}
                <span className="material-symbols-outlined text-[12px]">open_in_new</span>
              </a>
            ) : (
              resetDisplay
            );

          return (
            <div
              key={`${quota.name}-${quota.index}`}
              className={`flex items-center gap-2 border-b border-black/5 dark:border-white/5 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors ${cellPad}`}
            >
              {/* Name */}
              <div className="flex w-36 min-w-0 items-center gap-1.5">
                <span className="text-[10px] shrink-0">{colors.emoji}</span>
                <span className={`${nameText} font-medium text-text-main truncate`}>
                  {translate(quota.name)}
                </span>
              </div>

              {/* Progress + used/total */}
              <div className={`min-w-0 flex-1 ${compact ? "space-y-1" : "space-y-1.5"}`}>
                {!isUnlimited && !isCreditBalance && (
                <div className={`${compact ? "h-1" : "h-1.5"} rounded-full overflow-hidden border ${colors.bgLight} ${
                  quota.remaining === 0 ? "border-black/10 dark:border-white/10" : "border-transparent"
                }`}>
                  <div
                    className={`h-full transition-all duration-300 ${colors.bg}`}
                    style={{ width: `${Math.min(quota.remaining, 100)}%` }}
                  />
                </div>
                )}

                <div className={`flex items-center justify-between gap-1 min-w-0 ${compact ? "text-[10px]" : "text-xs"}`}>
                  <span
                    className="text-text-muted truncate"
                    title={
                      isUnlimited
                        ? `${quota.used.toLocaleString()} used · Unlimited`
                        : isCreditBalance
                        ? `Credit balance: ${quota.total.toFixed(2)} ${quota.currency || ""}`
                        : `${quota.used.toLocaleString()} / ${quota.total > 0 ? quota.total.toLocaleString() : "∞"}`
                    }
                  >
                    {isUnlimited
                      ? `${quota.used.toLocaleString()} used · Unlimited`
                      : isCreditBalance
                      ? `Credit: ${quota.total.toFixed(2)} ${quota.currency || ""}`
                      : `${quota.used.toLocaleString()} / ${quota.total > 0 ? quota.total.toLocaleString() : "∞"}${
                          quota.unit ? ` ${quota.unit}` : ""
                        }`}
                  </span>
                  <span className={`font-medium ${isUnlimited ? "text-green-600 dark:text-green-400" : isCreditBalance ? "text-blue-600 dark:text-blue-400" : colors.text} shrink-0`}>
                    {isUnlimited ? "Unlimited" : isCreditBalance ? "" : `${quota.remaining}%`}
                  </span>
                </div>
              </div>

              {/* Reset time */}
              <div className="min-w-0 shrink">
                {countdown !== "-" || resetDisplay ? (
                  compact ? (
                    <div
                      className={`${resetPrimary} text-text-main font-medium truncate`}
                      title={resetSecondaryText || ""}
                    >
                      {countdown !== "-" ? countdownLabel : renderResetCell(resetPrimary)}
                    </div>
                  ) : (
                    <div className="min-w-0 space-y-0.5">
                      {countdown !== "-" && (
                        <div className={`${resetPrimary} text-text-main font-medium truncate`}>
                          {countdownLabel}
                        </div>
                      )}
                      {resetDisplay && (
                        <div className={`${resetSecondary} text-text-muted truncate`}>
                          {renderResetCell(resetSecondary)}
                        </div>
                      )}
                    </div>
                  )
                ) : (
                  <div className={`${resetPrimary} text-text-muted italic`}>N/A</div>
                )}
              </div>

              {/* Hide action */}
              {hasHideAction && (
                <button
                  type="button"
                  onClick={() => onHideQuota(quota)}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-black/5 hover:text-text-main dark:hover:bg-white/5"
                  title={translate("Hide this quota row")}
                  aria-label={translate("Hide this quota row")}
                >
                  <span className="material-symbols-outlined text-[15px]">
                    visibility_off
                  </span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-black/10 bg-black/[0.02] px-2 py-1.5 text-[10px] text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
          <span className="truncate">
            {translate(`Showing ${pageStart}-${pageEnd} of ${sortedQuotas.length}`)}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span>
              {translate(`Page ${page} / ${totalPages}`)}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
                disabled={page === 1}
                className="inline-flex h-5 w-5 items-center justify-center rounded border border-black/10 text-text-main transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                title={translate("Prev")}
                aria-label={translate("Prev")}
              >
                <span className="material-symbols-outlined text-[14px] leading-none">
                  chevron_left
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}
                disabled={page === totalPages}
                className="inline-flex h-5 w-5 items-center justify-center rounded border border-black/10 text-text-main transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                title={translate("Next")}
                aria-label={translate("Next")}
              >
                <span className="material-symbols-outlined text-[14px] leading-none">
                  chevron_right
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
