// 「脱敏策略」卡片的 i18n 覆盖守卫。
//
// 背景：该卡片首版全部文案漏入字典，中文界面整片显示英文。事后在 desktop/main.js
// 的冒烟探针里加了抽查（几个关键词），但抽查只能覆盖被点名的串——新增或漏译的
// 文案照样溜过去，而冒烟只在打包后跑，代价高。
//
// 本文件把三件事钉在一起，任一处漂移即红：
//   1. 卡片源码里出现的英文源串（用户可见的那些）都在 zh-CN / zh-TW 字典里；
//   2. 冒烟探针的 CARD_SOURCES 清单与卡片源码一致（不许多、不许少）；
//   3. 字典里这些串的译文确实不是英文（防「值 == 键」的占位式入典）。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE = join(
  REPO,
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "profile",
  "page.js",
);
const MAIN = join(REPO, "desktop", "main.js");

/** 卡片在源码里的文本，从「Redaction Policy」注释到该 Card 收尾 */
function readCardSource() {
  const src = readFileSync(PROFILE, "utf8");
  const start = src.indexOf("{/* Redaction Policy");
  expect(
    start,
    "找不到「脱敏策略」卡片起点（注释被改？同步更新本测试的锚点）",
  ).toBeGreaterThan(-1);
  const end = src.indexOf("</Card>", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** 从卡片源码里抽出「会被 runtime i18n 翻译」的英文源串 */
function extractCardSourceStrings() {
  const card = readCardSource();
  const out = new Set();

  // Select 的 label 与 options[].label
  for (const m of card.matchAll(/\blabel="([^"]{4,})"/g)) out.add(m[1]);
  for (const m of card.matchAll(/\blabel:\s*"([^"]{4,})"/g)) out.add(m[1]);
  // JSX 文本节点：单行 <p>…</p> 与 <h3>…</h3>
  for (const m of card.matchAll(/>\s*([A-Z][^<>{}\n]{6,}?)\s*</g))
    out.add(m[1].trim());
  // 多行 JSX 文本节点（描述句会被换行切开，需归一化空白）
  for (const m of card.matchAll(
    /text-text-muted">\s*\n\s*([^<]+?)\s*\n?\s*<\/p>/g,
  )) {
    out.add(m[1].replace(/\s+/g, " ").trim());
  }
  // 具名短串（小写开头，不会命中上面的 <p> 规则）：豁免示例的说明文字
  for (const m of card.matchAll(/>\s*([a-z][a-z ,]{6,}?)\s*<\//g))
    out.add(m[1].trim());

  return [...out].sort();
}

/** 冒烟探针内联的 CARD_SOURCES 清单 */
function readSmokeSources() {
  const src = readFileSync(MAIN, "utf8");
  const start = src.indexOf("const CARD_SOURCES = [");
  expect(
    start,
    "冒烟探针里的 CARD_SOURCES 不见了（被改名？同步更新本测试）",
  ).toBeGreaterThan(-1);
  const end = src.indexOf("];", start);
  const body = src.slice(start, end);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`))
    .sort();
}

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

describe("脱敏卡片 i18n 覆盖", () => {
  const cardStrings = extractCardSourceStrings();

  it("抽到了卡片文案（防止抽取逻辑静默失效）", () => {
    // 抽取失败会退化成空数组 → 下面的断言全部真空通过
    expect(cardStrings.length).toBeGreaterThanOrEqual(10);
    expect(cardStrings).toContain("Redaction Policy");
    expect(cardStrings).toContain("Match stored credentials");
  });

  for (const loc of LOCALES) {
    it(`${loc} 字典覆盖卡片的全部英文源串`, () => {
      const dict = dictionaries[loc];
      const missing = cardStrings.filter((s) => !(s in dict));
      expect(
        missing,
        `未入典：${missing.map((s) => JSON.stringify(s.slice(0, 60))).join(", ")}`,
      ).toEqual([]);
    });

    it(`${loc} 字典里这些串确实译成了中文（防占位式入典）`, () => {
      const dict = dictionaries[loc];
      // 译文与源串相同 = 只是把英文抄了一份，用户界面不会变中文
      const untranslated = cardStrings.filter((s) => dict[s] === s);
      expect(untranslated).toEqual([]);
      // 至少含一个 CJK 字符，否则不是中文译文
      const nonCjk = cardStrings.filter(
        (s) => !/[\u4e00-\u9fff]/.test(dict[s] || ""),
      );
      expect(nonCjk, `译文不含中文：${nonCjk.join(", ")}`).toEqual([]);
    });
  }

  it("冒烟探针的 CARD_SOURCES 与卡片源码完全一致", () => {
    // 探针少列一条 → 该条漏译时冒烟仍绿；多列一条 → 卡片改名后探针断言失效。
    expect(readSmokeSources()).toEqual(cardStrings);
  });
});
