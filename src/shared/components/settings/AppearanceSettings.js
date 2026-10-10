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

const LOCALE_PREF_EVENT = "irouter:locale-pref";

// 显式选择的**权威**是壳层设置文件的 `locale` 字段（有壳层时）；浏览器形态下退回 cookie。
// **不再读 localStorage**——它是 client-only 的第二份副本，与权威并存必然漂移（ADR 0008）。
// 空串（或不受支持的值）表示「未选择」，交给优先级链回落。
function readLocalePreference() {
  const api = typeof window !== "undefined" ? window.irouterShell : null;
  if (api?.locale !== undefined) {
    return normalizeLocale(api.locale) || "system";
  }
  if (typeof document === "undefined") return "system";
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  if (!cookie) return "system";
  return normalizeLocale(decodeURIComponent(cookie.split("=")[1])) || "system";
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
    // 顺序要紧：先落**权威**（壳层设置文件），再写派生态（cookie）。
    // 反过来的话壳层重启时会读到旧值——它才是原生菜单语言的来源。
    const target = value === "system" ? resolveSystemLocale() : value;
    if (window.irouterShell?.setSetting) {
      try {
        // 空串 = 未选择，壳层据此回落到系统语言（而不是回落到英文）
        await window.irouterShell.setSetting(
          "locale",
          value === "system" ? "" : value,
        );
      } catch {
        /* 壳层不可用则跳过，cookie 仍生效 */
      }
    }
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(target)}; path=/; max-age=31536000`;
    // 就地重译整个 DOM，零整页刷新；壳层主进程收到 locale 设置后刷新原生菜单
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
