"use client";

// 通用设置：外观主题、界面语言以及桌面窗口生命周期行为
// 方案 A 架构：整合原外观与窗口分段，Web 端与桌面壳层统一以「通用」作为第一项
// 桌面专属项（开机自启、关窗行为）在 shell 存在时按需渲染
import { useState, useSyncExternalStore } from "react";
import {
  Group,
  Notice,
  Row,
  SectionBody,
  SectionHeader,
  Segmented,
  Select,
  Switch,
} from "./parts";
import {
  LOCALE_COOKIE,
  normalizeLocale,
  readLocalePreference,
} from "@/i18n/config";
import { reloadTranslations, resolveSystemLocale } from "@/i18n/runtime";
import useThemeStore from "@/store/themeStore";

const THEME_OPTIONS = [
  { value: "system", label: "Follow system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const LOCALE_OPTIONS = [
  { value: "system", label: "Follow system" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
];

const CLOSE_ACTIONS = [
  { value: "quit", label: "Quit iRouter" },
  { value: "dock", label: "Hide to tray, keep in Dock" },
  { value: "tray", label: "Hide to tray, remove from Dock" },
];

const LOCALE_PREF_EVENT = "irouter:locale-pref";

function subscribeLocalePref(onChange) {
  window.addEventListener(LOCALE_PREF_EVENT, onChange);
  return () => window.removeEventListener(LOCALE_PREF_EVENT, onChange);
}

/**
 * 通用设置段组件
 *
 * @param {object} props 组件属性
 * @param {object} [props.shell] 壳层配置对象（浏览器形态下为空）
 * @param {Function} [props.onSettingChange] 壳层配置变更回调函数
 * @return {JSX.Element} 通用设置界面
 * @author wei
 * @since 2026-10-09
 */
export default function GeneralSettings({ shell, onSettingChange }) {
  const { theme, setTheme } = useThemeStore();
  const [optimisticLocale, setOptimisticLocale] = useState(null);
  const localePref = useSyncExternalStore(
    subscribeLocalePref,
    () => readLocalePreference(shell),
    () => "system",
  );

  const applyLocale = async (value) => {
    // 即时乐观响应，避免跨进程通信等待期间视觉回弹
    setOptimisticLocale(value);

    const isSystem = value === "system";
    const nextLocale = isSystem ? "" : value;

    // 1. 同步壳层设置权威（优先通知父组件更新 shell 状态，若无回调则直接调用 preload API）
    if (onSettingChange) {
      try {
        await onSettingChange("locale", nextLocale);
      } catch {
        /* 壳层不可用则跳过 */
      }
    } else if (window.irouterShell?.setSetting) {
      try {
        await window.irouterShell.setSetting("locale", nextLocale);
      } catch {
        /* 壳层不可用则跳过 */
      }
    }

    // 2. 写入 cookie 供前端 runtime 渲染
    // 桌面端派生态写入当前生效语言；浏览器形态下，选择跟随系统即清空显式 cookie
    const isDesktop =
      typeof window !== "undefined" && Boolean(window.irouterShell);
    if (isDesktop) {
      const target = isSystem ? resolveSystemLocale() : value;
      document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(target)}; path=/; max-age=31536000`;
    } else {
      if (isSystem) {
        document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
      } else {
        document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=31536000`;
      }
    }

    await reloadTranslations();
    setOptimisticLocale(null);
    window.dispatchEvent(new Event(LOCALE_PREF_EVENT));
  };

  return (
    <>
      <SectionHeader
        title="General"
        description="Theme, language, and desktop window behavior"
      />
      <SectionBody>
        <Group>
          <Row label="Theme" hint="App color scheme">
            <Segmented
              name="theme"
              value={theme}
              options={THEME_OPTIONS}
              onChange={setTheme}
            />
          </Row>
          <Row label="Language" hint="User interface language">
            <Segmented
              name="language"
              value={optimisticLocale ?? localePref}
              options={LOCALE_OPTIONS}
              onChange={applyLocale}
            />
          </Row>
        </Group>

        {shell ? (
          <>
            <Group>
              <Row
                label="Launch at Login"
                hint="Open iRouter automatically when you sign in"
              >
                <Switch
                  name="launchAtLogin"
                  label="Launch at Login"
                  checked={shell.launchAtLogin === true}
                  onChange={(v) => onSettingChange?.("launchAtLogin", v)}
                />
              </Row>

              <Row
                label="When closing the window"
                hint={
                  shell.closeAction === "quit"
                    ? "Quitting stops the gateway"
                    : "The gateway keeps running in the background"
                }
              >
                <Select
                  name="closeAction"
                  value={shell.closeAction}
                  options={CLOSE_ACTIONS}
                  onChange={(v) => onSettingChange?.("closeAction", v)}
                />
              </Row>
            </Group>

            {shell.closeAction === "tray" ? (
              <Notice tone="info">
                With the Dock icon hidden, bring the window back from the menu bar.
              </Notice>
            ) : null}
          </>
        ) : null}
      </SectionBody>
    </>
  );
}
