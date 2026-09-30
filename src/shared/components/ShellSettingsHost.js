"use client";

// 壳层设置模态框的宿主：只做一件事——订阅「打开设置」信号并渲染模态框。
//
// 为什么要有这一层：主进程（应用菜单 Cmd+, / 托盘菜单）只能发 IPC，不能直接
// 操作渲染进程的 React 状态。这一层把信号翻译成 isOpen，模态框本身保持纯展示。
//
// 两个来源：
//   1. 桌面壳主进程的 IPC（shell:open-settings）；
//   2. 渲染进程内的 window 事件 irouter:open-settings —— 面板自己的入口
//      （HeaderMenu 的 Settings）走这条。网络/可观测性/存储已迁进这个面板，
//      浏览器形态下没有 IPC，必须另有一条能打开它的路径，否则那些设置够不着。
import { useEffect, useState } from "react";
import ShellSettingsModal from "./ShellSettingsModal";

const OPEN_EVENT = "irouter:open-settings";

export default function ShellSettingsHost() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setIsOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);

    const api = typeof window !== "undefined" ? window.irouterShell : null;
    // preload 返回取消订阅函数
    const unsubscribe = api?.onOpenSettings ? api.onOpenSettings(onOpen) : null;

    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  return (
    <ShellSettingsModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
  );
}
