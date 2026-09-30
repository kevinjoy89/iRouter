// 定价编辑入口的落点变迁：曾经挂在「用量 → Est. Cost → 编辑定价」（+ 一个脱离面板
// 布局、无入口的 /dashboard/settings/pricing 孤立页）。6e7b5e50 把入口统一收进设置：
// 用量组件不再内嵌定价弹窗，孤立页删除，改由「设置面板 → 网关设置 → Pricing」卡片
// 复用同一个 PricingModal。本文件守的是**新**契约——别再照旧结构写断言。
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("pricing editor entry point (settings panel → gateway → Pricing)", () => {
  const profile = read("src/app/(dashboard)/dashboard/profile/page.js");

  it("Pricing 卡片提供 Edit Pricing 按钮，点击打开 PricingModal", () => {
    expect(profile).toMatch(
      /import PricingModal from "@\/shared\/components\/PricingModal"/,
    );
    expect(profile).toMatch(/Edit Pricing/);
    expect(profile).toMatch(/onClick=\{\(\) => setPricingOpen\(true\)\}/);
    expect(profile).toMatch(/<PricingModal isOpen=\{pricingOpen\}/);
  });

  it("该卡片属于「网关设置」分段（面板里必须能到达）", () => {
    const gateway = read(
      "src/shared/components/settings/GatewaySettingsSection.js",
    );
    expect(gateway).toMatch(/groups=\{\["routing", "retry", "redaction", "pricing"\]\}/);
  });

  it("用量页不再重复提供定价入口（单一入口，避免两处编辑同一份费率）", () => {
    const usage = read("src/shared/components/UsageStats.js");
    expect(usage).not.toMatch(/PricingModal/);
    expect(usage).not.toMatch(/onEditPricing/);
    const cards = read(
      "src/app/(dashboard)/dashboard/usage/components/OverviewCards.js",
    );
    expect(cards).not.toMatch(/onEditPricing/);
  });

  it("孤立的定价页已删除（它没有侧栏、也没有任何入口）", () => {
    expect(
      fs.existsSync(path.join(ROOT, "src/app/dashboard/settings/pricing")),
    ).toBe(false);
  });

  it("Edit Pricing 仍有多语言条目", () => {
    const zh = JSON.parse(read("public/i18n/literals/zh-CN.json"));
    expect(zh["Edit Pricing"]).toBeTruthy();
    expect(zh["Pricing Configuration"]).toBeTruthy();
  });
});
