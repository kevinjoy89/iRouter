"use client";

// 设置面板的公共排版件与控件。
//
// 这一版把「行」从「通铺分隔线」改成「卡片组」：每一段设置是一张 raised 卡片，
// 行与行之间用卡片内的细线分开，卡片外留出背景——读数、开关、表单三类内容
// 因此有了统一的容器语义，不再是一堆长得一样的横条。
//
// 控件统一到这里：Switch / Segmented / Select 三种，尺寸与圆角一致，避免
// 原生 checkbox（只有 accent-color）与原生 select 直接裸露在面板里。
//
// data-* 属性供冒烟断言定位：按钮文字会被 runtime i18n 就地译成中文
//（「Dark」→「深色」），按文字找不到，故按值定位。
import { cn } from "@/shared/utils/cn";

/** 卡片组：一段设置的外框。行与行之间的分隔线由 divide-y 提供 */
export function Group({ children, className }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[12px] border border-border-subtle bg-surface",
        "divide-y divide-border-subtle",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 一行设置：左侧标题+说明，右侧控件
 *
 * @param {object} props 组件属性
 * @param {string} props.label 设置项名称
 * @param {string} [props.hint] 设置项说明
 * @param {JSX.Element} [props.children] 右侧控件
 * @param {string} [props.className] 追加类名
 * @return {JSX.Element} 设置行
 * @author wei
 * @since 2026-09-29
 */
export function Row({ label, hint, children, className }) {
  return (
    <div
      className={cn(
        "flex min-h-[56px] items-center justify-between gap-6 px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-[13px] leading-5 font-medium text-text-main">
          {label}
        </div>
        {hint ? (
          <div className="mt-1 max-w-[62ch] text-[12px] leading-[1.5] text-text-muted">
            {hint}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/**
 * 面板内的内联字段（用于表单式设置：代理地址、保留天数等）
 *
 * @param {object} props 组件属性
 * @param {string} props.label 字段名
 * @param {string} [props.hint] 字段说明
 * @param {JSX.Element} [props.children] 输入控件
 * @return {JSX.Element} 内联字段块
 * @author wei
 * @since 2026-09-29
 */
export function Field({ label, hint, children, className }) {
  return (
    <div className={cn("px-4 py-3.5", className)}>
      <div className="text-[13px] leading-5 font-medium text-text-main">
        {label}
      </div>
      {hint ? (
        <div className="mt-1 max-w-[62ch] text-[12px] leading-[1.5] text-text-muted">
          {hint}
        </div>
      ) : null}
      <div className="mt-3">{children}</div>
    </div>
  );
}

/**
 * 开关：替代原生 checkbox。
 *
 * 用 role="switch" 而不是 input[type=checkbox]：视觉可控（轨道+滑块），
 * 且读屏播报的是「开/关」而不是「已选中」。
 *
 * @param {object} props 组件属性
 * @param {boolean} props.checked 是否开启
 * @param {Function} props.onChange 变更回调，收到新值
 * @param {boolean} [props.disabled] 是否禁用
 * @param {string} [props.name] 冒烟断言用的 data 标识
 * @param {string} [props.label] 无可见文字时的无障碍名称
 * @return {JSX.Element} 开关
 * @author wei
 * @since 2026-09-29
 */
export function Switch({ checked, onChange, disabled, name, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-settings-switch={name}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-150",
        "focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none",
        checked ? "bg-brand-500" : "bg-surface-3",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-[18px] rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-150",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

/**
 * 分段单选控件
 *
 * @param {object} props 组件属性
 * @param {Array<{value: string, label: string}>} props.options 选项
 * @param {string} props.value 当前值
 * @param {Function} props.onChange 变更回调
 * @param {string} props.group data 属性分组名
 * @return {JSX.Element} 分段控件
 * @author wei
 * @since 2026-09-29
 */
export function Segmented({ options, value, onChange, group }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-[9px] border border-border-subtle bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-settings-option={`${group}:${o.value}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-[7px] px-2.5 text-[12px] font-medium transition-colors",
            value === o.value
              ? "bg-surface text-text-main shadow-[var(--shadow-soft)] dark:bg-surface-3"
              : "text-text-muted hover:text-text-main",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 下拉选择：保留原生 select（键盘/读屏/长列表都靠它），只换外观。
 *
 * 选项文字是 option 的文本节点，runtime i18n 的 skipTags 不含 option，
 * 因此仍会被就地翻译。
 *
 * @param {object} props 组件属性
 * @param {string} props.value 当前值
 * @param {Function} props.onChange 变更回调
 * @param {Array<{value: string, label: string}>} props.options 选项
 * @param {string} [props.name] 冒烟断言用的 data 标识
 * @return {JSX.Element} 下拉选择
 * @author wei
 * @since 2026-09-29
 */
export function Select({ value, onChange, options, name, disabled, className }) {
  return (
    <div className="relative inline-flex items-center">
      <select
        value={value}
        disabled={disabled}
        data-settings-select={name}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-8 cursor-pointer appearance-none rounded-[9px] border border-border bg-surface-2 pr-8 pl-3",
          "max-w-[300px] truncate text-[13px] text-text-main transition-colors",
          "hover:border-text-subtle/50 focus:ring-2 focus:ring-brand-500/30 focus:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="material-symbols-outlined pointer-events-none absolute right-2 text-[16px] text-text-muted">
        expand_more
      </span>
    </div>
  );
}

const NOTICE_TONES = {
  success: {
    box: "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-300",
    icon: "check_circle",
  },
  error: {
    box: "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-300",
    icon: "error",
  },
  info: {
    box: "border-border-subtle bg-surface-2 text-text-muted",
    icon: "info",
  },
  progress: {
    box: "border-border-subtle bg-surface-2 text-text-muted",
    icon: "progress_activity",
  },
};

/**
 * 内联状态条：结果与错误都用它，不再往面板里丢一行裸彩色文字。
 *
 * @param {object} props 组件属性
 * @param {"success"|"error"|"info"|"progress"} [props.tone] 语气
 * @param {JSX.Element} props.children 文案
 * @return {JSX.Element} 状态条
 * @author wei
 * @since 2026-09-29
 */
export function Notice({ tone = "info", children, className }) {
  const t = NOTICE_TONES[tone] || NOTICE_TONES.info;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[12px] leading-[1.5]",
        t.box,
        className,
      )}
    >
      {/* 外层 h-[18px] 与正文 12px×1.5 的行高同高：单行时上下居中，多行时贴首行。
          图标尺寸直接写工具类即可——图标字体的基础样式已随包 CSS 一起进 @layer base
          （见 globals.css），text-[15px] 现在真的能生效。 */}
      <span className="flex h-[18px] shrink-0 items-center">
        <span
          className={cn(
            "material-symbols-outlined text-[15px]",
            tone === "progress" && "animate-spin",
          )}
        >
          {t.icon}
        </span>
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/**
 * 读数瓦片：存储这类「看一眼数字」的内容不该和开关混在一列里
 *
 * @param {object} props 组件属性
 * @param {string} [props.icon] 图标名
 * @param {string} props.label 读数名称
 * @param {string} props.value 读数
 * @param {string} [props.hint] 补充说明
 * @return {JSX.Element} 读数瓦片
 * @author wei
 * @since 2026-09-29
 */
export function StatTile({ icon, label, value, hint }) {
  return (
    <div className="rounded-[12px] border border-border-subtle bg-surface px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-text-muted uppercase">
        {icon ? (
          <span className="material-symbols-outlined text-[14px]">{icon}</span>
        ) : null}
        {label}
      </div>
      <div className="mt-1.5 text-[19px] leading-6 font-semibold text-text-main tabular-nums">
        {value}
      </div>
      {hint ? (
        <div className="mt-0.5 text-[11px] text-text-subtle">{hint}</div>
      ) : null}
    </div>
  );
}

/**
 * 读数网格
 *
 * @param {object} props 组件属性
 * @param {JSX.Element} props.children 瓦片
 * @return {JSX.Element} 网格容器
 * @author wei
 * @since 2026-09-29
 */
export function StatGrid({ children }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

/**
 * 分段标题：滚动区顶部吸附，滚动时始终知道自己在哪一段
 *
 * @param {object} props 组件属性
 * @param {string} props.title 分组标题
 * @param {string} [props.description] 分组说明
 * @return {JSX.Element} 分组标题
 * @author wei
 * @since 2026-09-29
 */
export function SectionHeader({ title, description }) {
  return (
    <div className="sticky top-0 z-10 border-b border-border-subtle bg-bg/85 px-6 py-3.5 backdrop-blur-sm">
      <h3 className="text-[14px] font-semibold text-text-main">{title}</h3>
      {description ? (
        <p className="mt-0.5 text-[12px] leading-[1.5] text-text-muted">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 分段内容容器：统一左右留白与卡片间距
 *
 * @param {object} props 组件属性
 * @param {JSX.Element} props.children 内容
 * @return {JSX.Element} 容器
 * @author wei
 * @since 2026-09-29
 */
export function SectionBody({ children }) {
  return <div className="space-y-4 px-6 py-5">{children}</div>;
}
