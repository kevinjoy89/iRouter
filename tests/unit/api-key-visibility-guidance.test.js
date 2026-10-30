// API Key 可见性提示的 i18n 覆盖守卫。
//
// 背景：上游 `a3ca2f9b` 把 API Key 创建弹窗的提示语从
//   "This is the only time you will see this key. Store it securely."
// 改为
//   "Store this key securely. You can view or copy it later from the API Keys list."
// 并同步了 fa / id / km / pt-BR / th / zh-CN 六份字典——**唯独漏了 zh-TW**。
// 后果是繁体界面下该提示会原样显示英文，而且旧键已被删除、连旧译文都不会回退命中。
//
// 本项目的语言集合只有 en / zh-CN / zh-TW 三种（英文是源文本），所以这里把三件事
// 钉在一起，任一处漂移即红：
//   1. 弹窗源码里用的是**新串**，旧串已彻底消失（防「改了源码忘了改字典」或反向）；
//   2. 新串在 zh-CN 与 zh-TW 字典里都存在（防漏译，本用例的主要来由）；
//   3. 两份译文都不等于英文原串（防「值 == 键」的占位式入典）。
//
// 与 `dlp-i18n-coverage.test.js` 同源：那一个是卡片级抽取，这一个只针对单条文案，
// 因为缺口正是「上游以为改完了」的单条遗漏——这类不会触发任何抽取式的批量断言。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE = join(
  REPO,
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "endpoint",
  "EndpointPageClient.js",
);

const NEW_STRING =
  "Store this key securely. You can view or copy it later from the API Keys list.";
const OLD_STRING =
  "This is the only time you will see this key. Store it securely.";

const LOCALES = ["zh-CN", "zh-TW"];
const dictionaries = Object.fromEntries(
  LOCALES.map((loc) => [
    loc,
    JSON.parse(
      readFileSync(
        join(REPO, "public", "i18n", "literals", `${loc}.json`),
        "utf8",
      ),
    ),
  ]),
);

describe("API Key 可见性提示 i18n 覆盖", () => {
  it("弹窗源码使用新串，旧串已不存在", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain(NEW_STRING);
    expect(src).not.toContain(OLD_STRING);
  });

  it("新串已全部移除（旧键不该残留在字典里）", () => {
    // 旧键在源码里已无消费方，留着只会让字典与源码各说各话
    for (const loc of LOCALES) {
      expect(
        OLD_STRING in dictionaries[loc],
        `${loc} 字典仍保留已废弃的旧串键`,
      ).toBe(false);
    }
  });

  for (const loc of LOCALES) {
    it(`${loc} 字典收录了新串且译文不是英文`, () => {
      const dict = dictionaries[loc];
      expect(dict, `${loc} 字典缺少新串（这正是上游 zh-TW 的缺口）`).toHaveProperty(
        NEW_STRING,
      );
      const translated = dict[NEW_STRING];
      expect(
        translated,
        `${loc} 的译文仍是英文原串，等于没翻译`,
      ).not.toBe(NEW_STRING);
      // 至少要有汉字，挡掉「英文加个句号」这类无效翻译
      expect(
        /[\u4e00-\u9fff]/.test(translated),
        `${loc} 的译文里没有汉字：${translated}`,
      ).toBe(true);
    });
  }
});
