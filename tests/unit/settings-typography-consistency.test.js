import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const REPO_ROOT = new URL("../../", import.meta.url);
const PROFILE_PAGE_PATH = new URL("src/app/(dashboard)/dashboard/profile/page.js", REPO_ROOT);

/**
 * 设置面板字号统一契约测试
 *
 * @author wei
 * @since 2026-10-16
 */
describe("设置面板字号统一契约测试", () => {
  const profileSource = readFileSync(PROFILE_PAGE_PATH, "utf8");

  it("卡片标题统一收敛为 14px 半粗体，彻底移除不一致的响应式大字号", () => {
    // 确认已收敛为 14px 统一卡片大标题
    expect(profileSource).toContain('h3 className="text-[14px] font-semibold text-text-main"');
    // 确认旧的 16~18px 响应式大字号已彻底清除
    expect(profileSource).not.toContain("text-base sm:text-lg font-semibold");
  });

  it("功能点标题与表单 Label 统一收敛为 13px 中粗体，彻底移除 sm:text-base 断点", () => {
    // 确认功能点与表单项均已采用 13px 样式
    expect(profileSource).toContain('text-[13px] leading-5 font-medium text-text-main');
    // 确认旧的 14~16px 响应式断点已彻底清除
    expect(profileSource).not.toContain("font-medium text-sm sm:text-base");
    expect(profileSource).not.toContain("text-xs sm:text-sm font-medium");
  });

  it("功能点描述与辅助提示统一收敛为 12px 常规体", () => {
    // 确认描述提示已收敛为 12px
    expect(profileSource).toContain('text-[12px] leading-[1.5] text-text-muted');
    // 确认旧的不一致描述类名已彻底清除
    expect(profileSource).not.toContain("text-xs sm:text-sm text-text-muted");
  });

  it("SSO 切换 Tab 与操作按钮尺寸规范化", () => {
    // 确认协议切换 Tab 已收敛为 12px
    expect(profileSource).toContain('font-medium text-[12px] transition-all text-center');
    // 确认各表单提交与测试按钮均已使用 size="sm"
    expect(profileSource).toContain('Button type="submit" variant="primary" size="sm"');
    expect(profileSource).toContain('Button type="button" variant="primary" size="sm"');
  });
});
