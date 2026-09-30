"use client";

// 设置面板的左栏导航。
//
// 面板此前是「一条长滚动」，8 个分组全靠滚——找不到、也不知道还剩多少。
// 左栏把分组变成平铺可点的索引，右栏只渲染当前这一段：既省掉纵向滚动，
// 也让每段的内容密度可控。
//
// 平铺、不再分组：面板一共 7 项，「应用 / 网关」这类两级分类只增加了
// 一层视觉噪音（用户反馈：不需要分类）。应用名与图标也不在这里出现——
// 面板标题已经说明这是什么。
import { useRef } from "react";
import { cn } from "@/shared/utils/cn";

/**
 * 左栏导航
 *
 * @param {object} props 组件属性
 * @param {Array<{key: string, label: string, icon: string}>} props.items 导航项（顺序即显示顺序）
 * @param {string} props.active 当前分段 key
 * @param {Function} props.onSelect 选择回调
 * @param {boolean} [props.updateAvailable] 是否有新版本（导航项上点一个小圆点）
 * @return {JSX.Element} 左栏导航
 * @author wei
 * @since 2026-09-29
 */
export default function SettingsNav({ items, active, onSelect, updateAvailable }) {
  const itemRefs = useRef({});

  const move = (delta) => {
    const i = items.findIndex((s) => s.key === active);
    const next = items[Math.min(Math.max(i + delta, 0), items.length - 1)];
    if (!next || next.key === active) return;
    onSelect(next.key);
    itemRefs.current[next.key]?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    }
  };

  return (
    <div className="flex w-[196px] shrink-0 flex-col border-r border-border-subtle bg-bg-alt/60">
      <nav
        role="tablist"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="flex-1 space-y-0.5 overflow-y-auto p-2"
      >
        {items.map((item) => {
          const selected = item.key === active;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="shell-settings-panel"
              tabIndex={selected ? 0 : -1}
              data-settings-nav={item.key}
              ref={(el) => {
                itemRefs.current[item.key] = el;
              }}
              onClick={() => onSelect(item.key)}
              className={cn(
                "flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px] transition-colors",
                "focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:outline-none",
                selected
                  ? "bg-brand-500/15 font-medium text-brand-700 dark:text-brand-300"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main",
              )}
            >
              <span className="material-symbols-outlined text-[17px]">
                {item.icon}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.key === "updates" && updateAvailable ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-brand-500"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
