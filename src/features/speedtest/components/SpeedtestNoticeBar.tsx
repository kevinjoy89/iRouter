"use client";

import React from "react";

/**
 * 测速模块通用通知提示负载接口
 *
 * @author iRouter
 * @since 2026-10-19
 */
export interface SpeedtestNotice {
  /** 提示类型级别 */
  type: "success" | "error" | "warning" | "info";
  /** 提示主要标题信息 */
  message: string;
  /** 详细错误堆栈或原因描述 */
  detail?: string;
  /** 本地文件落盘绝对路径（针对导出场景） */
  path?: string;
}

/**
 * 测速模块通知提示条属性接口
 *
 * @author iRouter
 * @since 2026-10-19
 */
export interface SpeedtestNoticeBarProps {
  /** 通知数据负载，为空时不渲染 */
  notice: SpeedtestNotice | null;
  /** 点击关闭提示条时的回调函数 */
  onClose?: () => void;
  /** 自定义外层样式类名 */
  className?: string;
}

/**
 * 测速业务通用通知提示条组件 (TSX)
 *
 * 统一承载测速异常报错提示与文件导出成功/失败状态反馈
 *
 * @author iRouter
 * @since 2026-10-19
 */
export default function SpeedtestNoticeBar({
  notice,
  onClose,
  className = "",
}: SpeedtestNoticeBarProps) {
  if (!notice) return null;

  const styleMap = {
    success: {
      container: "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400",
      icon: "check_circle",
    },
    error: {
      container: "bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400",
      icon: "error",
    },
    warning: {
      container: "bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400",
      icon: "warning",
    },
    info: {
      container: "bg-primary/10 border-primary/20 text-primary",
      icon: "info",
    },
  };

  const currentStyle = styleMap[notice.type] || styleMap.info;

  return (
    <div
      className={`flex items-start justify-between gap-3 p-3.5 rounded-xl border text-xs font-sans transition-all select-text ${currentStyle.container} ${className}`}
      role="alert"
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <span className="material-symbols-outlined text-base shrink-0 mt-0.5">
          {currentStyle.icon}
        </span>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-semibold text-text-main text-xs sm:text-sm">
            {notice.message}
          </span>
          {notice.detail && (
            <div className="font-mono text-[11px] leading-relaxed break-all select-all opacity-90 p-2 rounded-lg bg-surface/50 border border-border/40 mt-0.5">
              {notice.detail}
            </div>
          )}
          {notice.path && (
            <div className="flex flex-wrap items-baseline gap-1.5 text-text-muted mt-0.5">
              <span className="text-[11px] shrink-0 font-medium">保存位置:</span>
              <span
                className="font-mono text-[11px] break-all select-all text-text-main font-semibold underline underline-offset-2 decoration-border"
                title={notice.path}
              >
                {notice.path}
              </span>
            </div>
          )}
        </div>
      </div>

      {onClose && (
        <button
          type="button"
          className="text-text-muted hover:text-text-main p-0.5 shrink-0 transition-colors"
          onClick={onClose}
          title="关闭提示"
          aria-label="关闭提示"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      )}
    </div>
  );
}
