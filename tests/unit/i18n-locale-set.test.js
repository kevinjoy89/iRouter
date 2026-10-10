// 语言集合与字典集合的一致性守卫。
//
// 这条守卫的直接来由：面板曾声明 34 种语言（`LOCALES`）而 `public/i18n/literals/`
// 下只有 6 份字典。选到其余 28 种的后果是 fetch 404 → 异常被吞 → 整片界面
// **静默回落英文**，没有任何检查会失败。声明支持却给不出字典，等于把「语言选择」
// 变成「一个让界面变回英文的开关」。
//
// 这里把三件事钉成可执行断言：
//   1. `LOCALES` 与字典文件集合**双向一致**（多一个或少一个都红）；
//   2. `normalizeLocale` 对不受支持的语言返回空串（表示「未选择」），
//      而不是回落到英文——那个区分是优先级链的前提（见 ADR 0008）；
//   3. 归一化规则与壳层 `i18n.rs` 的 `normalize` 给出同一结果。
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCALE,
  LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from "../../src/i18n/config.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LITERALS = join(REPO, "public", "i18n", "literals");

// 路径相对测试文件解析（不是 cwd）：套件既可能从仓库根跑，也可能带 --root tests 跑，
// 相对 cwd 的写法会在后者下 ENOENT（tests/unit/security-audit.test.js 踩过此坑）。
const dictionaryLocales = readdirSync(LITERALS)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length))
  .sort();

describe("语言集合与字典集合的一致性", () => {
  it("字典目录确实被读到了（防止路径失效后退化成空集合真空通过）", () => {
    expect(dictionaryLocales.length).toBeGreaterThan(0);
    expect(dictionaryLocales).toContain("zh-CN");
  });

  it("每种非英文受支持语言都有字典，且没有多余字典", () => {
    // 英文是源文，机制上不加载字典（runtime.js 对 "en" 直接返回空映射），
    // 因此它不出现在字典目录里是**正确**的，不是缺失。
    const declared = LOCALES.filter((l) => l !== "en").sort();
    expect(declared).toEqual(dictionaryLocales);
  });

  it("收窄后的集合就是这三种", () => {
    expect([...LOCALES].sort()).toEqual(["en", "zh-CN", "zh-TW"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("isSupportedLocale 只认集合内的值", () => {
    for (const l of LOCALES) expect(isSupportedLocale(l)).toBe(true);
    for (const l of ["nl", "ja", "fa", "id", "tl", "", "zh-Hans", "EN"]) {
      expect(isSupportedLocale(l), `${l} 不该被判为受支持`).toBe(false);
    }
  });
});

describe("normalizeLocale：不受支持的语言表示「未选择」", () => {
  it("受支持的语言归一化到自身", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-TW")).toBe("zh-TW");
  });

  it("zh 前缀按壳层同一规则分流（含 tw/hk/hant 判繁体）", () => {
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLocale("zh_CN.UTF-8")).toBe("zh-CN");
    expect(normalizeLocale("zh-TW")).toBe("zh-TW");
    expect(normalizeLocale("zh-HK")).toBe("zh-TW");
    expect(normalizeLocale("zh-Hant")).toBe("zh-TW");
  });

  it("英文的区域变体归到 en", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
  });

  it("已废弃的语言返回空串，而不是回落到英文", () => {
    // 这一条是本次行为的**关键变更**：此前 `nl` 会原样返回，于是 fetch 一份
    // 已删除的字典 → 404 被吞 → 静默全英文。现在它表示「未选择」，
    // 由优先级链回落到系统语言（见 ADR 0008）。
    for (const l of ["nl", "ja", "fa", "id", "tl", "de-DE", "vi", "ko"]) {
      expect(normalizeLocale(l), `${l} 应表示未选择`).toBe("");
    }
  });

  it("空值与非法输入返回空串，不抛错", () => {
    expect(normalizeLocale("")).toBe("");
    expect(normalizeLocale("   ")).toBe("");
    expect(normalizeLocale(null)).toBe("");
    expect(normalizeLocale(undefined)).toBe("");
    expect(normalizeLocale(123)).toBe("");
    expect(normalizeLocale({})).toBe("");
  });

  it("大小写与空白不敏感", () => {
    expect(normalizeLocale("  ZH-cn  ")).toBe("zh-CN");
    expect(normalizeLocale("EN")).toBe("en");
    expect(normalizeLocale("ZH-HANT")).toBe("zh-TW");
  });
});
