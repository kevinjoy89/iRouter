"use client";

// 外观设置：主题与语言。原先内联在 ShellSettingsModal 里，现在面板有导航了，
// 每一段各自成文件——模态框只负责布局与分段切换。
//
// 语言切换必须走面板的 runtime i18n：就地重译整个 DOM，不整页刷新；
// 同时写 localStorage + cookie，壳层主进程据此刷新原生菜单。
import { useSyncExternalStore } from "react";
import { Group, Row, SectionBody, SectionHeader, Segmented } from "./parts";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { reloadTranslations } from "@/i18n/runtime";
import useThemeStore from "@/store/themeStore";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Follow system" },
];

const LOCALE_OPTIONS = [
  { value: "system", label: "Follow system" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
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
 * 外观设置段
 *
 * @return {JSX.Element} 主题与语言
 * @author wei
 * @since 2026-09-29
 */
export default function AppearanceSettings() {
  const { theme, setTheme } = useThemeStore();
  // 外部系统读值，故用 useSyncExternalStore 而非 effect+setState
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
    // 就地重译整个 DOM，零整页刷新；壳层主进程监听 locale cookie 变化刷新原生菜单
    await reloadTranslations();
    window.dispatchEvent(new Event(LOCALE_PREF_EVENT));
  };

  return (
    <>
      <SectionHeader
        title="Appearance"
        description="Theme and language for the whole app, menu bar included"
      />
      <SectionBody>
        <Group>
          <Row label="Theme" hint="Applies to the whole app">
            <Segmented
              group="theme"
              options={THEME_OPTIONS}
              value={theme}
              onChange={setTheme}
            />
          </Row>
          <Row label="Language" hint="Menu bar and interface text">
            <Segmented
              group="locale"
              options={LOCALE_OPTIONS}
              value={localePref}
              onChange={applyLocale}
            />
          </Row>
        </Group>
      </SectionBody>
    </>
  );
}
