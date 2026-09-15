"use client";

// 壳层设置模态框的宿主：只做一件事——订阅主进程的「打开设置」信号并渲染模态框。
//
// 为什么要有这一层：主进程（应用菜单 Cmd+, / 托盘菜单）只能发 IPC，不能直接
// 操作渲染进程的 React 状态。这一层把信号翻译成 isOpen，模态框本身保持纯展示。
//
// 浏览器形态下 preload 不存在，onOpenSettings 无从订阅，但组件仍安全渲染
// （壳层专属项由模态框内部按 window.irouterShell 自行隐藏）。
import { useEffect, useState } from "react";
import ShellSettingsModal from "./ShellSettingsModal";

export default function ShellSettingsHost() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.irouterShell : null;
    if (!api?.onOpenSettings) return;
    // preload 返回取消订阅函数
    return api.onOpenSettings(() => setIsOpen(true));
  }, []);

  return (
    <ShellSettingsModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
  );
}
