"use client";

import { useState, useRef, useEffect } from "react";
import { cn } from "@/shared/utils/cn";

const INTERVAL_OPTIONS = [
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
];

/**
 * “使用情况”页面顶部刷新控制栏组件
 * 提供手动即时刷新按钮与定时轮询开关/间隔下拉控制
 *
 * @author wei
 * @since 2026-09-16
 * @param {Object} props 组件入参
 * @param {boolean} props.enabled 是否开启定时自动刷新
 * @param {Function} props.onToggleEnabled 切换自动刷新开启状态
 * @param {number} props.intervalSec 轮询间隔秒数
 * @param {Function} props.onChangeIntervalSec 修改轮询间隔秒数
 * @param {boolean} props.isRefreshing 是否正在刷新
 * @param {Function} props.onManualRefresh 手动刷新回调
 * @param {string} [props.className] 容器自定义类名
 * @return {JSX.Element} 刷新控制栏
 */
export default function UsageRefreshControl({
  enabled,
  onToggleEnabled,
  intervalSec,
  onChangeIntervalSec,
  isRefreshing,
  onManualRefresh,
  className,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // 点击外部自动关闭下拉菜单
  useEffect(() => {
    /**
     * 处理外部点击关闭
     *
     * @param {MouseEvent} event 鼠标点击事件
     */
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [dropdownOpen]);

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      {/* 手动即时刷新按钮 */}
      <button
        type="button"
        onClick={onManualRefresh}
        disabled={isRefreshing}
        title="刷新数据"
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-border bg-surface-2 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-main disabled:opacity-50 cursor-pointer"
        )}
      >
        <span
          className={cn(
            "material-symbols-outlined text-[18px]",
            isRefreshing && "animate-spin text-brand-500"
          )}
        >
          refresh
        </span>
      </button>

      {/* 定时自动刷新与间隔选择容器 */}
      <div ref={dropdownRef} className="relative inline-flex items-center">
        <button
          type="button"
          onClick={() => setDropdownOpen((prev) => !prev)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 px-2.5 rounded-[8px] border text-xs font-medium transition-colors cursor-pointer",
            enabled
              ? "border-brand-500/40 bg-brand-500/10 text-brand-600 dark:text-brand-400 hover:bg-brand-500/15"
              : "border-border bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text-main"
          )}
        >
          <span className="material-symbols-outlined text-[15px]">
            {enabled ? "sync" : "sync_disabled"}
          </span>
          <span>{enabled ? `自动刷新 (${intervalSec}s)` : "自动刷新"}</span>
          <span className="material-symbols-outlined text-[14px]">
            expand_more
          </span>
        </button>

        {/* 间隔与开关下拉面板 */}
        {dropdownOpen && (
          <div className="absolute right-0 top-full mt-1 w-44 z-50 rounded-[10px] border border-border bg-surface shadow-lg p-1.5 flex flex-col gap-1">
            {/* 开关项 */}
            <div
              onClick={() => onToggleEnabled(!enabled)}
              className="flex items-center justify-between px-2.5 py-1.5 rounded-[6px] hover:bg-surface-2 cursor-pointer transition-colors"
            >
              <span className="text-xs font-medium text-text-main">
                自动刷新
              </span>
              <div
                className={cn(
                  "relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
                  enabled ? "bg-brand-500" : "bg-border"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform",
                    enabled ? "translate-x-3.5" : "translate-x-0.5"
                  )}
                />
              </div>
            </div>

            <div className="h-px bg-border my-0.5" />

            {/* 间隔秒数选项 */}
            <div className="px-2.5 py-1 text-[11px] font-semibold text-text-muted uppercase">
              刷新间隔
            </div>
            {INTERVAL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChangeIntervalSec(opt.value);
                  if (!enabled) {
                    onToggleEnabled(true);
                  }
                  setDropdownOpen(false);
                }}
                className={cn(
                  "flex items-center justify-between px-2.5 py-1.5 rounded-[6px] text-xs font-medium transition-colors cursor-pointer text-left",
                  intervalSec === opt.value && enabled
                    ? "bg-brand-500/10 text-brand-600 dark:text-brand-400"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                )}
              >
                <span>{opt.label}</span>
                {intervalSec === opt.value && enabled && (
                  <span className="material-symbols-outlined text-[14px]">
                    check
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
