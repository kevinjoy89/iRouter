// 壳层设置的存取与校验。
//
// 壳层在这之前零单测（main.js 顶部 import Electron，无法被 vitest require）。
// 设置逻辑被抽到 desktop/settings.js 正是为了这个文件——纯 CommonJS，可直接 require。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CLOSE_ACTIONS,
  DEFAULT_CLOSE_ACTION,
  SETTINGS_FILE_NAME,
  defaultSettings,
  normalize,
  readSettings,
  writeSettings,
  settingsPath,
} = require("../../desktop/settings.js");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "irouter-shell-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("壳层设置：默认值与校验", () => {
  it("默认关窗行为是 dock（与历史行为一致，升级不改观感）", () => {
    expect(DEFAULT_CLOSE_ACTION).toBe("dock");
    expect(defaultSettings()).toEqual({ closeAction: "dock" });
  });

  it("三档取值全部合法（与 /settings 页面的 CLOSE_ACTIONS 对应）", () => {
    expect(CLOSE_ACTIONS).toEqual(["quit", "dock", "tray"]);
    for (const action of CLOSE_ACTIONS) {
      expect(normalize({ closeAction: action }).closeAction).toBe(action);
    }
  });

  it("非法取值回退默认，不抛", () => {
    expect(normalize({ closeAction: "nope" }).closeAction).toBe("dock");
    expect(normalize({ closeAction: 42 }).closeAction).toBe("dock");
    expect(normalize({ closeAction: null }).closeAction).toBe("dock");
  });

  it("非对象输入回退默认（null / 数组 / 字符串）", () => {
    for (const bad of [null, undefined, [], "quit", 7]) {
      expect(normalize(bad)).toEqual({ closeAction: "dock" });
    }
  });

  it("不认识的键被丢弃（防止旧版本字段遗留）", () => {
    expect(normalize({ closeAction: "tray", legacyKey: true })).toEqual({
      closeAction: "tray",
    });
  });
});

describe("壳层设置：文件读写", () => {
  it("文件不存在时读默认值（升级路径）", () => {
    expect(readSettings(dir)).toEqual({ closeAction: "dock" });
  });

  it("写入后可读回", () => {
    writeSettings(dir, { closeAction: "tray" });
    expect(readSettings(dir)).toEqual({ closeAction: "tray" });
  });

  it("写入是合并式的，不会丢掉未提及的键", () => {
    writeSettings(dir, { closeAction: "quit" });
    writeSettings(dir, {});
    expect(readSettings(dir).closeAction).toBe("quit");
  });

  it("文件损坏时读默认值（fail-safe，不抛）", () => {
    writeFileSync(settingsPath(dir), "{ not json");
    expect(readSettings(dir)).toEqual({ closeAction: "dock" });
  });

  it("目录不存在时写入会创建它", () => {
    const nested = join(dir, "a", "b");
    writeSettings(nested, { closeAction: "quit" });
    expect(readSettings(nested).closeAction).toBe("quit");
  });

  it("落盘内容是规范化后的结果，不是原始输入", () => {
    writeSettings(dir, { closeAction: "bogus" });
    const raw = JSON.parse(readFileSync(join(dir, SETTINGS_FILE_NAME), "utf8"));
    expect(raw).toEqual({ closeAction: "dock" });
  });

  it("文件名固定在 dataDir 下（与 .gateway.pid 同类）", () => {
    expect(settingsPath("/tmp/x")).toBe(join("/tmp/x", "shell-settings.json"));
  });
});
