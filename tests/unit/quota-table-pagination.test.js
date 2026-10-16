import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_QUOTA_TABLE_PAGE_SIZE as DEFAULT_PAGE_SIZE,
  calculateQuotaPagination,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { translateDynamicPatterns } from "@/i18n/runtime.js";

const REPO_ROOT = new URL("../../", import.meta.url);
const QUOTA_TABLE_PATH = new URL("src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js", REPO_ROOT);

describe("配额表格每页展示条数与单行翻页工具栏重构测试", () => {
  it("默认每页展示条数配置为 3 条", () => {
    // 验证默认每页展示条数常量与计算结果
    expect(DEFAULT_PAGE_SIZE).toBe(3);
    const pagination = calculateQuotaPagination(12);
    expect(pagination.effectivePageSize).toBe(3);
  });

  it("12个配额数据下正确划分为4页并计算起止范围与边界防御", () => {
    const totalCount = 12;

    // 第 1 页：展示 1-3
    const page1 = calculateQuotaPagination(totalCount, 3, 1);
    expect(page1.totalPages).toBe(4);
    expect(page1.pageStart).toBe(1);
    expect(page1.pageEnd).toBe(3);

    // 第 2 页：展示 4-6
    const page2 = calculateQuotaPagination(totalCount, 3, 2);
    expect(page2.pageStart).toBe(4);
    expect(page2.pageEnd).toBe(6);

    // 第 3 页：展示 7-9
    const page3 = calculateQuotaPagination(totalCount, 3, 3);
    expect(page3.pageStart).toBe(7);
    expect(page3.pageEnd).toBe(9);

    // 第 4 页：展示 10-12
    const page4 = calculateQuotaPagination(totalCount, 3, 4);
    expect(page4.pageStart).toBe(10);
    expect(page4.pageEnd).toBe(12);

    // 边界与防御：页码超限时安全收敛
    const overflowPage = calculateQuotaPagination(totalCount, 3, 99);
    expect(overflowPage.pageStart).toBe(10);
    expect(overflowPage.pageEnd).toBe(12);

    // 0 个配额边界
    const zeroPage = calculateQuotaPagination(0, 3, 1);
    expect(zeroPage.totalPages).toBe(1);
    expect(zeroPage.pageStart).toBe(0);
    expect(zeroPage.pageEnd).toBe(0);
  });

  it("翻页文本能够通过多语言运行时准确转换且格式规范", () => {
    // 分页摘要在简体中文与繁体中文环境下的翻译
    const zhCnShowing = translateDynamicPatterns("Showing 1-3 of 12", "zh-CN");
    const zhTwShowing = translateDynamicPatterns("Showing 1-3 of 12", "zh-TW");
    expect(zhCnShowing).toBe("显示 1-3 / 共 12 条");
    expect(zhTwShowing).toBe("顯示 1-3 / 共 12 條");

    // 页码提示在简体中文与繁体中文环境下的翻译
    const zhCnPage = translateDynamicPatterns("Page 1 / 4", "zh-CN");
    const zhTwPage = translateDynamicPatterns("Page 1 / 4", "zh-TW");
    expect(zhCnPage).toBe("第 1 / 4 页");
    expect(zhTwPage).toBe("第 1 / 4 頁");
  });

  it("QuotaTable 组件结构重构为单行工具栏并使用翻页图标代替文字按钮", () => {
    const sourceCode = readFileSync(QUOTA_TABLE_PATH, "utf8");

    // 确认已采用单行 flex-between 布局容器
    expect(sourceCode).toContain("flex items-center justify-between gap-2 rounded-md border border-black/10");

    // 确认已使用 Material Symbols 翻页图标
    expect(sourceCode).toContain("chevron_left");
    expect(sourceCode).toContain("chevron_right");

    // 确认不再包含原先独立换行容器 mt-1.5 flex items-center justify-end
    expect(sourceCode).not.toContain("mt-1.5 flex items-center justify-end");
  });
});
