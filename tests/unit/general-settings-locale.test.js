import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readLocalePreference } from "../../src/i18n/config.js";
import { translateDynamicPatterns } from "../../src/i18n/runtime.js";

/**
 * 通用设置多语言偏好与动态翻译单测
 *
 * @author wei
 * @since 2026-10-16
 */
describe("GeneralSettings 多语言偏好判定与跟随系统", () => {
  const originalWindow = global.window;
  const originalDocument = global.document;

  beforeEach(() => {
    // 模拟纯净浏览器环境
    global.window = { ...originalWindow };
    global.document = { cookie: "" };
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
  });

  it("桌面壳层下未显式配置语言时应返回 system（不被 cookie 中的 APP_LOCALE 污染）", () => {
    global.window.irouterShell = { setSetting: () => {} };
    // 即使 cookie 被写入了系统生效语言 zh-CN
    global.document.cookie = "locale=zh-CN; path=/";

    // 1. shell 为 null（未完成加载）
    expect(readLocalePreference(null)).toBe("system");

    // 2. shell.locale 为 null（用户未显式选择）
    expect(readLocalePreference({ locale: null })).toBe("system");

    // 3. shell.locale 为空串（跟随系统）
    expect(readLocalePreference({ locale: "" })).toBe("system");
  });

  it("桌面壳层下显式选择了受支持语言时应正确返回对应语言", () => {
    global.window.irouterShell = { setSetting: () => {} };
    expect(readLocalePreference({ locale: "zh-CN" })).toBe("zh-CN");
    expect(readLocalePreference({ locale: "en" })).toBe("en");
    expect(readLocalePreference({ locale: "zh-TW" })).toBe("zh-TW");
  });

  it("Web 浏览器形态下根据 cookie 判定，无 cookie 时返回 system", () => {
    delete global.window.irouterShell;

    // 无 cookie 或跟随系统清除后
    global.document.cookie = "";
    expect(readLocalePreference(null)).toBe("system");

    // 显式指定 cookie
    global.document.cookie = "locale=en; path=/";
    expect(readLocalePreference(null)).toBe("en");

    global.document.cookie = "locale=zh-CN; path=/";
    expect(readLocalePreference(null)).toBe("zh-CN");
  });

  it("models.dev 模型跟踪计数与同步状态动态翻译正确包含空格与中文", () => {
    // 简体中文
    expect(translateDynamicPatterns("3640 models tracked", "zh-CN")).toBe("已收录 3640 个模型");
    expect(translateDynamicPatterns("Synchronized 3640 models from models.dev", "zh-CN")).toBe("已从 models.dev 同步 3640 个模型");
    expect(translateDynamicPatterns("Updated 2026/10/16", "zh-CN")).toBe("已更新 2026/10/16");

    // 繁体中文
    expect(translateDynamicPatterns("3640 models tracked", "zh-TW")).toBe("已收錄 3640 個模型");
    expect(translateDynamicPatterns("Synchronized 3640 models from models.dev", "zh-TW")).toBe("已從 models.dev 同步 3640 個模型");
    expect(translateDynamicPatterns("Updated 2026/10/16", "zh-TW")).toBe("已更新 2026/10/16");

    // 英文原文保持不变
    expect(translateDynamicPatterns("3640 models tracked", "en")).toBe("3640 models tracked");
  });
});
