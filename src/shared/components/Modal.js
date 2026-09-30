"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/shared/utils/cn";
import Button from "./Button";
import Tooltip from "./Tooltip";

// headerClassName / bodyClassName / footerClassName 是「加法式」扩展：不传时沿用
// 下面三个默认串，其余调用方的观感零变化。设置面板要用它们把 body 的 p-6 与
// 自身滚动去掉（面板是双栏、左栏固定、右栏自己滚），所以传值即整体替换默认串，
// 而不是叠加——本仓的 cn() 只做拼接，不去重冲突的 Tailwind 类。
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  showTrafficLights = true,
  className,
  headerClassName,
  bodyClassName,
  footerClassName,
}) {
  const sizes = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    full: "max-w-4xl",
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  // Escape 只关最上层的模态框。
  //
  // 每个 Modal 都把监听挂在 document 上，嵌套时（设置面板里嵌了网关设置页，
  // 那页自己会开 PricingModal）一次 Escape 会把两层一起关掉——ADR 0006 里
  // 为同一个原因放弃了「密码用第二个模态框」。这里按 DOM 顺序判定最上层：
  // 两层同为 z-50 时，后挂载的在后，也就是视觉上在上面那层。
  const rootRef = useRef(null);
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key !== "Escape" || !isOpen) return;
      const roots = document.querySelectorAll("[data-modal-root]");
      if (roots.length > 1 && roots[roots.length - 1] !== rootRef.current) return;
      onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] fade-in"
        onClick={closeOnOverlay ? onClose : undefined}
      />

      {/* Modal content */}
      <div
        ref={rootRef}
        data-modal-root=""
        className={cn(
          "relative w-full bg-surface",
          "border border-border-subtle",
          "rounded-[14px] shadow-[var(--shadow-elev)]",
          "fade-in",
          sizes[size],
          className
        )}
      >
        {/* Header */}
        {(title || showTrafficLights) && (
          <div
            className={
              headerClassName ||
              "flex items-center justify-between p-2 border-b border-border-subtle"
            }
          >
            <div className="flex items-center">
              {/* Traffic lights — desktop only */}
              {showTrafficLights && (
                <div className="hidden md:flex items-center gap-2 mr-4 ml-2">
                  <Tooltip text="Close" position="top" color="#FF5F56">
                    <button
                      onClick={onClose}
                      aria-label="Close"
                      title="Close"
                      className="w-4 h-4 rounded-full bg-[#FF5F56] hover:brightness-90 transition-all cursor-pointer flex items-center justify-center group/dot"
                    >
                      <span className="text-[9px] font-bold text-white opacity-0 group-hover/dot:opacity-100 transition-opacity leading-none">✕</span>
                    </button>
                  </Tooltip>
                  <div className="w-4 h-4 rounded-full bg-[#3a3a3a]/20 dark:bg-white/15 cursor-not-allowed" />
                  <div className="w-4 h-4 rounded-full bg-[#3a3a3a]/20 dark:bg-white/15 cursor-not-allowed" />
                </div>
              )}
              {title && (
                <h2 className="text-lg font-semibold text-text-main">{title}</h2>
              )}
            </div>
            {/* X button — mobile only */}
            <button
              onClick={onClose}
              aria-label="Close"
              className="md:hidden p-1.5 rounded-[10px] text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        )}

        {/* Body */}
        <div
          className={
            bodyClassName ||
            "p-6 max-h-[calc(85vh-100px)] overflow-y-auto custom-scrollbar"
          }
        >
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div
            className={
              footerClassName ||
              "flex items-center justify-end gap-3 p-6 border-t border-border-subtle"
            }
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading = false,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="text-text-muted">{message}</p>
    </Modal>
  );
}
