// 提供商详情页两个组件的 i18n 覆盖守卫。
//
// 来由（用户实测两处漏译）：
//   1. 「Custom Headers」卡片整片英文；
//   2. 「添加自定义模型」面板只译了一部分（标题/按钮是中文，中间的能力项、STT 说明、
//      传输方式等仍是英文）。
//
// 面板 i18n 是「按文本节点精确匹配字典」的机制（见 src/i18n/runtime.js）：
// 源码里写英文、字典里给译文、MutationObserver 在挂载时替换。**缺一条就永远显示英文，
// 且没有任何检查会失败** —— 所以漏译只能靠这种全量比对来兜。
//
// 本文件钉三件事，任一处漂移即红：
//   1. 两个组件源码里用户可见的英文源串都在 zh-CN / zh-TW 字典里；
//   2. 译文确实是中文（防「值 == 键」的占位式入典）；
//   3. 能力/传输方式的文案来自 shared/constants/models.js，那些也要入典
//      （它们经 Toggle/Select 渲染成文本节点，走同一条翻译路径）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER_DIR = "src/app/(dashboard)/dashboard/providers/[id]";

const FILES = {
  "Custom Headers 卡片": `${PROVIDER_DIR}/CustomConfigCard.js`,
  "添加自定义模型面板": `${PROVIDER_DIR}/AddCustomModelModal.js`,
  "能力/传输方式常量": "src/shared/constants/models.js",
};

const LOCALES = ["zh-CN", "zh-TW"];
const dictionaries = Object.fromEntries(
  LOCALES.map((loc) => [
    loc,
    JSON.parse(readFileSync(join(REPO, "public", "i18n", "literals", `${loc}.json`), "utf8")),
  ]),
);

/**
 * 抽取会被 runtime i18n 翻译的英文源串。
 *
 * 覆盖面刻意做宽：`title` / `placeholder` / `hint` 这些**属性**同样在
 * MutationObserver 的 attributeFilter 里（runtime.js 的 `["title", "placeholder"]`），
 * 所以缺条目一样静默显示英文 —— 「Custom Headers」卡片里就有 3 条 title
 * （Overridden / Registry default / Remove header）和 2 条 placeholder。
 */
function extractSourceStrings(rel) {
  const src = readFileSync(join(REPO, rel), "utf8");
  const out = new Set();

  // 显式 translate() 调用
  for (const m of src.matchAll(/\btranslate\(\s*"([^"]{2,})"/g)) out.add(m[1]);
  // 属性载体：label / hint / description / title / placeholder
  for (const m of src.matchAll(/\b(?:label|hint|description|title|placeholder)="([^"]{2,})"/g))
    out.add(m[1]);
  // 对象字面量里的 label/desc（models.js 的 CAPACITY_META / STT_TRANSPORT_META）
  for (const m of src.matchAll(/\b(?:label|desc):\s*"([^"]{2,})"/g)) out.add(m[1]);
  // 三元 / 短路后的文案
  for (const m of src.matchAll(/(?:\?\?|\|\||[?:])\s*"([A-Z][^"]{3,})"/g)) out.add(m[1]);
  // JSX 文本节点：换行包裹
  for (const m of src.matchAll(/>\s*\n\s*([A-Z][^<>{}\n]{1,200}?)\s*\n\s*</g))
    out.add(m[1].replace(/\s+/g, " ").trim());
  // JSX 文本节点：同行（要求含空格或省略号，避免把组件名/变量名当文案）
  for (const m of src.matchAll(/>([A-Z][^<>{}"'\n]{3,200}?)</g)) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (/[ .]/.test(t)) out.add(t);
  }
  // JSX 表达式里的字符串字面量（"..." 出现在 {} 中）
  for (const m of src.matchAll(/\{\s*"([A-Z][^"]{3,})"\s*\}/g)) out.add(m[1]);

  return [...out].sort();
}

// 专名 / 非文案：语言名按惯例用自身文字显示；HTTP 方法名与方法签名不是文案。
const NOT_TRANSLATABLE = new Set(["English", "简体中文", "繁體中文", "POST", "GET", "PUT", "DELETE"]);

describe("提供商详情页 i18n 覆盖", () => {
  for (const [label, rel] of Object.entries(FILES)) {
    const strings = extractSourceStrings(rel);

    it(`${label}：抽到了文案（防止抽取逻辑静默失效）`, () => {
      // 抽取失败会退化成空数组 → 下面的断言全部真空通过
      expect(strings.length, `${rel} 应抽到多条源串`).toBeGreaterThanOrEqual(4);
    });

    for (const loc of LOCALES) {
      it(`${label}：${loc} 字典覆盖全部英文源串`, () => {
        const dict = dictionaries[loc];
        const missing = strings.filter((s) => !NOT_TRANSLATABLE.has(s) && !(s in dict));
        expect(
          missing,
          `未入典（缺了就静默显示英文）：${missing.map((s) => JSON.stringify(s)).join(", ")}`,
        ).toEqual([]);
      });

      it(`${label}：${loc} 译文确实是中文（防占位式入典）`, () => {
        const dict = dictionaries[loc];
        const translatable = strings.filter((s) => !NOT_TRANSLATABLE.has(s));
        // 值 == 键：只是把英文抄了一份，界面不会变中文
        const untranslated = translatable.filter((s) => dict[s] === s);
        expect(untranslated, `译文与源串相同：${untranslated.join(", ")}`).toEqual([]);
        // 至少含一个 CJK 字符
        const nonCjk = translatable.filter((s) => !/[\u4e00-\u9fff]/.test(dict[s] || ""));
        expect(nonCjk, `译文不含中文：${nonCjk.join(", ")}`).toEqual([]);
      });
    }
  }

  // 用户明确点名的两处：钉住具体串，防止将来有人「优化」抽取规则把它们漏掉
  it("用户报告的两处漏译已入典", () => {
    for (const loc of LOCALES) {
      const dict = dictionaries[loc];
      for (const key of [
        "Custom Headers", // 报告 2：Custom Headers 未实现多语言
        "Speech to text", // 报告 3：自定义模型面板漏译
        "Transport",
        "Model is reachable",
      ]) {
        expect(dict[key], `${loc} 缺 ${JSON.stringify(key)}`).toBeTruthy();
      }
    }
  });
});
