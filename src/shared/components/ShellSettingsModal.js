"use client";

// 壳层（桌面版）设置模态框。**渲染在主窗口内**，不是独立的 Electron 窗口。
//
// 为什么必须这样（第一版做错的地方）：独立 BrowserWindow 有自己的 document
// 与 JS 堆。主题写在 localStorage 里虽同 origin 可见，但主窗口的 zustand 不会
// 感知，切主题看不到任何变化；语言同理，且那个窗口的 DOM 不在主窗口 i18n 的
// MutationObserver 观察范围内。模态框与面板同一个 document，两个问题一起消失。
//
// 壳层专属项（关窗行为 / 开机自启）经 preload 暴露的 window.irouterShell 读写；
// 浏览器打开时该对象不存在，这些项整段不渲染。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { reloadTranslations, translate } from "@/i18n/runtime";
import useThemeStore from "@/store/themeStore";

// 关窗行为三档。值与 desktop/settings.js 的 CLOSE_ACTIONS 一一对应——那边是
// CommonJS 壳层模块、这边是 ESM 面板，无法共享常量，改动必须同步两处。
const CLOSE_ACTIONS = [
  { value: "quit", label: "Quit iRouter" },
  { value: "dock", label: "Hide to tray, keep in Dock" },
  { value: "tray", label: "Hide to tray, remove from Dock" },
];

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

const NOOP_UNSUBSCRIBE = () => {};

