// 定价入口的演进：曾经挂在「用量 → Est. Cost → 编辑定价」，后统一收进设置面板。
// 现已调整为对齐 models.dev 权威实时定价源，彻底移除手工编辑弹窗 PricingModal。
// 网关设置面板中的 Pricing 卡片负责展示 models.dev 对齐状态，并提供「立即同步」按钮。
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("pricing entry point (settings panel → gateway → Pricing, aligned with models.dev)", () => {
  const profile = read("src/app/(dashboard)/dashboard/profile/page.js");

  it("Pricing 卡片对齐 models.dev 并提供 Sync Now 按钮，不再引用 PricingModal", () => {
    expect(profile).not.toMatch(/import PricingModal/);
    expect(profile).not.toMatch(/<PricingModal/);
    expect(profile).not.toMatch(/Edit Pricing/);
    expect(profile).toMatch(/models\.dev/);
    expect(profile).toMatch(/Sync Now/);
    expect(
      fs.existsSync(path.join(ROOT, "src/shared/components/PricingModal.js")),
    ).toBe(false);
  });

  it("该卡片属于「网关设置」分段（面板里必须能到达）", () => {
    const gateway = read(
      "src/shared/components/settings/GatewaySettingsSection.js",
    );
    expect(gateway).toMatch(/groups=\{\["routing", "retry", "redaction", "pricing"\]\}/);
  });

  it("用量页不再重复提供定价入口（单一入口，由 models.dev 统一标准维护）", () => {
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

  it("Sync Now 与 models.dev 定价对齐有多语言条目", () => {
    const zh = JSON.parse(read("public/i18n/literals/zh-CN.json"));
    expect(zh["Sync Now"]).toBeTruthy();
    expect(zh["Token rates aligned with models.dev for usage cost estimates."]).toBeTruthy();
  });
});
