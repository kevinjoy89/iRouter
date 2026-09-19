"use client";

import { useEffect } from "react";
import useThemeStore from "@/store/themeStore";

/**
 * 全局主题提供者组件，负责初始化应用主题并监听系统深浅色切换
 *
 * @author iRouter
 * @since 2026-09-19
 * @param {Object} props 组件属性
 * @param {React.ReactNode} props.children 子节点
 * @return {JSX.Element} 主题包裹器
 */
export function ThemeProvider({ children }) {
  const { initTheme } = useThemeStore();

  useEffect(() => {
    initTheme();

    if (typeof window === "undefined" || !window.matchMedia) return;

    // 全局监听系统深浅色切换（如 macOS 定时暗黑模式）
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      const currentTheme = useThemeStore.getState().theme;
      // 仅在跟随系统模式下随操作系统状态自动响应
      if (currentTheme === "system") {
        initTheme();
      }
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
    }
    mediaQuery.addListener(handleSystemThemeChange);
    return () => mediaQuery.removeListener(handleSystemThemeChange);
  }, [initTheme]);

  return <>{children}</>;
}

