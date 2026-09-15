// 壳层设置模态框的 i18n 覆盖守卫。
//
// 这条守卫的直接来由：第一版设置面板（独立的 Electron 窗口 + 网关侧 /settings 页）
// 完全没有接入面板的多语言 runtime——中文界面下满屏英文，且没有任何检查会失败。
// 面板的 runtime i18n 是「按文本节点精确匹配字典」的机制（见 src/i18n/runtime.js）：
// 源码里写英文、字典里给译文、MutationObserver 在挂载时替换。所以缺一条字典条目
// 的后果就是那一条永远显示英文，静默无声。
//
// 这里把「模态框源码里出现的英文源串都在字典里」钉成可执行断言。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODAL = join(
  REPO,
  "src",
  "shared",
  "components",
  "ShellSettingsModal.js",
);

/** 抽模态框源码里会被 runtime i18n 翻译的英文源串 */
function extractSourceStrings() {
  const src = readFileSync(MODAL, "utf8");
  const out = new Set();

  // 选项数组：{ value: "...", label: "..." }
  for (const m of src.matchAll(/\blabel:\s*"([^"]{2,})"/g)) out.add(m[1]);
  // Row 的 label= / hint= 属性
  for (const m of src.matchAll(/\blabel="([^"]{2,})"/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bhint="([^"]{2,})"/g)) out.add(m[1]);
  for (const m of src.matchAll(
    /\bhint=\{\s*\n?\s*shell\.closeAction === "quit"\s*\n?\s*\?\s*"([^"]+)"/g,
  ))
    out.add(m[1]);
  for (const m of src.matchAll(
    /\?\s*"([A-Z][^"]{6,})"\s*\n?\s*:\s*"([A-Z][^"]{6,})"/g,
  )) {
    out.add(m[1]);
    out.add(m[2]);
  }
  // Modal 的 title=
  for (const m of src.matchAll(/\btitle="([^"]{2,})"/g)) out.add(m[1]);
  // 长文案节点（JSX 文本）：<div ...>Some sentence.</div>
  for (const m of src.matchAll(
    />\s*\n\s*([A-Z][^<>{}\n]{12,}?)\s*\n\s*<\/div>/g,
  ))
    out.add(m[1].replace(/\s+/g, " ").trim());
  // 组件子文本节点（<Button ...>Open</Button>）：短、且被换行包着，
  // 上面那条按长度 ≥12 的规则会漏掉。
  for (const m of src.matchAll(
    /<[A-Z][A-Za-z]*\b[^>]*>\s*\n\s*([A-Z][A-Za-z]{1,20}?)\s*\n\s*<\/[A-Z][A-Za-z]*>/g,
  ))
    out.add(m[1].trim());

  return [...out].sort();
}

const LOCALES = ["zh-CN", "zh-TW"];

// 语言名是专名，惯例是用它自己的文字显示（macOS / VS Code / 浏览器都如此）。
// 它们出现在选项里但不该入典：`translate()` 找不到键会原样返回，正是想要的结果。
// 两条断言都豁免，而不是只豁免「含中文」那一条。
const PROPER_NOUNS = new Set(["English", "简体中文", "繁體中文"]);

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

