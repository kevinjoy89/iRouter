"use client";

import React, { useState, useEffect, useRef } from "react";
import type { CurvePoint } from "../types";

/**
 * 速度曲线组件属性接口
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface SpeedtestSparklineProps {
  /** 采样点数据集 */
  points?: CurvePoint[];
  /** 画布高度 */
  height?: number;
  /** 画布宽度 */
  width?: string | number;
  /** 主题渲染主色 */
  color?: string;
  /** 描边粗细 */
  strokeWidth?: number;
  /** 是否强制启用紧凑微型走势图模式 */
  isCompact?: boolean;
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
  strokeWidth,
  isCompact,
}: SpeedtestSparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [hoveredPoint, setHoveredPoint] = useState<(CurvePoint & { x: number; y: number }) | null>(null);

  // 动态测量宿主容器真实宽度，实现任意屏幕/窗口尺寸下的全宽响应式自适应
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const updateWidth = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) {
        setContainerWidth(Math.round(w));
      }
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") return undefined;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) {
          setContainerWidth(Math.round(w));
        }
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!points || points.length === 0) {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center border border-border-subtle/50 rounded-lg bg-surface/30 text-text-muted text-xs font-mono w-full"
        style={{ height }}
      >
        暂无采样数据
      </div>
    );
  }

  // 判断是否为行内紧凑微型图模式（高度 <= 60 默认作为微型走势图渲染）
  const isCompactMode = isCompact ?? height <= 60;

  const speeds = points.map((p) => p.speed);
  const rawMax = Math.max(...speeds, 0);
  const rawMin = Math.min(...speeds, 0);

  let minSpeed: number;
  let maxSpeed: number;

  if (isCompactMode) {
    // 紧凑微型模式：自适应上下动态缩放，消除死线，突出波峰波谷变化
    const diff = rawMax - rawMin;
    const buffer = Math.max(diff * 0.15, 1.5);
    minSpeed = Math.max(0, rawMin - buffer);
    maxSpeed = Math.max(rawMax + buffer, minSpeed + 2);
  } else {
    // 高清大图模式：保留零速度安全基线与顶部留白
    maxSpeed = Math.max(...speeds, 10);
    minSpeed = Math.max(0, Math.min(...speeds) * 0.8);
  }

  const maxSpeedStr = maxSpeed.toFixed(0);
  const minSpeedStr = minSpeed.toFixed(0);
  const maxDigits = Math.max(maxSpeedStr.length, minSpeedStr.length, 2);

  // 紧凑模式固定 160 虚拟坐标；大图模式严格等于宿主容器实测像素宽度（兜底 800）
  const measuredWidth = containerWidth > 0 ? containerWidth : 800;
  const svgWidth = isCompactMode ? 160 : measuredWidth;
  const svgHeight = height;

  // 紧凑模式采用紧致边距；大图模式铺满整个宽度，右侧留 12px 安全距离，左侧根据数值位数自适应
  const paddingLeft = isCompactMode ? 3 : Math.max(36, Math.ceil(maxDigits * 7.5 + 10));
  const paddingRight = isCompactMode ? 3 : 14;
  const padding = isCompactMode
    ? { top: 4, bottom: 4, left: paddingLeft, right: paddingRight }
    : { top: 14, bottom: 20, left: paddingLeft, right: paddingRight };

  const usableWidth = Math.max(svgWidth - padding.left - padding.right, 10);
  const usableHeight = Math.max(svgHeight - padding.top - padding.bottom, 4);

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
      ? `M ${padding.left} ${coords[0].y} L ${usableWidth + padding.left} ${coords[0].y}`
      : coords.reduce((acc, pt, i) => {
          return i === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`;
        }, "");

  const bottomY = svgHeight - padding.bottom;
  const areaD =
    coords.length === 1
      ? `M ${padding.left} ${coords[0].y} L ${usableWidth + padding.left} ${coords[0].y} L ${
          usableWidth + padding.left
        } ${bottomY} L ${padding.left} ${bottomY} Z`
      : `${pathD} L ${coords[coords.length - 1].x} ${bottomY} L ${coords[0].x} ${bottomY} Z`;

  // 生成唯一渐变 ID 防止多图共用相同颜色产生冲突
  const rawColorKey = color.replace(/[^a-zA-Z0-9]/g, "");
  const gradientId = `sparkline-grad-${rawColorKey}-${isCompactMode ? "compact" : "full"}-${height}`;

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden select-none" style={{ height }}>
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="w-full h-full overflow-visible"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={isCompactMode ? 0.45 : 0.35} />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* 仅在完整大图模式下渲染基底水平网格参考线与极值文字 */}
        {!isCompactMode && (
          <>
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
            <text
              x={padding.left - 6}
              y={padding.top + 4}
              textAnchor="end"
              className="text-[9px] fill-text-muted font-mono"
            >
              {maxSpeedStr}
            </text>
            <text
              x={padding.left - 6}
              y={svgHeight - padding.bottom}
              textAnchor="end"
              className="text-[9px] fill-text-muted font-mono"
            >
              {minSpeedStr}
            </text>
          </>
        )}

        {/* 渐变面积填充 */}
        <path d={areaD} fill={`url(#${gradientId})`} />

        {/* 速度折线 (启用 non-scaling-stroke 确保在任意缩放下线条像素恒定清晰) */}
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth ?? (isCompactMode ? 2 : 2)}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ vectorEffect: "non-scaling-stroke" }}
        />

        {/* 紧凑模式仅在末尾渲染收敛高光圆点；大图模式渲染全量可交互采样圆点 */}
        {isCompactMode ? (
          coords.length > 0 && (
            <circle
              cx={coords[coords.length - 1].x}
              cy={coords[coords.length - 1].y}
              r={2.5}
              fill={color}
              stroke="#ffffff"
              strokeWidth={1}
            />
          )
        ) : (
          coords.map((pt, idx) => (
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
          ))
        )}
      </svg>

      {/* 鼠标悬停实时 Tooltip（仅完整大图模式可用） */}
      {!isCompactMode && hoveredPoint && (
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