function Row({ label, hint, children }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-main">{label}</div>
        {hint ? (
          <div className="text-xs text-text-muted mt-0.5">{hint}</div>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// data-* 属性供冒烟断言定位：按钮文字会被 runtime i18n 就地译成中文
//（「Dark」→「深色」），按文字找不到，故按值定位。
function Segmented({ options, value, onChange, group }) {
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-surface-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-settings-option={`${group}:${o.value}`}
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

// 家目录前缀缩成 ~：完整路径会撑爆这一行
function shortenHome(p) {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

// 网关数据段：配置导出/导入。原先在面板的 /dashboard/profile（Local Mode 卡片），
// 迁到此处后即为桌面专属——模态框只能由壳层主进程经 IPC 唤起，浏览器形态打不开
// （ADR 0006）。
//
// 单列一段并标出「Gateway data」：上面各行的语义是窗口与外观行为，这一段动的是
// 网关的数据，边界得读得出来。
//
// 密码就地输入而非第二个模态框：Modal 的 Escape 监听挂在 document 上，
// document.body.style.overflow 又由各自独立写入，嵌套会导致按一次 Escape 关掉两个、
// 内层卸载清掉外层的滚动锁。
//
// 状态留在这个独立组件里，靠 Modal 关闭时返回 null 让它整体卸载——密码与状态
// 提示因此自然归零，不必在 effect 里重置（那样会触发本仓的
// react-hooks/set-state-in-effect error）。
function GatewayDataSection() {
  const [authed, setAuthed] = useState(null);
  const [dbPath, setDbPath] = useState("");
  const [pending, setPending] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });
  const fileRef = useRef(null);
  const pickedFileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setAuthed(d?.authenticated === true);
      })
      .catch(() => {
        if (alive) setAuthed(false);
      });
    // 路径由网关回报：桌面版默认 ~/.irouter，上游默认 ~/.9router，DATA_DIR 还可覆盖。
    // 未登录时该请求 401，路径留空。
    fetch("/api/settings/database/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setDbPath(d?.path || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const reset = () => {
    setPending("");
    setPassword("");
    pickedFileRef.current = null;
  };

  const startExport = () => {
    setStatus({ type: "", message: "" });
    setPassword("");
    setPending("export");
  };

  const onFilePicked = (event) => {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    pickedFileRef.current = file;
    setStatus({ type: "", message: "" });
    setPassword("");
    setPending("import");
  };

  const confirm = async () => {
    if (!password || busy) return;
    setBusy(true);
    setStatus({ type: "", message: "" });
    try {
      if (pending === "export") {
        const res = await fetch("/api/settings/database", {
          headers: { "x-9r-password": password },
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(translate(data.error || "Failed to export database"));
        }
        const blob = new Blob([JSON.stringify(await res.json(), null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `irouter-config-${new Date().toISOString().replace(/[.:]/g, "-")}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setStatus({ type: "success", message: "Configuration exported" });
        reset();
      } else {
        const file = pickedFileRef.current;
        if (!file) {
          reset();
          return;
        }
        const payload = JSON.parse(await file.text());
        const res = await fetch("/api/settings/database", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(translate(data.error || "Failed to import database"));
        }
        setStatus({ type: "success", message: "Configuration imported" });
        reset();
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: err.message || translate("Invalid backup file"),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="px-4 pt-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Gateway data
      </div>

      <div className="px-4 py-3">
        <div className="text-sm font-medium text-text-main">
          Database Location
        </div>
        <div className="text-xs text-text-muted font-mono mt-0.5 break-all">
          {dbPath ? shortenHome(dbPath) : "—"}
        </div>

        {authed === false ? (
          <div className="text-xs text-text-muted mt-2">
            Sign in to manage backups.
          </div>
        ) : null}

        {pending ? (
          <div className="flex items-center gap-2 mt-3">
            <input
              type="password"
              autoFocus
              value={password}
              placeholder="Password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              className="h-9 flex-1 min-w-0 px-3 rounded-lg bg-surface-2 text-sm text-text-main border border-border"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={confirm}
              disabled={!password}
              loading={busy}
            >
              Confirm
            </Button>
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : null}

        <div className="flex flex-col sm:flex-row gap-2 mt-3">
          <Button
            variant="secondary"
            size="sm"
            icon="download"
            onClick={startExport}
            disabled={!authed || busy}
          >
            Export Configuration
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon="upload"
            onClick={() => fileRef.current?.click()}
            disabled={!authed || busy}
          >
            Import Configuration
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onFilePicked}
          />
        </div>

        {status.message ? (
          <p
            className={
              "text-xs mt-2 " +
              (status.type === "error"
                ? "text-red-500"
                : "text-green-600 dark:text-green-400")
            }
          >
            {status.message}
          </p>
        ) : null}
      </div>
    </>
  );
}

export default function ShellSettingsModal({ isOpen, onClose }) {
  const router = useRouter();
  const { theme, setTheme } = useThemeStore();
  const localePref = useSyncExternalStore(
    subscribeLocalePref,
    readLocalePreference,
    () => "system",
  );
  // 壳层探测：preload 注入了 window.irouterShell 才是桌面壳内。外部系统读值，
  // 故用 useSyncExternalStore 而非 effect+setState（本仓该规则是 eslint error）。
  const isShell = useSyncExternalStore(
    NOOP_UNSUBSCRIBE,
    () => Boolean(window.irouterShell),
    () => false,
  );
  const [shell, setShell] = useState(null);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.irouterShell : null;
    if (!api) return;
    api
      .getSettings()
      .then(setShell)
      .catch(() => setShell(null));
  }, [isOpen]);

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

  const applyShellSetting = async (key, value) => {
    if (!window.irouterShell) return;
    const next = await window.irouterShell.setSetting(key, value);
    setShell(next);
  };

  const openGatewaySettings = () => {
    onClose();
    router.push("/dashboard/profile");
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Settings"
      size="lg"
      // 不能关交通灯：它是桌面端唯一的关闭入口（Modal 的 X 按钮带 `md:hidden`，
      // 只在窄屏出现）。设为 false 后 macOS 上面板将无法关闭。
      showTrafficLights
      // 点遮罩不关：设置项是即时生效的开关，误触遮罩就关掉会让用户以为改动丢了。
      closeOnOverlay={false}
      className="shell-settings-modal"
      // 显式关闭按钮。交通灯红点在 macOS 上是标准，但它很小且需要悬停才显形，
      // 不足以保证「一眼看到怎么关」；宽屏时 Modal 自带的 X 又不渲染（带 md:hidden）。
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="divide-y divide-border -mx-6">
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

        {/* 网关设置快捷入口：跳转到面板的 /dashboard/profile。
            壳层设置只覆盖窗口行为（主题/语言/关窗/自启），而提供商、路由、
            安全等配置在网关侧——不给个入口，用户得自己扶清两个「设置」的区别。
            跳转前先关模态框，否则遮罩会留在新页面上。 */}
        <Row label="Gateway Settings" hint="Manage your preferences">
          <Button variant="outline" size="sm" onClick={openGatewaySettings}>
            Open
          </Button>
        </Row>

        {isShell && shell ? (
          <>
            <Row
              label="Launch at Login"
              hint="Open iRouter automatically when you sign in"
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
              label="When closing the window"
              hint={
                shell.closeAction === "quit"
                  ? "Quitting stops the gateway"
                  : "The gateway keeps running in the background"
              }
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
              <div className="px-4 py-3 text-xs text-text-muted">
                With the Dock icon hidden, bring the window back from the menu
                bar.
              </div>
            ) : null}
          </>
        ) : null}

        {/* 网关数据：配置导出/导入。桌面专属（ADR 0006）。 */}
        <GatewayDataSection />
      </div>
    </Modal>
  );
}
