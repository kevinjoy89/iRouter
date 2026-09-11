import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { processTextNode } from "../../src/i18n/runtime.js";

// 回归：React 原地改写文本节点（characterData 不被 MutationObserver 观察）后，
// 路由/语言切换触发的全量重扫曾用挂载时缓存的 _originalText 把动态文本写回旧值
// ——控制台日志页的行数统计与连接状态因此冻结在 0/0 与「连接中…」。
function textNode(value) {
  return {
    nodeValue: value,
    parentElement: { tagName: "span", hasAttribute: () => false, parentElement: null },
  };
}

describe("runtime i18n text node cache", () => {
  it("keeps a React-updated value on re-scan instead of reverting to the first-seen text", () => {
    const node = textNode("    0");
    processTextNode(node);
    expect(node.nodeValue).toBe("    0");

    node.nodeValue = "   12"; // React 重新渲染
    processTextNode(node); // 路由变化触发的重扫
    expect(node.nodeValue).toBe("   12");
  });
});

// 回归：新增面板文案容易漏进字典（英文即源文，漏了就永远显示英文）。
// Redaction Policy 卡片（ADR 0005 的请求脱敏）首版即漏了全部 11 条。
// 这里钉住「新 UI 文案必须入 zh-CN / zh-TW 字典」这一约定。
describe("面板新增文案的字典覆盖", () => {
  // 路径相对测试文件解析（不是 cwd）：套件既可能从仓库根跑，也可能带 --root tests 跑，
  // 相对 cwd 的写法会在后者下 ENOENT（tests/unit/security-audit.test.js 即踩过此坑）。
  const REPO_ROOT = new URL("../../", import.meta.url);
  const PROFILE = new URL("src/app/(dashboard)/dashboard/profile/page.js", REPO_ROOT);
  const ZH_CN = new URL("public/i18n/literals/zh-CN.json", REPO_ROOT);
  const ZH_TW = new URL("public/i18n/literals/zh-TW.json", REPO_ROOT);

  // 按 JSX 空白规则还原文本节点：行首尾去空白、行间单空格、空行丢弃
  function jsxText(raw) {
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  }

  function redactionBlock() {
    const src = readFileSync(PROFILE, "utf8");
    return src.slice(src.indexOf("{/* Redaction Policy"), src.indexOf("{/* Pricing rates"));
  }

  // 卡片排序是刻意的产品决策（脱敏紧随重试）。源码扫描钉住它，否则后续重构
  // 悄悄挪回去没有任何信号——这三个注释锚点在 profile 页里各出现一次。
  it("脱敏策略卡片紧随重试策略、且在 Network 之前", () => {
    const src = readFileSync(PROFILE, "utf8");
    const idx = (anchor) => {
      const at = src.indexOf(anchor);
      expect(at, `锚点缺失: ${anchor}`).toBeGreaterThan(-1);
      expect(src.indexOf(anchor, at + 1), `锚点不唯一: ${anchor}`).toBe(-1);
      return at;
    };
    expect(idx("{/* Retry Strategy")).toBeLessThan(idx("{/* Redaction Policy"));
    expect(idx("{/* Redaction Policy")).toBeLessThan(idx("{/* Network */}"));
  });

  it("Redaction Policy 卡片的所有可翻译文案都在 zh-CN / zh-TW 字典中", () => {
    const block = redactionBlock();
    expect(block.length).toBeGreaterThan(200); // 卡片存在（防止锚点失效后静默通过）

    const zh = JSON.parse(readFileSync(ZH_CN, "utf8"));
    const tw = JSON.parse(readFileSync(ZH_TW, "utf8"));

    const candidates = [];
    // 文本节点（排除含子元素/表达式的段落）
    for (const m of block.matchAll(/>([^<>{}]+)</g)) {
      const t = jsxText(m[1]);
      if (t && /^[A-Z]/.test(t)) candidates.push(t);
    }
    // label="..." 属性（渲染成 <label> 文本，可翻译）
    for (const m of block.matchAll(/label="([^"]+)"/g)) candidates.push(m[1]);
    // label: "..."（Select 的 option；其直接父元素是 <option>，不在 skipTags 内 → 会被翻译）
    for (const m of block.matchAll(/label:\s*"([^"]+)"/g)) candidates.push(m[1]);
    // hint 三目里的字符串字面量
    for (const m of block.matchAll(/"([A-Z][^"]{20,}\.)"/g)) candidates.push(m[1]);

    expect(candidates.length).toBeGreaterThanOrEqual(10);

    const missing = candidates.filter((t) => !zh[t] || !tw[t]);
    expect(missing, `未入字典: ${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });

  it("描述句不内联 <code>/<strong>（会被切成多个文本节点而漏翻）", () => {
    const block = redactionBlock();
    // 逐条描述句（<p> 内的文案）不得内联标记元素；标记字面量只出现在独立的 <code> 块里。
    const prose = [...block.matchAll(/<p className="text-xs sm:text-sm text-text-muted">([\s\S]*?)<\/p>/g)]
      .map((m) => m[1]);
    expect(prose.length).toBeGreaterThanOrEqual(3);
    for (const p of prose) {
      expect(p).not.toContain("<strong>");
      expect(p).not.toContain("<code>");
    }
  });

  it("豁免标记字面量必须展示给用户（曾有版本只留开关、无从得知写什么）", () => {
    const block = redactionBlock();
    // 用码点构造，避免断言字符串本身被中间层改写
    const OPEN = String.fromCharCode(91, 91) + "ALLOW_SENSITIVE" + String.fromCharCode(93, 93);
    const CLOSE = String.fromCharCode(91, 91) + "/ALLOW_SENSITIVE" + String.fromCharCode(93, 93);
    expect(block).toContain(OPEN);
    expect(block).toContain(CLOSE);
    // 且必须渲染在 code 元素内（code 在 skipTags 内，不参与翻译）
    expect(block).toMatch(new RegExp(`<code[^>]*>\\s*${OPEN.replace(/[[\]]/g, "\\$&")}`));
  });

  // 用户反馈：只给两个字面量仍然看不懂——不知道豁免什么、怎么用。GUI 需给出可照抄的用法。
  it("豁免区必须给出「怎么用」：可复制按钮 + 包裹前后对比示例", () => {
    const block = redactionBlock();
    const START = block.indexOf("Allow exemption markers");
    expect(START).toBeGreaterThan(-1); // 锚点失效时报错，而不是拿着全文静默通过
    // 窗口取到卡片末尾，不写固定字数：豁免区之前多加一行（加个图标头、改段排版）
    // 就会把后面的断言挤出窗口——曾因格式化器重排整份文件而假红一次。
    const region = block.slice(START);

    // 一键复制（把标记连同样例一起复制，用户可直接粘进 prompt）
    expect(region).toContain("copy(");
    expect(region).toMatch(/Copied|Copy/);

    // 包裹后 vs 未包裹的对比：两种结果都要出现
    expect(region).toContain("[REDACTED:ai_tokens]"); // 未包裹 → 被改写
    expect(region).toContain("sent unchanged");       // 包裹 → 原样发送
  });
});

// 钉住一处易误判的运行时事实：skipTags 比对的是**直接父元素**，因此 <option> 的文本
// 节点会被翻译（只有 <select> 自身的直接文本会被跳过）。design.md 里「select 子树不翻译」
// 的说法不精确——据此把 option 文案写成无描述的中性词是没必要的。
describe("runtime i18n 的 skipTags 边界", () => {
  function makeNode(value, tagName) {
    return {
      nodeValue: value,
      parentElement: { tagName, hasAttribute: () => false, parentElement: null },
    };
  }

  it("option 的文本节点会被处理（可翻译）", () => {
    const option = makeNode("Off — forward everything unchanged", "option");
    processTextNode(option);
    expect(option._originalText).toBe("Off — forward everything unchanged");
  });

  it("select 的直接文本节点被跳过", () => {
    const select = makeNode("placeholder", "select");
    processTextNode(select);
    expect(select._originalText).toBeUndefined();
  });

  it("code 的文本节点被跳过（故豁免标记文案不内联 <code>）", () => {
    const code = makeNode("[[ALLOW_SENSITIVE]]", "code");
    processTextNode(code);
    expect(code._originalText).toBeUndefined();
  });
});
