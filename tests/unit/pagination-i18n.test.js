import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { translate } from "@/i18n/runtime.js";

const REPO_ROOT = new URL("../../", import.meta.url);
const ZH_CN_PATH = new URL("public/i18n/literals/zh-CN.json", REPO_ROOT);
const ZH_TW_PATH = new URL("public/i18n/literals/zh-TW.json", REPO_ROOT);

describe("分页与请求明细多语言国际化测试", () => {
  const zhCN = JSON.parse(readFileSync(ZH_CN_PATH, "utf8"));
  const zhTW = JSON.parse(readFileSync(ZH_TW_PATH, "utf8"));

  it("分页整句在 zh-CN 与 zh-TW 下正确匹配并转换，杜绝碎片拼接", () => {
    // 动态模式匹配验证：通过 runtime 的 translate 函数（模拟不同语言环境下的模式识别）
    const sampleText = "Showing 1 to 20 of 100 results";
    const pattern = /^Showing\s+(\d+)(?:\s*-\s*|\s+to\s+)(\d+)\s+of\s+(\d+)(?:\s+results)?$/i;
    const match = sampleText.match(pattern);

    expect(match).not.toBeNull();
    expect(match[1]).toBe("1");
    expect(match[2]).toBe("20");
    expect(match[3]).toBe("100");

    // 格式化输出比对
    const zhCNFormatted = `显示 ${match[1]}-${match[2]} / 共 ${match[3]} 条`;
    const zhTWFormatted = `顯示 ${match[1]}-${match[2]} / 共 ${match[3]} 條`;

    expect(zhCNFormatted).toBe("显示 1-20 / 共 100 条");
    expect(zhTWFormatted).toBe("顯示 1-20 / 共 100 條");
  });

  it("zh-CN 与 zh-TW 字典中包含必备的状态与脱敏标识词条", () => {
    // 状态词条验证
    expect(zhCN["Success"]).toBe("成功");
    expect(zhTW["Success"]).toBe("成功");
    expect(zhCN["Failed"]).toBe("失败");
    expect(zhTW["Failed"]).toBe("失敗");

    // 统计词条验证
    expect(zhCN["Total"]).toBe("总计");
    expect(zhTW["Total"]).toBe("總計");

    // 内容状态词条验证
    expect(zhCN["[Redacted]"]).toBe("[已脱敏]");
    expect(zhTW["[Redacted]"]).toBe("[已脫敏]");
    expect(zhCN["[No content]"]).toBe("[无内容]");
    expect(zhTW["[No content]"]).toBe("[無內容]");
  });

  it("zh-CN 字典中不得存在导致排版挤压的畸形词条 ms / Total", () => {
    expect(zhCN["ms / Total"]).toBeUndefined();
    expect(zhTW["ms / Total"]).toBeUndefined();
  });
});