describe("壳层设置模态框 i18n 覆盖", () => {
  const strings = extractSourceStrings();

  it("抽到了模态框文案（防止抽取逻辑静默失效）", () => {
    // 抽取失败会退化成空数组 → 下面的断言全部真空通过
    expect(strings.length).toBeGreaterThanOrEqual(8);
    expect(strings).toContain("Settings");
    expect(strings).toContain("Theme");
    expect(strings).toContain("Language");
    expect(strings).toContain("Launch at Login");
    expect(strings).toContain("When closing the window");
    // 按钮文本也是会被翻译的文本节点，抽取必须覆盖到
    expect(strings).toContain("Close");
    expect(strings).toContain("Open");
  });

  it("主题与语言的选项文案已入典", () => {
    // 这两个是用户最先看到的下拉/分段项，缺了就整片英文
    for (const k of ["Light", "Dark", "Follow system", "English"]) {
      expect(strings, `源码里应有 ${k}`).toContain(k);
    }
  });

  for (const loc of LOCALES) {
    it(`${loc} 字典覆盖模态框的全部英文源串`, () => {
      const dict = dictionaries[loc];
      const missing = strings.filter(
        (s) => !PROPER_NOUNS.has(s) && !(s in dict),
      );
      expect(
        missing,
        `未入典：${missing.map((s) => JSON.stringify(s)).join(", ")}`,
      ).toEqual([]);
    });

    it(`${loc} 字典里这些串确实译成了中文（防占位式入典）`, () => {
      const dict = dictionaries[loc];
      const translated = strings.filter((s) => !PROPER_NOUNS.has(s));
      const untranslated = translated.filter((s) => dict[s] === s);
      expect(
        untranslated,
        `译文与源串相同：${untranslated.join(", ")}`,
      ).toEqual([]);
      const nonCjk = translated.filter(
        (s) => !/[\u4e00-\u9fff]/.test(dict[s] || ""),
      );
      expect(nonCjk, `译文不含中文：${nonCjk.join(", ")}`).toEqual([]);
    });
  }
});

describe("壳层设置模态框：结构与接线", () => {
  const src = readFileSync(MODAL, "utf8");

  it("模态框读的是面板的 themeStore，不是自带一套主题状态", () => {
    // 第一版的错误：独立窗口用自己的 document，改主题只影响它自己
    expect(src).toMatch(/from "@\/store\/themeStore"/);
    expect(src).toMatch(/useThemeStore\(\)/);
  });

  it("语言切换调用 reloadTranslations，就地重译整个 DOM", () => {
    expect(src).toMatch(/from "@\/i18n\/runtime"/);
    expect(src).toMatch(/await reloadTranslations\(\)/);
  });

  it("壳层专属项按 window.irouterShell 是否存在决定渲染（浏览器下不出现）", () => {
    expect(src).toMatch(/window\.irouterShell/);
    // 关窗行为与开机自启都必须包在这个条件里
    const gateIdx = src.indexOf("isShell && shell");
    expect(gateIdx, "缺少 isShell 判定").toBeGreaterThan(-1);
    const gated = src.slice(gateIdx);
    expect(gated).toMatch(/Launch at Login/);
    expect(gated).toMatch(/When closing the window/);
  });

  it("保留交通灯关闭按钮（关掉后 macOS 上无法关闭）", () => {
    // Modal 的 X 按钮带 `md:hidden`，只在窄屏出现；宽屏下交通灯是唯一关闭入口。
    expect(src, "不得写 showTrafficLights={false}").not.toMatch(
      /showTrafficLights=\{false\}/,
    );
  });

  it("点遮罩不关闭（设置项是即时生效的开关，误触不该丢）", () => {
    expect(src).toMatch(/closeOnOverlay=\{false\}/);
  });

  it("有显式关闭按钮（交通灯红点太小且需悬停才显形）", () => {
    const footerIdx = src.indexOf("footer={");
    expect(footerIdx, "缺少 footer 关闭按钮").toBeGreaterThan(-1);
    const footer = src.slice(footerIdx, footerIdx + 200);
    expect(footer).toMatch(/onClick=\{onClose\}/);
    expect(footer).toMatch(/Close/);
  });
});

describe("壳层设置模态框：挂载点", () => {
  it("挂在 root layout（菜单栏 Cmd+, 在登录页也要能开）", () => {
    const layout = readFileSync(join(REPO, "src", "app", "layout.js"), "utf8");
    expect(layout).toMatch(/ShellSettingsHost/);
  });

  it("不再是独立路由页面（那会重新引入第二份 document）", () => {
    const { existsSync } = require("node:fs");
    expect(
      existsSync(join(REPO, "src", "app", "settings", "page.js")),
      "src/app/settings/page.js 应已删除",
    ).toBe(false);
  });
});
