"use client";

// 通用设置：外观主题、界面语言以及桌面窗口生命周期行为
// 方案 A 架构：整合原外观与窗口分段，Web 端与桌面壳层统一以「通用」作为第一项
// 桌面专属项（开机自启、关窗行为）在 shell 存在时按需渲染
import { useSyncExternalStore } from "react";
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
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { reloadTranslations } from "@/i18n/runtime";
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

function readLocalePreference() {
  if (typeof document === "undefined") return "system";
  try {
    const saved = localStorage.getItem("irouter_locale_preference");
    if (saved) return saved;
  } catch {
    /* 隐私模式等 */
  }
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  return cookie
    ? normalizeLocale(decodeURIComponent(cookie.split("=")[1]))
    : "system";
}

function resolveSystemLocale() {
  if (typeof navigator === "undefined") return "en";
  const nav = (navigator.language || "en").toLowerCase();
  if (nav.includes("tw") || nav.includes("hk") || nav.includes("hant"))
    return "zh-TW";
  if (nav.startsWith("zh")) return "zh-CN";
  return "en";
}

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
  const localePref = useSyncExternalStore(
    subscribeLocalePref,
    readLocalePreference,
    () => "system",
  );

  const applyLocale = async (value) => {
    try {
      localStorage.setItem("irouter_locale_preference", value);
    } catch {
      /* 忽略 */
    }
    const target = value === "system" ? resolveSystemLocale() : value;
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(target)}; path=/; max-age=31536000`;
    try {
      await fetch("/api/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: target }),
      });
    } catch {
      /* 忽略 */
    }
    await reloadTranslations();
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
              value={localePref}
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
