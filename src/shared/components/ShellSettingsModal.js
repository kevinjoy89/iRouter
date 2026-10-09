"use client";

// 壳层（桌面版）设置模态框。**渲染在主窗口内**，不是独立的 Electron 窗口。
//
// 为什么必须这样（第一版做错的地方）：独立 BrowserWindow 有自己的 document
// 与 JS 堆。主题写在 localStorage 里虽同 origin 可见，但主窗口的 zustand 不会
// 感知，切主题看不到任何变化；语言同理，且那个窗口的 DOM 不在主窗口 i18n 的
// MutationObserver 观察范围内。模态框与面板同一个 document，两个问题一起消失。
//
// 这一版把「一条长滚动」换成双栏：左栏是分段索引，右栏只渲染当前段。
// 此前 8 个分组堆在 512px 宽的列里（实测内容 3300px 高），找不到也看不到底。
// 分段表 SECTIONS 同时驱动导航与内容，两者不会走偏。
//
// 壳层专属项（关窗行为 / 开机自启 / 软件更新）经 preload 暴露的 window.irouterShell
// 读写；浏览器打开时该对象不存在，这些段整段不进导航，也不渲染。
import { useEffect, useState, useSyncExternalStore } from "react";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import SettingsNav from "@/shared/components/settings/SettingsNav";
import GeneralSettings from "@/shared/components/settings/GeneralSettings";
import UpdateSettings, {
  useSoftwareUpdate,
} from "@/shared/components/settings/UpdateSettings";
import NetworkSettings from "@/shared/components/settings/NetworkSettings";
import DataLogsSettings from "@/shared/components/settings/DataLogsSettings";
import GatewaySettingsSection from "@/shared/components/settings/GatewaySettingsSection";
import SecuritySettings from "@/shared/components/settings/SecuritySettings";
import { APP_CONFIG } from "@/shared/constants/config";

// 分段表（方案 A）。顺序即左栏顺序，平铺不分簇：
//   1. General：通用（整合主题语言外观与桌面自启/关窗行为，桌面项仅在壳就绪时呈现）
//   2. Network：网络出站代理
//   3. Data & Logs：数据与日志（整合可观测性日志开关与数据库指标/清理/配置备份）
//   4. Security：安全与 SSO
//   5. Gateway Settings：网关设置（嵌入 profile 页）
//   6. Software Update：软件更新（按用户要求移至最后一项，shellOnly 仅在桌面壳呈现）
const SECTIONS = [
  { key: "general", icon: "settings", label: "General" },
  { key: "network", icon: "lan", label: "Network" },
  { key: "datalogs", icon: "database", label: "Data & Logs" },
  { key: "security", icon: "shield", label: "Security" },
  { key: "gateway", icon: "tune", label: "Gateway Settings" },
  {
    key: "updates",
    icon: "system_update_alt",
    label: "Software Update",
    shellOnly: true,
  },
];

const NOOP_UNSUBSCRIBE = () => {};

