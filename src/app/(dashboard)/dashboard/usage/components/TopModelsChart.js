"use client";

import { useState, useMemo } from "react";
import PropTypes from "prop-types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import Card from "@/shared/components/Card";
import { translate } from "@/i18n/runtime";
import { wrapModelName } from "./chartUtils";

const COLORS = ["#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6"];

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

/**
 * 自动换行 Y 轴刻度标签组件
 * 采用左对齐并自动换行，在固定 90px 紧凑宽度下，将模型名称各行左边缘平齐展示
 *
 * @param {Object} props Recharts 刻度参数
 * @return {JSX.Element} SVG text 与 tspan 节点
 */
function WrappedYAxisTick({ x, y, payload }) {
  const fullName = payload?.value || "";
  const lines = wrapModelName(fullName, 12);
  // 左对齐起始横坐标：从坐标轴基准线向左预留 82px，距离卡片左边界留出约 8px 舒适间距
  const startX = Math.max(8, x - 82);

  if (lines.length <= 1) {
    return (
      <text
        x={startX}
        y={y}
        dy="0.32em"
        textAnchor="start"
        fill="currentColor"
        fillOpacity={0.7}
        fontSize={10}
      >
        <title>{fullName}</title>
        {lines[0]}
      </text>
    );
  }

  return (
    <text
      x={startX}
      y={y}
      textAnchor="start"
      fill="currentColor"
      fillOpacity={0.7}
      fontSize={10}
    >
      <title>{fullName}</title>
      <tspan x={startX} dy="-0.55em">{lines[0]}</tspan>
      <tspan x={startX} dy="1.15em">{lines[1]}</tspan>
    </text>
  );
}

WrappedYAxisTick.propTypes = {
  x: PropTypes.number,
  y: PropTypes.number,
  payload: PropTypes.object,
};

const renderWrappedYAxisTick = (tickProps) => <WrappedYAxisTick {...tickProps} />;

export default function TopModelsChart({ byModel }) {
  const [viewMode, setViewMode] = useState("tokens");

  const chartData = useMemo(() => {
    if (!byModel) return [];
    return Object.values(byModel)
      .map((data) => {
        const raw = data.rawModel || "Unknown";
        return {
          fullName: raw,
          name: raw,
          tokens: (data.promptTokens || 0) + (data.completionTokens || 0),
          requests: data.requests || 0,
        };
      })
      .filter((d) => d[viewMode] > 0)
      .sort((a, b) => b[viewMode] - a[viewMode])
      .slice(0, 5);
  }, [byModel, viewMode]);

  const fmt = viewMode === "tokens" ? fmtTokens : String;
  const label = viewMode === "tokens" ? translate("Tokens") : translate("Requests");

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text-muted uppercase tracking-wide">
          {translate("Top Models")}
        </span>
        <div className="grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-surface-2 p-1">
          <button
            onClick={() => setViewMode("tokens")}
            className={`px-2.5 py-0.5 rounded-md text-xs font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            {translate("Tokens")}
          </button>
          <button
            onClick={() => setViewMode("requests")}
            className={`px-2.5 py-0.5 rounded-md text-xs font-medium transition-colors ${viewMode === "requests" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            {translate("Requests")}
          </button>
        </div>
      </div>

      {!chartData.length ? (
        <div className="h-44 flex items-center justify-center text-text-muted text-sm">
          {translate("No model usage yet")}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 4, right: 30, left: 4, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmt}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={renderWrappedYAxisTick}
              tickLine={false}
              axisLine={false}
              width={90}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value) => [fmt(value), label]}
              labelFormatter={(_label, items) => items?.[0]?.payload?.fullName || _label}
            />
            <Bar dataKey={viewMode} radius={[0, 4, 4, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

TopModelsChart.propTypes = {
  byModel: PropTypes.object,
};
