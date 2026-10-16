"use client";

import React, { useState } from "react";
import type { CurvePoint } from "../types";

/**
 * 速度曲线组件属性接口
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface SpeedtestSparklineProps {
  points?: CurvePoint[];
  height?: number;
  width?: string | number;
  color?: string;
}

/**
 * 原生矢量 SVG 速度曲线与 Sparkline 组件 (TSX)
 *
 * @author iRouter
 * @since 2026-10-16
 */
export default function SpeedtestSparkline({
  points = [],
  height = 120,
  color = "#3b82f6",
}: SpeedtestSparklineProps) {
  const [hoveredPoint, setHoveredPoint] = useState<(CurvePoint & { x: number; y: number }) | null>(null);

  if (!points || points.length === 0) {
    return (
      <div
        className="flex items-center justify-center border border-border-subtle/50 rounded-lg bg-surface/30 text-text-muted text-xs font-mono"
        style={{ height }}
      >
        暂无采样数据
      </div>
    );
  }

  const svgWidth = 600;
  const svgHeight = height;
  const padding = { top: 16, bottom: 20, left: 24, right: 24 };

  const usableWidth = svgWidth - padding.left - padding.right;
  const usableHeight = svgHeight - padding.top - padding.bottom;

  const speeds = points.map((p) => p.speed);
  const maxSpeed = Math.max(...speeds, 10);
  const minSpeed = Math.max(0, Math.min(...speeds) * 0.8);

  const tokens = points.map((p) => p.tokenIndex);
  const maxToken = Math.max(...tokens, 1);
  const minToken = Math.min(...tokens, 0);

  // 计算每个点的 SVG 绝对坐标
  const coords = points.map((p) => {
    const xRatio = maxToken === minToken ? 0.5 : (p.tokenIndex - minToken) / (maxToken - minToken);
    const yRatio = maxSpeed === minSpeed ? 0.5 : (p.speed - minSpeed) / (maxSpeed - minSpeed);
    const x = padding.left + xRatio * usableWidth;
    const y = padding.top + (1 - yRatio) * usableHeight;
    return { ...p, x, y };
  });

  const pathD =
    coords.length === 1
      ? `M ${padding.left} ${coords[0].y} L ${coords[0].x} ${coords[0].y}`
      : coords.reduce((acc, pt, i) => {
          return i === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`;
        }, "");

  const areaD =
    coords.length === 1
      ? `M ${padding.left} ${coords[0].y} L ${coords[0].x} ${coords[0].y} L ${coords[0].x} ${
          svgHeight - padding.bottom
        } L ${padding.left} ${svgHeight - padding.bottom} Z`
      : `${pathD} L ${coords[coords.length - 1].x} ${svgHeight - padding.bottom} L ${coords[0].x} ${
          svgHeight - padding.bottom
        } Z`;

  return (
    <div className="relative w-full overflow-hidden select-none">
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="w-full h-auto overflow-visible"
        style={{ maxHeight: height }}
      >
        <defs>
          <linearGradient id={`sparkline-grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* 基底水平网格参考线 */}
        <line
          x1={padding.left}
          y1={padding.top}
          x2={svgWidth - padding.right}
          y2={padding.top}
          stroke="currentColor"
          strokeOpacity="0.08"
          strokeDasharray="4 4"
        />
        <line
          x1={padding.left}
          y1={svgHeight - padding.bottom}
          x2={svgWidth - padding.right}
          y2={svgHeight - padding.bottom}
          stroke="currentColor"
          strokeOpacity="0.12"
        />

        {/* 速度极值标注 */}
        <text
          x={padding.left - 4}
          y={padding.top + 4}
          textAnchor="end"
          className="text-[9px] fill-text-muted font-mono"
        >
          {maxSpeed.toFixed(0)}
        </text>
        <text
          x={padding.left - 4}
          y={svgHeight - padding.bottom}
          textAnchor="end"
          className="text-[9px] fill-text-muted font-mono"
        >
          {minSpeed.toFixed(0)}
        </text>

        {/* 渐变面积填充 */}
        <path d={areaD} fill={`url(#sparkline-grad-${color.replace("#", "")})`} />

        {/* 速度折线 */}
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* 采样交互圆点 */}
        {coords.map((pt, idx) => (
          <circle
            key={idx}
            cx={pt.x}
            cy={pt.y}
            r={hoveredPoint?.tokenIndex === pt.tokenIndex ? 5 : 2.5}
            fill={hoveredPoint?.tokenIndex === pt.tokenIndex ? "#ffffff" : color}
            stroke={color}
            strokeWidth={hoveredPoint?.tokenIndex === pt.tokenIndex ? 2 : 1}
            className="cursor-pointer transition-all duration-150"
            onMouseEnter={() => setHoveredPoint(pt)}
            onMouseLeave={() => setHoveredPoint(null)}
          />
        ))}
      </svg>

      {/* 鼠标悬停实时 Tooltip */}
      {hoveredPoint && (
        <div
          className="absolute pointer-events-none z-10 px-2 py-1 rounded bg-surface-2 border border-border-subtle shadow-lg text-[11px] font-mono text-text-main flex flex-col items-center"
          style={{
            left: `${(hoveredPoint.x / svgWidth) * 100}%`,
            top: `${(hoveredPoint.y / svgHeight) * 100}%`,
            transform: "translate(-50%, -120%)",
          }}
        >
          <span className="font-semibold text-primary">{hoveredPoint.speed.toFixed(1)} tokens/s</span>
          <span className="text-[10px] text-text-muted">Token #{hoveredPoint.tokenIndex} ({hoveredPoint.elapsedMs.toFixed(0)}ms)</span>
        </div>
      )}
    </div>
  );
}
