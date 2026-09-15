"use client";

// 壳层（Electron 壳）设置页。
//
// 为什么这个页面在网关侧而不是壳层的自有 HTML：主题与语言两个控件的写入路径
// 必须和面板共用同一套存储（localStorage.theme / locale cookie），而 file://
// 页面访问不到 http://127.0.0.1:PORT 的 origin 存储。放在同 origin 下，直接复用
// themeStore 与 /api/locale。
//
// 浏览器也能打开本页（放开面板守卫后），但壳层专属项在浏览器里点了没用——
// 故用 preload 注入的 window.__IRouter_SHELL__ 区分，无标记时只渲染主题与语言。
import { useEffect, useState, useSyncExternalStore } from "react";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import useThemeStore from "@/store/themeStore";

const THEMES = ["light", "dark", "system"];

// 关窗行为三档。值与 desktop/settings.js 的 CLOSE_ACTIONS 一一对应——两边改一处必须同时改，
// 故此处注释指向那个文件；没有共享模块是因为壳层是 CommonJS、面板是 ESM。
const CLOSE_ACTIONS = [
  { value: "quit", label: "Quit iRouter" },
  { value: "dock", label: "Hide to tray, keep in Dock" },
  { value: "tray", label: "Hide to tray, remove from Dock" },
];

const LOCALES = [
  { value: "system", label: "System" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
];

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

// 语言偏好来自 localStorage/cookie（组件外部）→ 用 useSyncExternalStore 读：
// 首屏走 getServerSnapshot（"system"），水合后切到真值。不放在 useEffect 里
// setState——那会触发 react-hooks/set-state-in-effect。
const LOCALE_PREF_EVENT = "irouter:locale-pref";
const NOOP_UNSUBSCRIBE = () => {};
function subscribeLocalePref(onChange) {
  window.addEventListener(LOCALE_PREF_EVENT, onChange);
  return () => window.removeEventListener(LOCALE_PREF_EVENT, onChange);
}

function resolveSystemLocale() {
  if (typeof navigator === "undefined") return "en";
  const nav = (navigator.language || "en").toLowerCase();
  if (nav.startsWith("zh")) {
    return nav.includes("tw") || nav.includes("hk") ? "zh-TW" : "zh-CN";
  }
  return "en";
}

function Row({ title, description, children }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-main">{title}</div>
        {description ? (
          <div className="text-xs text-text-muted mt-0.5">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-surface-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={
            "px-3 h-7 rounded-md text-xs font-medium transition-colors " +
            (value === o.value
              ? "bg-surface text-text-main shadow-sm"
              : "text-text-muted hover:text-text-main")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function ShellSettingsPage() {
  const { theme, setTheme } = useThemeStore();
  const localePref = useSyncExternalStore(
    subscribeLocalePref,
    readLocalePreference,
    () => "system",
  );
  const [shell, setShell] = useState(null);
  // preload 注入了 __IRouter_SHELL__ 才是壳层窗口。同为外部系统探测，
  // 同理放到订阅里而非 effect 的同步 setState。
  const isShell = useSyncExternalStore(
    NOOP_UNSUBSCRIBE,
    () => Boolean(window.irouterShell),
    () => false,
  );

  useEffect(() => {
    const shellApi = typeof window !== "undefined" ? window.irouterShell : null;
    if (!shellApi) return;
    shellApi
      .getSettings()
      .then(setShell)
      .catch(() => setShell(null));
  }, []);

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
    // 写入后通知订阅者重读（useSyncExternalStore 不自动感知 localStorage/cookie 变化）
    window.dispatchEvent(new Event(LOCALE_PREF_EVENT));
    // 壳层主进程监听 locale cookie 变化来刷新原生菜单，无需额外通知
  };

  const applyShellSetting = async (key, value) => {
    if (!window.irouterShell) return;
    const next = await window.irouterShell.setSetting(key, value);
    setShell(next);
  };

  return (
    <div className="min-h-screen bg-background text-text-main">
      <div className="max-w-xl mx-auto px-6 py-10">
        <h1 className="text-lg font-semibold mb-6">
          {isShell ? "Shell Settings" : "Appearance"}
        </h1>

        <div className="rounded-xl border border-border bg-surface px-5 divide-y divide-border">
          <Row
            title="Theme"
            description="Applies to the embedded panel and system title bar"
          >
            <Segmented
              options={THEMES.map((t) => ({ value: t, label: t }))}
              value={theme}
              onChange={setTheme}
            />
          </Row>

          <Row
            title="Language"
            description="Menu bar and dashboard display language"
          >
            <Segmented
              options={LOCALES}
              value={localePref}
              onChange={applyLocale}
            />
          </Row>

          {isShell && shell ? (
            <>
              <Row
                title="Launch at Login"
                description="Open iRouter automatically when you sign in"
              >
                <input
                  type="checkbox"
                  checked={shell.launchAtLogin === true}
                  onChange={(e) =>
                    applyShellSetting("launchAtLogin", e.target.checked)
                  }
                  className="size-4 accent-primary"
                />
              </Row>

              <Row
                title="When closing the window"
                description="The gateway keeps running unless you quit"
              >
                <select
                  value={shell.closeAction}
                  onChange={(e) =>
                    applyShellSetting("closeAction", e.target.value)
                  }
                  className="h-9 px-3 rounded-lg bg-surface-2 text-sm text-text-main border border-border"
                >
                  {CLOSE_ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Row>

              {shell.closeAction === "tray" ? (
                <div className="py-3 text-xs text-text-muted">
                  With Dock hidden, bring the window back from the menu bar
                  icon.
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
