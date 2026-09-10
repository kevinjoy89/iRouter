import { describe, it, expect } from "vitest";
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
