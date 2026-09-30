"use client";

/** Security warning banner with optional action link */
export default function SecurityWarning({ message, action }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400">
      <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">warning</span>
      <p className="text-xs flex-1">{message}</p>
      {action && (
        <a
          href={action.href || "#"}
          className="text-xs font-medium underline shrink-0 hover:opacity-80"
          onClick={(e) => {
            // 面板内的动作优先：href 只是给个可聚焦/可复制的兜底
            if (action.onClick) {
              e.preventDefault();
              action.onClick();
              return;
            }
            if (!action.href?.startsWith("#")) return;
            e.preventDefault();
            document
              .getElementById(action.href.slice(1))
              ?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          {action.label}
        </a>
      )}
    </div>
  );
}
