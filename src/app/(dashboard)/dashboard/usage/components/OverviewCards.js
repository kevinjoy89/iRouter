"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { getCurrentLocale } from "@/i18n/runtime";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

/**
 * 换算大数值指标为万/亿单位，仅大于 10000 时生效
 * @param {number|string} rawText 待格式化的数值
 * @param {string} [locale] 当前语言代码
 * @return {string} 格式化后的带单位文本
 */
function formatLargeMetricNumber(rawText, locale = getCurrentLocale()) {
  const num = typeof rawText === "number" ? rawText : Number(String(rawText).replace(/,/g, "").trim());
  if (isNaN(num) || !isFinite(num)) return String(rawText || "0");

  // 仅大于 10000 时才换算
  if (num <= 10000) {
    return fmt(num);
  }

  const isTw = locale === "zh-TW";
  const isZh = locale === "zh-CN" || (!isTw && locale !== "en");

  if (isZh || isTw) {
    const wanUnit = isTw ? " 萬" : " 万";
    const yiUnit = isTw ? " 億" : " 亿";

    // 大于等于 1 亿 (100,000,000)
    if (num >= 100000000) {
      const val = num / 100000000;
      return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + yiUnit;
    }

    // 大于 1 万
    const val = num / 10000;
    // 进位检查：若四舍五入后达到 10000.00 万，进位至 1.00 亿
    const roundedStr = val.toFixed(2);
    if (roundedStr === "10000.00") {
      return "1.00" + yiUnit;
    }
    return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + wanUnit;
  }

  // 英文模式 (en)
  if (locale === "en") {
    if (num >= 1000000000) {
      const val = num / 1000000000;
      return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "B";
    }
    if (num >= 1000000) {
      const val = num / 1000000;
      const rounded = val.toFixed(2);
      if (rounded === "1000.00") return "1.00B";
      return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "M";
    }
    const val = num / 1000;
    const rounded = val.toFixed(2);
    if (rounded === "1000.00") return "1.00M";
    return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "K";
  }

  return fmt(num);
}

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Requests</span>
        <span className="truncate text-2xl font-bold" title={fmt(stats.totalRequests)}>{formatLargeMetricNumber(stats.totalRequests)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Input Tokens</span>
        <span className="truncate text-2xl font-bold text-primary" title={fmt(stats.totalPromptTokens)}>{formatLargeMetricNumber(stats.totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Cached Tokens</span>
        <span className="truncate text-2xl font-bold text-info" title={fmt(stats.totalCachedTokens)}>{formatLargeMetricNumber(stats.totalCachedTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Output Tokens</span>
        <span className="truncate text-2xl font-bold text-success" title={fmt(stats.totalCompletionTokens)}>{formatLargeMetricNumber(stats.totalCompletionTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Est. Cost</span>
        <span className="truncate text-2xl font-bold text-warning">~{fmtCost(stats.totalCost)}</span>
        <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
