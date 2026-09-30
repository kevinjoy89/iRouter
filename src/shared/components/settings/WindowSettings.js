"use client";

// 窗口设置：开机自启与关窗行为。桌面壳专属——浏览器形态下 window.irouterShell
// 不存在，整段不渲染（由 ShellSettingsModal 的分段表 gate）。
//
// 值与 desktop/settings.js 的 CLOSE_ACTIONS 一一对应——那边是 CommonJS 壳层模块、
// 这边是 ESM 面板，无法共享常量，改动必须同步两处。
import {
  Group,
  Notice,
  Row,
  SectionBody,
  SectionHeader,
  Select,
  Switch,
} from "./parts";

const CLOSE_ACTIONS = [
  { value: "quit", label: "Quit iRouter" },
  { value: "dock", label: "Hide to tray, keep in Dock" },
  { value: "tray", label: "Hide to tray, remove from Dock" },
];

/**
 * 窗口行为设置段
 *
 * @param {object} props 组件属性
 * @param {object} props.shell 壳层配置对象
 * @param {Function} props.onSettingChange 配置变更回调
 * @return {JSX.Element} 窗口行为设置
 * @author wei
 * @since 2026-09-29
 */
export default function WindowSettings({ shell, onSettingChange }) {
  return (
    <>
      <SectionHeader
        title="Window"
        description="What the desktop shell does when you sign in or close the window"
      />
      <SectionBody>
        <Group>
          <Row
            label="Launch at Login"
            hint="Open iRouter automatically when you sign in"
          >
            <Switch
              name="launchAtLogin"
              label="Launch at Login"
              checked={shell.launchAtLogin === true}
              onChange={(v) => onSettingChange("launchAtLogin", v)}
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
              onChange={(v) => onSettingChange("closeAction", v)}
            />
          </Row>
        </Group>

        {shell.closeAction === "tray" ? (
          <Notice tone="info">
            With the Dock icon hidden, bring the window back from the menu bar.
          </Notice>
        ) : null}
      </SectionBody>
    </>
  );
}