export default function ShellSettingsModal({ isOpen, onClose, initialSection }) {
  // 壳层探测：preload 注入了 window.irouterShell 才是桌面壳内。外部系统读值，
  // 故用 useSyncExternalStore 而非 effect+setState（本仓该规则是 eslint error）。
  const isShell = useSyncExternalStore(
    NOOP_UNSUBSCRIBE,
    () => Boolean(window.irouterShell),
    () => false,
  );
  const [shell, setShell] = useState(null);
  // 外部（端点页的安全横幅）可以指定要打开哪一段。宿主用 key 重挂载本组件来切换，
  // 所以这里只需要把请求值当初始值——不在 effect 里 setState（本仓把
  // react-hooks/set-state-in-effect 定为 error）。
  const normalizeSectionKey = (key) => {
    if (key === "appearance" || key === "window") return "general";
    if (key === "observability" || key === "storage" || key === "data-logs")
      return "datalogs";
    return key;
  };
  const resolvedInitial = normalizeSectionKey(initialSection);
  const [active, setActive] = useState(
    SECTIONS.some((s) => s.key === resolvedInitial) ? resolvedInitial : "general",
  );
  // 更新状态提到这里：左栏「软件更新」要能在不滚到底的情况下点出一个小圆点
  const update = useSoftwareUpdate();

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.irouterShell : null;
    if (!api) return;
    api
      .getSettings()
      .then(setShell)
      .catch(() => setShell(null));
  }, [isOpen]);

  const applyShellSetting = async (key, value) => {
    if (!window.irouterShell) return;
    const next = await window.irouterShell.setSetting(key, value);
    setShell(next);
  };

  const shellReady = isShell && shell;
  const items = SECTIONS.filter((s) => !s.shellOnly || shellReady);

  // 页脚左侧的一行状态：版本 + 更新结论。版本只在这里出现一次，
  // 左栏不再重复（原先两处都印版本号）。
  const upToDate =
    update.state === "idle" && update.result && !update.result.updateAvailable;
  const footerStatus = update.updateAvailable
    ? "A new version is available"
    : upToDate
      ? "Current version is up to date"
      : null;

  // 页脚左边一行：应用名 + 版本 · 本地/远程模式 · 更新结论。
  // 前两段原本是 /dashboard/profile 页尾的 App Info 块，嵌进面板后与页脚重复，
  // 于是并到这里（用户要求），原块在嵌入时不渲染。
  // 环境探测走 useSyncExternalStore：首屏给 false（服务端无 window），水合后切真值。
  const isRemoteHost = useSyncExternalStore(
    NOOP_UNSUBSCRIBE,
    () =>
      !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname),
    () => false,
  );

  const renderSection = () => {
    // 软件更新读的是壳层设置（异步 getSettings 取回）。导航在 shell 就绪前
    // 会把它们藏起来，但内容分支此前不看这个条件——一旦 active 落在这两段（外部指定
    // 分段、或 shell 加载中切换），就把 null 传下去崩在 shell.checkUpdates 上。
    // 这里统一挡住：与 items 用同一个判据，未就绪就显示占位。
    if (!shellReady && SECTIONS.some((s) => s.key === active && s.shellOnly)) {
      return (
        <div className="px-6 py-8 text-center text-[12px] text-text-muted">
          Loading shell settings...
        </div>
      );
    }
    switch (active) {
      case "general":
      case "appearance":
      case "window":
        return (
          <GeneralSettings shell={shell} onSettingChange={applyShellSetting} />
        );
      case "network":
        return <NetworkSettings />;
      case "datalogs":
      case "observability":
      case "storage":
      case "data-logs":
        return <DataLogsSettings />;
      case "security":
        return <SecuritySettings />;
      case "gateway":
        return <GatewaySettingsSection />;
      case "updates":
        return (
          <UpdateSettings
            shell={shell}
            onSettingChange={applyShellSetting}
            update={update}
          />
        );
      default:
        return (
          <GeneralSettings shell={shell} onSettingChange={applyShellSetting} />
        );
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Settings"
      size="full"
      // 不能关交通灯：它是桌面端唯一的关闭入口（Modal 的 X 按钮带 `md:hidden`，
      // 只在窄屏出现）。设为 false 后 macOS 上面板将无法关闭。
      showTrafficLights
      // 点遮罩不关：设置项是即时生效的开关，误触遮罩就关掉会让用户以为改动丢了。
      closeOnOverlay={false}
      // 这里**不能**用 overflow-hidden 收圆角：交通灯的气泡提示是 bottom-full 的
      // 绝对定位元素，要从模态框顶边溢出去，一旦裁剪就只剩半截（用户实测截图）。
      // 圆角本身由 Modal 的 `rounded-[14px]` + 头/脚两条透明横条保证——它们没有自己的
      // 底色，四角不会溢出，只有左右两栏的底色在 body 内部，够不到圆角。
      className="shell-settings-modal"
      // body 的三处默认（p-6 / max-h / 自身滚动）都要让位给双栏布局：左栏固定，
      // 右栏自己滚。整体替换而非叠加，见 Modal.js 的注释。
      bodyClassName="p-0"
      headerClassName="flex items-center justify-between border-b border-border-subtle p-2"
      footerClassName="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3"
      // 显式关闭按钮。交通灯红点在 macOS 上是标准，但它很小且需要悬停才显形，
      // 不足以保证「一眼看到怎么关」；宽屏时 Modal 自带的 X 又不渲染（带 md:hidden）。
      footer={
        <>
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-text-muted">
            <span className="shrink-0">
              {APP_CONFIG.name}{" "}
              <span className="tabular-nums">v{APP_CONFIG.version}</span>
            </span>
            <span className="shrink-0 text-text-subtle">·</span>
            <span className="truncate">
              {isRemoteHost
                ? "Remote Mode"
                : "Local Mode - All data stored on your machine"}
            </span>
            {footerStatus ? (
              <>
                <span className="shrink-0 text-text-subtle">·</span>
                <span
                  className={
                    update.updateAvailable
                      ? "shrink-0 text-brand-600 dark:text-brand-300"
                      : "shrink-0"
                  }
                >
                  {footerStatus}
                </span>
              </>
            ) : null}
          </div>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="flex max-h-[min(560px,72vh)] min-h-[380px]">
        <SettingsNav
          items={items}
          active={active}
          onSelect={setActive}
          updateAvailable={update.updateAvailable}
        />
        {/* 高度随内容、上限 560px：最长的网络段 489px、存储 465px，最短的
            「更多网关设置」178px。固定高度会在短段留下半屏空白。 */}
        <div
          id="shell-settings-panel"
          role="tabpanel"
          className="custom-scrollbar flex-1 overflow-y-auto bg-bg"
        >
          {renderSection()}
        </div>
      </div>
    </Modal>
  );
}
