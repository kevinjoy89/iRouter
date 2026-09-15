// 壳层菜单文案的一致性守卫。
//
// 壳层的 MENU_TRANSLATIONS 独立于面板字典，且**只维护 en / zh-CN / zh-TW 三种**；
// 其余语言一律由 getMenuI18n 用英文兜底。故本文件守卫两件事：
//   1. 中文三语都译了新增的键（发布面完整）；
//   2. 兜底合并真的存在（缺键显示英文，而不是 undefined）。
//
// MENU_TRANSLATIONS 及其取值函数都定义在 desktop/main.js 内部且未导出，而 main.js
// 顶部 import Electron 无法被 require。故这里从**源码文本**中解析——不是理想做法，
// 但壳层 i18n 是纯数据，解析比为了测试去重构 main.js 的导出面更小的侵入。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = join(REPO, "desktop", "main.js");
const src = readFileSync(MAIN, "utf8");

/** 抽出 `const MENU_TRANSLATIONS = { ... };` 的对象字面量各语言顶层键与各自的键 */
function parseTranslations() {
  const start = src.indexOf("const MENU_TRANSLATIONS = {");
  expect(
    start,
    "MENU_TRANSLATIONS 不见了（改名？同步更新本测试）",
  ).toBeGreaterThan(-1);
  const end = src.indexOf("\n};", start);
  expect(end, "MENU_TRANSLATIONS 的结尾没找到").toBeGreaterThan(start);
  const body = src.slice(start, end);

  const locales = {};
  // 语言块：`en: {` 或 `"zh-CN": {`
  const re = /^ {2}"?([A-Za-z][A-Za-z-]*)"?:\s*\{$/gm;
  const marks = [...body.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1];
    const from = marks[i].index + marks[i][0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : body.length;
    const chunk = body.slice(from, to);
    const keys = [...chunk.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9_]*):/gm)].map(
      (m) => m[1],
    );
    locales[name] = keys;
  }
  return locales;
}

const translations = parseTranslations();
const locales = Object.keys(translations);

describe("壳层菜单 i18n 完整性", () => {
  it("解析到了语言字典（防止解析逻辑静默失效）", () => {
    // 解析失败会退化成空对象 → 下面的断言全部真空通过
    expect(locales.length).toBeGreaterThanOrEqual(3);
    expect(locales).toContain("en");
    expect(locales).toContain("zh-CN");
    expect(locales).toContain("zh-TW");
  });

  it("每种语言都没有英文之外的意外多余键（防止写错键名）", () => {
    const en = translations.en;
    const extra = {};
    for (const loc of locales) {
      const surplus = translations[loc].filter((k) => !en.includes(k));
      if (surplus.length) extra[loc] = surplus;
    }
    expect(extra, `多余键：${JSON.stringify(extra)}`).toEqual({});
  });

  it("新增键允许暂缺：getMenuI18n 以英文兜底合并（缺 key 不会显示 undefined）", () => {
    // 既定策略：菜单键只维护 en/zh-CN/zh-TW，其余语言回退英文。
    // 本用例钉住那个兜底真的存在——否则缺键会渲染成 undefined。
    const fn = src.slice(
      src.indexOf("function getMenuI18n"),
      src.indexOf("function buildMenuTemplate"),
    );
    expect(fn, "getMenuI18n 丢了 en 兜底合并").toMatch(
      /\{\s*\.\.\.MENU_TRANSLATIONS\.en/,
    );
  });

  it("中文三种语言齐全地译了 settings（发布时至少这两种要全）", () => {
    for (const loc of ["en", "zh-CN", "zh-TW"]) {
      expect(translations[loc], `${loc} 缺少 settings`).toContain("settings");
    }
  });

  it("zh-CN 与 zh-TW 的 settings 文案确实译成了中文", () => {
    const pick = (loc, key) => {
      const m = src.match(
        new RegExp(
          `"${loc}":\\s*\\{[\\s\\S]*?^\\s{4}${key}:\\s*"([^"]+)"`,
          "m",
        ),
      );
      return m ? m[1] : null;
    };
    for (const loc of ["zh-CN", "zh-TW"]) {
      const value = pick(loc, "settings");
      expect(value, `${loc}.settings 未找到`).toBeTruthy();
      expect(value, `${loc}.settings 未含中文`).toMatch(/[\u4e00-\u9fff]/);
      // 「设置…」/「設定…」而非抄一份英文
      expect(value).not.toBe("Settings…");
    }
  });
});
