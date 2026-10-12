// 设置入口的接线守卫。
//
// 这条守卫的来由是两轮真实返工：
//   1. 入口做在顶栏齿轮，代码对、包也发了，但被 Next 的持久化响应缓存挡住，用户看不到
//      （根因与修复见 `custom-server.js` 的 purgeStaleRouteCache 与 ADR 0009）；
//   2. 换到侧边栏底部后，若有人「重构」时把渲染点摘掉、或改成不再发那个 window 事件，
//      表现与第 1 种完全一样：**静默没有入口、零报错**。
// 逻辑写对但没接上等于没修，所以这里把「入口存在 + 发对事件」钉成可执行断言。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const SIDEBAR = read("src/shared/components/Sidebar.js");
const HEADER = read("src/shared/components/Header.js");
const HOST = read("src/shared/components/ShellSettingsHost.js");
const LAYOUT = read("src/app/layout.js");

describe("设置入口接线", () => {
  // 入口必须发这个事件——宿主只监听它（另一条来源是壳层 IPC）。
  //
  // ⚠️ 用**精确字符串字面量**而不是 `toMatch(/irouter:open-settings/)`：
  // 子串匹配会让 `"irouter:open-settings-typo"` 照样通过（变异测试实测过的假绿），
  // 而事件名打错一个字符就等于「发出去没人接」——正是这条守卫要拦的形态。
  it("侧边栏底部入口发 irouter:open-settings（精确事件名）", () => {
    const names = [...SIDEBAR.matchAll(/new Event\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toContain("irouter:open-settings");
    // 反向：不允许出现「以正确名为前缀的变体」（打错字最常见的形式）
    const typos = names.filter((n) => n !== "irouter:open-settings" && n.startsWith("irouter:open-settings"));
    expect(typos, `疑似拼错的事件名：${typos.join(", ")}`).toEqual([]);
  });

  // 宿主监听的常量必须与 Sidebar 发的一致，否则事件发出去没人接
  it("事件名与 ShellSettingsHost 监听的一致", () => {
    const hostEvent = HOST.match(/const OPEN_EVENT = "([^"]+)"/)?.[1];
    expect(hostEvent).toBe("irouter:open-settings");
    // 精确比对：Sidebar 里必须出现**带引号的完整字面量**
    expect(SIDEBAR).toContain(`"${hostEvent}"`);
  });

  // 宿主必须挂在 root layout（不是 dashboard layout）：设置模态框在登录页也要能被菜单唤起
  it("ShellSettingsHost 仍挂在 root layout", () => {
    expect(LAYOUT).toMatch(/ShellSettingsHost/);
  });

  // 入口要带**可见**文字标签，而不是只有图标。理由：这个入口存在的唯一理由是
  // 「用户找不到设置」，裸图标（尤其齿轮）恰恰是最容易被忽略的形态。
  //
  // ⚠️ 只断言「文本是 Settings」不够：`sr-only`（仅供读屏）同样满足，但视觉上仍是裸图标。
  // 变异测试实测过这个假绿，故这里同时断言**不带** sr-only / hidden 这类视觉隐藏类。
  it("入口带可见文字标签而非仅图标", () => {
    const start = SIDEBAR.indexOf("设置入口（系统区底部）");
    const btnStart = SIDEBAR.indexOf("<button", start);
    const btnEnd = SIDEBAR.indexOf("</button>", btnStart);
    const btn = SIDEBAR.slice(btnStart, btnEnd);
    expect(btn).toMatch(/material-symbols-outlined/);
    // 标签所在的 span 必须是可见的（不能带 sr-only / hidden）
    const labelSpan = btn.match(/<span[^>]*>\s*Settings\s*<\/span>/);
    expect(labelSpan, "找不到可见的文字标签 span").not.toBeNull();
    expect(labelSpan[0]).not.toMatch(/sr-only|hidden|invisible/);
  });

  // 单一入口：顶栏不再有齿轮。两个入口要各自维护，且用户已明确否定顶栏那个。
  it("顶栏不再渲染设置齿轮（单一入口）", () => {
    expect(HEADER).not.toMatch(/SettingsButton/);
    expect(HEADER).not.toMatch(/aria-label="Settings"/);
  });

  // 窄屏抽屉形态：点入口时要先收起抽屉，否则关掉模态框后用户面对一个仍开着的抽屉
  it("点入口时收起抽屉", () => {
    const block = SIDEBAR.slice(SIDEBAR.indexOf("设置入口（系统区底部）"));
    expect(block).toMatch(/onClose/);
  });

  // 不新增 IPC/权限面（ADR 0008 的「IPC 面最小化」）：入口只发 window 事件，
  // 不直接调 window.irouterShell，因此浏览器形态下同样可用。
  //
  // 注意取的是**按钮元素本体**而不是「注释 + 元素」：注释里恰好也提到了 irouterShell
  // （那是在解释「为什么不判它」），把注释算进来会让这条断言假红。
  it("入口不直接依赖壳层桥（浏览器形态同样可用）", () => {
    const start = SIDEBAR.indexOf("设置入口（系统区底部）");
    const btnStart = SIDEBAR.indexOf("<button", start);
    const btnEnd = SIDEBAR.indexOf("</button>", btnStart);
    expect(btnStart).toBeGreaterThan(-1);
    expect(btnEnd).toBeGreaterThan(btnStart);
    const btn = SIDEBAR.slice(btnStart, btnEnd);
    expect(btn).not.toMatch(/irouterShell/);
    expect(btn).toMatch(/irouter:open-settings/);
  });
});

// 文案必须在字典里：面板 runtime i18n 按文本节点精确匹配，缺条目会**静默显示英文**。
// （设置面板自身的覆盖守卫在 shell-settings-i18n.test.js，这里只管侧边栏这条新入口。）
describe("设置入口文案 i18n", () => {
  it("「Settings」在 zh-CN / zh-TW 字典里有译文", () => {
    for (const [loc, expected] of [["zh-CN", "设置"], ["zh-TW", "設定"]]) {
      const dict = JSON.parse(read(`public/i18n/literals/${loc}.json`));
      expect(dict["Settings"], `${loc} 缺 Settings 条目`).toBe(expected);
    }
  });
});
