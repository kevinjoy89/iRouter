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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODAL_REL = "src/shared/components/ShellSettingsModal.js";
const MODAL = join(REPO, MODAL_REL);
const SETTINGS_DIR = join(REPO, "src", "shared", "components", "settings");

// 面板本体 + settings/ 下的全部文件。
//
// 早先这里是手写的文件清单，2026-09-29 面板拆成「模态框 + 每段一个文件」后，
// 手写清单立刻会漏——漏掉的文件里的文案缺字典条目是**静默**的（英文原文照显）。
// 改成扫目录：新增分段文件自动纳入守卫，不再依赖有人记得改清单。
const SETTINGS_FILES = [
  MODAL_REL,
  ...readdirSync(SETTINGS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => `src/shared/components/settings/${f}`),
];

/** 抽设置面板源码里会被 runtime i18n 翻译的英文源串 */
function extractSourceStrings() {
  const out = new Set();
  for (const rel of SETTINGS_FILES) {
    collectFrom(readFileSync(join(REPO, rel), "utf8"), out);
  }
  return [...out].sort();
}

/** 从一份源码里抽取可翻译源串，累加进 out */
function collectFrom(src, out) {

  // translate("...") 显式调用的片段（动态文案用它们拼接，缺条目就显示英文）
  for (const m of src.matchAll(/\btranslate\(\s*"([^"]{2,})"/g)) out.add(m[1]);
  // 选项数组与分段表：{ value: "...", label: "..." } / { key: "...", label: "..." }
  for (const m of src.matchAll(/\blabel:\s*"([^"]{2,})"/g)) out.add(m[1]);
  // Row 的 label= / hint= 属性
  for (const m of src.matchAll(/\blabel="([^"]{2,})"/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bhint="([^"]{2,})"/g)) out.add(m[1]);
  // SectionHeader 的 title= / description= 属性
  for (const m of src.matchAll(/\bdescription="([^"]{2,})"/g)) out.add(m[1]);
  // 行内三元表达式里的两句 hint（关窗行为那句）
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
  // 变量赋值与对象字面量里的文案（`? "..."` / `: "..."` / `|| "..."` / `?? "..."`）。
  // 页脚那行「有新版本 / 已是最新」是嵌套三元，上面那条只认成对的两个分支，
  // 会漏掉它；这里补一条只看「问号/冒号/短路后面紧跟一个大写起头的串」的规则。
  // 误伤很小：HTTP 头、MIME 类型、console.error 的首参都是小写或落在括号里。
  for (const m of src.matchAll(/(?:\?\?|\|\||[?:])\s*"([A-Z][^"]{6,})"/g))
    out.add(m[1]);
  // Modal 的 title=
  for (const m of src.matchAll(/\btitle="([^"]{2,})"/g)) out.add(m[1]);
  // JSX 文本节点：被换行包着、以大写字母起头的英文串。
  //
  // 不解析开标签。早先这里拆成两条——长文案按 ≥13 字符匹配 `</div>`、短组件
  // 文本按纯字母匹配——两处都有缝：按 `[^>]*>` 匹配标签头会被属性里的箭头函数
  // 提前截断（`onClick={() => ...}` 的 `=>`），含箭头函数的按钮文案因此漏抽；
  // 而 12 字符的标签正好掉进“长”“短”两档之间。只看 `> \n 文本 \n <` 这个
  // 形状，两处缝一并消失。
  //
  // 长度上限放到 200：设置段里最长的说明（存储的清理提示）超过 60 字符，
  // 卡在 60 会让它悄悄逃出守卫。字符类已排除 `{`/`}`/`<`/`>`/换行，
  // 放宽长度不会把 JSX 表达式或标签吞进来。
  for (const m of src.matchAll(
    />\s*\n\s*([A-Z][^<>{}\n]{1,200}?)\s*\n\s*</g,
  ))
    out.add(m[1].replace(/\s+/g, " ").trim());
  // 同行写法：`<span className="...">Downloading update...</span>` 这类文本没被换行
  // 包着，上面那条抽不到——「正在下载更新」就是这么漏掉整条多语言的（用户实测）。
  // 只在标签之间取，且要求以大写字母起头、含空格或省略号，避免把属性值与
  // 变量名当成文案；`{...}` 表达式用字符类排除。
  for (const m of src.matchAll(/>([A-Z][^<>{}"'\n]{3,200}?)</g)) {
    const text = m[1].replace(/\s+/g, " ").trim();
    // 单字（含大写开头的组件名残留）不算文案；含空格或句末省略号的才算，
    // 这样 "Downloading update..." 会带着省略号一起入典（键必须逐字一致）
    if (/[ .]/.test(text)) out.add(text);
  }
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
    expect(strings).toContain("Apply");
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

// 面板拆成「模态框（布局/导航）+ 每段一个文件」后，这些契约各自落在哪个文件变了，
// 但契约本身不变，逐条跟着搬家。读文件的地方一律走 settingsSrc()，方便后续再拆。
const readPanel = (name) =>
  readFileSync(join(SETTINGS_DIR, name), "utf8");

describe("壳层设置模态框：结构与接线", () => {
  const src = readFileSync(MODAL, "utf8");

  it("外观段读的是面板的 themeStore，不是自带一套主题状态", () => {
    // 第一版的错误：独立窗口用自己的 document，改主题只影响它自己
    const appearance = readPanel("AppearanceSettings.js");
    expect(appearance).toMatch(/from "@\/store\/themeStore"/);
    expect(appearance).toMatch(/useThemeStore\(\)/);
  });

  it("语言切换调用 reloadTranslations，就地重译整个 DOM", () => {
    const appearance = readPanel("AppearanceSettings.js");
    expect(appearance).toMatch(/from "@\/i18n\/runtime"/);
    expect(appearance).toMatch(/await reloadTranslations\(\)/);
  });

  it("壳层专属段按 window.irouterShell 是否存在决定是否进导航（浏览器下不出现）", () => {
    expect(src).toMatch(/window\.irouterShell/);
    expect(src).toMatch(/Boolean\(window\.irouterShell\)/);
    // 软件更新段必须带 shellOnly，并在 shellReady 为真时才进导航
    for (const key of ["updates"]) {
      const entry = src.slice(src.indexOf(`key: "${key}"`));
      expect(entry.slice(0, 240), `${key} 段缺少 shellOnly`).toMatch(
        /shellOnly: true/,
      );
    }
    expect(src).toMatch(/SECTIONS\.filter\(\(s\) => !s\.shellOnly \|\| shellReady\)/);
  });

  it("窗口行为两项都落在通用段里（跟着分段走，不在模态框内联）", () => {
    const win = readPanel("GeneralSettings.js");
    expect(win).toMatch(/Launch at Login/);
    expect(win).toMatch(/When closing the window/);
  });

  it("导航是双栏而不是一条长滚动（左栏导航 + 右栏独立滚动）", () => {
    expect(src).toMatch(/<SettingsNav/);
    expect(src).toMatch(/flex-1 overflow-y-auto/);
    // Modal 默认的 p-6 + 自身滚动必须让位，否则双栏里会套一层滚动
    expect(src).toMatch(/bodyClassName="p-0"/);
  });

  it("分段表的每个 key 都有对应的内容分支（防止加了导航项却没有内容）", () => {
    // 只在 SECTIONS 数组这一段里取 key：整份源码里还有其它 key: "..." 字面量
    const table = src.slice(
      src.indexOf("const SECTIONS = ["),
      src.indexOf("];", src.indexOf("const SECTIONS = [")),
    );
    const keys = [...table.matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const key of keys) {
      expect(src, `分段 ${key} 没有 case 分支`).toMatch(
        new RegExp(`case "${key}":`),
      );
    }
  });

  it("左栏是平铺导航：无分组标题、无应用名/图标（用户反馈的三条）", () => {
    const nav = readPanel("SettingsNav.js");
    // ① 不展示 logo 与应用名
    expect(nav, "左栏不应再有 logo").not.toMatch(/logo\.png/);
    expect(nav, "SettingsNav 不应再接收应用名").not.toMatch(/appName/);
    // ② 不做「应用 / 网关」两级分类：入参是扁平 items，源码里没有分组渲染
    expect(nav).toMatch(/\{ items, active, onSelect/);
    expect(nav, "不应再有分组渲染").not.toMatch(/groups/);
    expect(src, "分段表不应再有 group 字段").not.toMatch(/group: "app"/);
    expect(src, "分段表不应再有分组表").not.toMatch(/NAV_GROUPS/);
  });

  it("「软件更新」是最后一项（用户要求）", () => {
    const table = src.slice(
      src.indexOf("const SECTIONS = ["),
      src.indexOf("];", src.indexOf("const SECTIONS = [")),
    );
    const keys = [...table.matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]);
    expect(keys[keys.length - 1]).toBe("updates");
    // 网关数据不再单列导航项，改为并入数据与日志页
    expect(keys).not.toContain("data");
  });

  it("存储与网关数据合并为一页（数据位置 + 读数 + 保留策略 + 配置导出导入）", () => {
    const storage = readPanel("DataLogsSettings.js");
    expect(storage, "数据与日志页应渲染两张网关数据卡片").toMatch(
      /import \{ ConfigFileCard, DataLocationCard \} from "\.\/GatewayDataCards"/,
    );
    expect(storage).toMatch(/<DataLocationCard \/>/);
    expect(storage).toMatch(/<ConfigFileCard \/>/);
    // 卡片组件自己不再带段头（否则一页里会出现两个标题）
    const data = readPanel("GatewayDataCards.js");
    expect(data).not.toMatch(/<SectionHeader/);
    expect(data).not.toMatch(/<SectionBody/);
  });

  it("数据位置排在第一位，且文案落在「数据」而非「网关配置」上（用户要求）", () => {
    const storage = readPanel("DataLogsSettings.js");
    const at = (needle) => storage.indexOf(needle);
    expect(at("<DataLocationCard />")).toBeGreaterThan(-1);
    expect(at("<DataLocationCard />")).toBeLessThan(at("<StatGrid>"));
    expect(at("<DataLocationCard />")).toBeLessThan(at("<ConfigFileCard />"));
    const data = readPanel("GatewayDataCards.js");
    expect(data, "标签应改名为 Data Location").toMatch(/label="Data Location"/);
    expect(data, "说明应改为保存「数据」").toMatch(
      /The SQLite file that holds your data/,
    );
    expect(data, "旧文案不应残留").not.toMatch(/Database Location/);
  });

  it("保留详情天数是左右结构：一行内天数与按钮不换行（用户要求）", () => {
    const storage = readPanel("DataLogsSettings.js");
    const start = storage.indexOf('label="Keep details for (days)"');
    // 切到这一行的 </Row> 为止：文件顶部的注释里也出现过 "Save & clean now"，
    // 用它当右边界会把区间切反（第一版就踩了这个坑）
    const block = storage.slice(start, storage.indexOf("</Row>", start));
    expect(block.length).toBeGreaterThan(0);
    // 用 Row（左标签右控件）而不是 Field（上下堆叠）
    expect(storage).toMatch(/<Row\s+label="Keep details for \(days\)"/);
    // 控件行不得带 flex-wrap：宽度不够时宁可挤压左侧说明
    // 只看 className 本身——注释里就写着「不用 flex-wrap」，对整段做正则会被注释误伤
    const controlClass = (block.match(/<div className="([^"]+)"/) || [])[1] || "";
    expect(controlClass).toContain("flex");
    expect(controlClass).toContain("items-center");
    expect(controlClass, "控件行不应允许换行").not.toContain("flex-wrap");
  });

  it("安全设置是与网关设置平级的独立分段（用户要求）", () => {
    const security = readPanel("SecuritySettings.js");
    // 复用同一页组件 + groups 过滤，避免搬三十来个 useState
    expect(security).toMatch(/groups=\{\["security"\]\}/);
    expect(security).toMatch(/showAppInfo=\{false\}/);
    // 网关设置那一段不再渲染安全/单点登录
    expect(readPanel("GatewaySettingsSection.js")).toMatch(
      /groups=\{\["routing", "retry", "redaction", "pricing"\]\}/,
    );
    // 分段表里两项相邻，且安全在网关之前
    const table = src.slice(
      src.indexOf("const SECTIONS = ["),
      src.indexOf("];", src.indexOf("const SECTIONS = [")),
    );
    const keys = [...table.matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]);
    expect(keys).toContain("security");
    expect(keys.indexOf("security")).toBe(keys.indexOf("gateway") - 1);
  });

  it("每个分段只含自己的卡片：漏包一张就会串到别的分段（真实事故）", () => {
    // 事故：脱敏策略卡当时没被 shows() 包住，于是它跟着「安全设置」一起渲染了
    //（用户实测截图）。这里按分段区间断言，未门控的卡会落进上一个分段的区间而被抓到。
    const page = readFileSync(
      join(REPO, "src", "app", "(dashboard)", "dashboard", "profile", "page.js"),
      "utf8",
    );
    const at = (k) => {
      const i = page.indexOf(`{shows("${k}") ? (`);
      expect(i, `分段 ${k} 没有 shows() 包裹`).toBeGreaterThan(-1);
      return i;
    };
    // 判据用「卡片内的独有内容」而不是段头注释：注释写在 shows() 之前，
    // 按注释切区间会把下一段的注释算进本段（上一版就误报在这）。
    const OWN = {
      security: ["{/* Security */}", "Single Sign-On (SSO)"],
      routing: ["Routing Strategy", "updateFallbackStrategy"],
      retry: ["<RetryStrategyCard"],
      redaction: ["Redaction Policy"],
      pricing: ["Token rates behind the estimated cost"],
    };
    const keys = Object.keys(OWN);
    keys.forEach((k, i) => {
      const start = at(k);
      // 右边界取「下一段的 shows() 起点」与「下一段锚点注释」中更靠前的那个：
      // 注释写在 shows() 之前，只取前者会把下一段的注释算进本段（误报）
      // 右边界取「下一段的 shows() 起点」与「下一段内容的首次出现」中更靠前者：
      // 段头注释写在 shows() 之前，只取起点会把下一段的注释算进本段
      let end;
      if (i + 1 < keys.length) {
        const nextOpener = at(keys[i + 1]);
        const nextAnchor = page.indexOf(OWN[keys[i + 1]][0], start);
        end = nextAnchor === -1 ? nextOpener : Math.min(nextOpener, nextAnchor);
      } else {
        end = page.indexOf("{/* App Info", start);
      }
      expect(end, `${k} 右边界没找到`).toBeGreaterThan(start);
      const block = page.slice(start, end);
      expect(block.length, `${k} 区间为空`).toBeGreaterThan(0);
      for (const own of OWN[k]) {
        expect(block, `${k} 段缺少自己的卡片：${own}`).toContain(own);
      }
      for (const other of keys.filter((x) => x !== k)) {
        for (const alien of OWN[other]) {
          expect(
            block,
            `${k} 段里混进了 ${other} 的卡片（多半是那张卡没被 shows() 包住）：${alien}`,
          ).not.toContain(alien);
        }
      }
    });
  });

  it("shellOnly 分段在壳层设置就绪前必须有占位（否则崩在 shell.xxx 上）", () => {
    // 真实事故：外部指定分段（端点页横幅）或 shell 加载中切到「窗口」/「软件更新」，
    // renderSection 会把 shell=null 传下去 → 白屏 TypeError。导航 items 有 shellReady
    // 过滤，内容分支当时没有，两处判据必须一致。
    // 该 describe 里已经把模态框源码读作 `src`
    expect(src).toMatch(
      /if \(!shellReady && SECTIONS\.some\(\(s\) => s\.key === active && s\.shellOnly\)\)/,
    );
    expect(src, "占位文案也要入典").toMatch(/Loading shell settings\.\.\./);
    // 窗口/更新两段都读 shell，必须由上面那条统一挡住
    for (const key of ['case "window"', 'case "updates"']) {
      expect(src).toContain(key);
    }
  });

  it("状态条图标尺寸走工具类，且图标字体基础样式在 base 层", () => {
    const parts = readPanel("parts.js");
    expect(parts, "图标尺寸用工具类即可").toMatch(/material-symbols-outlined text-\[15px\]/);
    expect(parts, "不得再用行内 style 绕开层叠").not.toMatch(/style=\{\{ fontSize:/);
    expect(parts, "图标外层需与正文首行同高").toMatch(/flex h-\[18px\] shrink-0 items-center/);
    // 根因守卫：图标字体的基础样式（含默认 font-size:24px）必须待在 base 层里，
    // 否则未分层的规则会压掉全仓的 text-[Npx]（真实事故：三处图标一律渲染成 24px）
    const css = readFileSync(join(REPO, "src", "app", "globals.css"), "utf8");
    // 字体自持：@import 包里那份 CSS 会让生产构建丢掉相对 url 的字体文件
    // （产物里没有字体，图标退化成 ligature 原文），而且它是未分层的。
    expect(css).toMatch(/src: url\('\/fonts\/material-symbols-outlined\.woff2'\)/);
    expect(css, "不得 @import 该包（未分层 + 生产构建丢字体）").not.toMatch(
      /@import "material-symbols\/outlined\.css"/,
    );
    expect(
      existsSync(join(REPO, "public", "fonts", "material-symbols-outlined.woff2")),
      "字体文件必须随仓库分发",
    ).toBe(true);
    expect(readFileSync(join(REPO, "src", "app", "layout.js"), "utf8")).not.toMatch(
      /material-symbols\/outlined\.css/,
    );
  });

  it("网关设置是原生嵌入 profile 页，而不是跳转过去（用户要求）", () => {
    const section = readPanel("GatewaySettingsSection.js");
    // 原生嵌入：动态 import 那一页本身，不开 iframe
    expect(section).toMatch(/dynamic\(/);
    expect(section).toMatch(
      /import\("@\/app\/\(dashboard\)\/dashboard\/profile\/page"\)/,
    );
    expect(section, "不得用 iframe 嵌入").not.toMatch(/<iframe/);
    // 懒加载：面板挂在 root layout，静态 import 会把这页打进每个路由的首屏
    expect(section).toMatch(/ssr: false/);
    // 模态框本体不再需要路由跳转
    expect(src, "模态框不应再有 router.push").not.toMatch(/router\.push/);
    expect(src).not.toMatch(/from "next\/navigation"/);
  });

  it("页尾 App Info 并入面板页脚（嵌进去的那一页不再重复渲染它）", () => {
    // 嵌入时关掉原页的页尾块
    expect(readPanel("GatewaySettingsSection.js")).toMatch(
      /showAppInfo=\{false\}/,
    );
    const page = readFileSync(
      join(REPO, "src", "app", "(dashboard)", "dashboard", "profile", "page.js"),
      "utf8",
    );
    expect(page, "profile 页要支持隐藏页尾块").toMatch(
      /showAppInfo = true/,
    );
    expect(page).toMatch(/\{showAppInfo \? \(/);
    // 面板页脚承担这份信息：应用名 + 版本 + 本地/远程模式
    expect(src).toMatch(/APP_CONFIG\.name/);
    expect(src).toMatch(/APP_CONFIG\.version/);
    expect(src).toMatch(/isRemoteHost/);
  });

  it("仪表盘侧栏不再有「网关设置」入口（只从设置面板进）", () => {
    const sidebar = readFileSync(
      join(REPO, "src", "shared", "components", "Sidebar.js"),
      "utf8",
    );
    expect(sidebar, "侧栏不应再链接到 profile 页").not.toMatch(
      /dashboard\/profile/,
    );
    expect(sidebar, "侧栏不应再有 Gateway Settings 入口").not.toMatch(
      /Gateway Settings/,
    );
    // 入口仍在面板里（分段表最后一项 + 内容分支）
    expect(src).toMatch(/label: "Gateway Settings"/);
    expect(src).toMatch(/case "gateway":/);
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
    // 窗口开到下一处 JSX 属性级缩进为止：footer 里还有版本与更新状态一行，
    // 固定字长会在那段变长后把 Close 按钮截出窗口（假红）。
    const footer = src.slice(footerIdx, src.indexOf("\n      }\n", footerIdx));
    expect(footer).toMatch(/onClick=\{onClose\}/);
    expect(footer).toMatch(/>\s*\n\s*Close\s*\n\s*</);
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

// 配置导出/导入（ADR 0006）：从面板的 profile 页迁入模态框，因此是桌面专属。
// 2026-09-29 面板分栏后这一段独立成文件；存储与网关数据合并后改名为
// GatewayDataCards.js（只输出卡片），契约逐条跟着搬。
describe("壳层设置面板：配置导出/导入", () => {
  const src = readPanel("GatewayDataCards.js");
  const modal = readFileSync(MODAL, "utf8");

  it("有网关数据卡片与两个入口", () => {
    // 合并进存储页后不再有独立的段标题，卡片本身（数据位置 / 配置文件）就是标识
    expect(src).toMatch(/Data Location/);
    expect(src).toMatch(/Configuration file/);
    expect(src).toMatch(/Export Configuration/);
    expect(src).toMatch(/Import Configuration/);
  });

  it("密码就地输入，不再嵌套第二个 Modal", () => {
    // 嵌套会让 Escape 一次关掉两个（两者的监听都挂在 document 上），
    // 且内层卸载会把外层的 body 滚动锁一并清掉。
    // 整个面板（模态框 + 全部设置段）里只能有一个 Modal。
    const all = SETTINGS_FILES.map((rel) => readFileSync(join(REPO, rel), "utf8"));
    const modalCount = all.reduce(
      (n, text) => n + (text.match(/<Modal\b/g) || []).length,
      0,
    );
    expect(modalCount, "不应出现第二个 Modal").toBe(1);
    expect(modal).toMatch(/<Modal\b/);
    expect(src).toMatch(/type="password"/);
  });

  it("未登录时禁用：该接口在 ALWAYS_PROTECTED，无 JWT 一律 401（本机也不免）", () => {
    expect(src).toMatch(/\/api\/auth\/status/);
    expect(src).toMatch(/authenticated === true/);
    expect(src).toMatch(/disabled=\{!authed/);
  });

  it("数据库路径由网关回报，不硬编码", () => {
    expect(src).toMatch(/\/api\/settings\/database\/info/);
    // 渲染的必须是 API 回报的值，而不是写死的路径字面量
    expect(src).toMatch(/shortenHome\(dbPath\)/);
    expect(src).not.toMatch(/db\/data\.sqlite/);
  });
});

describe("配置导出/导入：迁出后不留残骸", () => {
  const profile = readFileSync(
    join(REPO, "src", "app", "(dashboard)", "dashboard", "profile", "page.js"),
    "utf8",
  );

  it("profile 页不再有备份入口、状态与密码模态框", () => {
    expect(profile).not.toMatch(/Download Backup|Import Backup/);
    expect(profile).not.toMatch(/setDbAuth|pendingImportRef|importFileRef/);
    // 那个密码模态框必须一并删掉，否则 Modal 的导入成为孤儿
    expect(profile).not.toMatch(/<Modal\b/);
    expect(profile).not.toMatch(/from "@\/shared\/components\/Modal"/);
  });

  it("导入后失效三处缓存（否则新组合/脱敏规则要重启网关才生效）", () => {
    const route = readFileSync(
      join(REPO, "src", "app", "api", "settings", "database", "route.js"),
      "utf8",
    );
    expect(route).toMatch(/applyOutboundProxyEnv\(settings\)/);
    expect(route).toMatch(/invalidateKnownSecrets\(\)/);
    expect(route).toMatch(/resetComboRotation\(\)/);
  });
});
