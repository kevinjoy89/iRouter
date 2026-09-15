// 壳层设置：持久化与取值校验。
//
// 为什么单独一个文件而不是塞进 main.js：main.js 顶部就 import Electron，
// 无法被 vitest 直接 require。设置存取是纯逻辑（读 JSON、校验、给默认值），
// 抽出来才能进单测——壳层在这之前是零单测。
//
// 为什么落盘而不是存网关 settings 表：Dock、关窗行为都是**壳层状态**，
// 网关完全不知情。存进 settings 表意味着壳层要跨进程读 sqlite（那条
// bun → better-sqlite3 → node:sqlite → sql.js 适配链），且网关重启会影响
// 壳层行为。dataDir 下的 JSON 与 .gateway.pid 同类。
//
// 注意：**不存开机自启**。那是 macOS/Windows 的系统状态，真相源是
// app.getLoginItemSettings()。存副本只会产生「文件说开着、系统说关着」
// 这类不一致，而这类不一致没有合理的仲裁规则。
const fs = require("fs");
const path = require("path");

// 关窗行为三档。默认 dock：与既有行为一致（关窗 hide() 到托盘，Dock 图块保留），
// 升级不改变用户观感。
//
//   quit — 关窗即退出应用（等价托盘菜单的「退出 iRouter」）
//   dock — 关窗隐藏到托盘，Dock 图块保留（点 Dock 图块可唤回窗口）
//   tray — 关窗隐藏到托盘，Dock 图块一并隐藏（只剩托盘入口）
const CLOSE_ACTIONS = ["quit", "dock", "tray"];
const DEFAULT_CLOSE_ACTION = "dock";

const SETTINGS_FILE_NAME = "shell-settings.json";

function defaultSettings() {
  return { closeAction: DEFAULT_CLOSE_ACTION };
}

function settingsPath(dataDir) {
  return path.join(dataDir, SETTINGS_FILE_NAME);
}

/** 取值校验：非法/缺失一律回退默认，绝不抛 */
function normalize(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  return {
    closeAction: CLOSE_ACTIONS.includes(raw.closeAction)
      ? raw.closeAction
      : base.closeAction,
  };
}

function readSettings(dataDir) {
  try {
    return normalize(
      JSON.parse(fs.readFileSync(settingsPath(dataDir), "utf8")),
    );
  } catch {
    // 文件缺失（升级路径）或损坏 → 默认值。与该文件同款 fail-safe 约定。
    return defaultSettings();
  }
}

function writeSettings(dataDir, patch) {
  const next = normalize({ ...readSettings(dataDir), ...patch });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      settingsPath(dataDir),
      JSON.stringify(next, null, 2) + "\n",
    );
  } catch (e) {
    console.error(
      `[shell-settings] 写 ${settingsPath(dataDir)} 失败: ${e.message}`,
    );
  }
  return next;
}

module.exports = {
  CLOSE_ACTIONS,
  DEFAULT_CLOSE_ACTION,
  SETTINGS_FILE_NAME,
  defaultSettings,
  normalize,
  readSettings,
  writeSettings,
  settingsPath,
};
