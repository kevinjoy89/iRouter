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

// 显式选择的**权威**是壳层设置文件的 `locale` 字段（有壳层时）；浏览器形态下退回 cookie。
// **不再读 localStorage**——它是 client-only 的第二份副本，与权威并存必然漂移（ADR 0008）。
// 空串（或不受支持的值）表示「未选择」，交给优先级链回落。
function readLocalePreference(shell) {
  if (shell && typeof shell.locale === "string") {
    return normalizeLocale(shell.locale) || "system";
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
    () => readLocalePreference(shell),
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
