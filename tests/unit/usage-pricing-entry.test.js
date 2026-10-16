// 定价与模型同步入口的演进：
// 1. 早期挂在「用量 → Est. Cost → 编辑定价」
// 2. 统一收进设置面板（曾混在网关设置）
// 3. 现已正式解耦提升为顶级「外部集成（Integrations）」分段（对齐 models.dev 权威实时定价，彻底移除手工编辑弹窗）
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("pricing & models entry point (settings panel → integrations → models.dev)", () => {
  it("ShellSettingsModal 提供独立的 Integrations 分段，位于 gateway 之后、updates 之前", () => {
    const shell = read("src/shared/components/ShellSettingsModal.js");
    expect(shell).toMatch(/import IntegrationsSettings from "@\/shared\/components\/settings\/IntegrationsSettings"/);
    expect(shell).toMatch(/key:\s*"integrations",\s*icon:\s*"extension",\s*label:\s*"Integrations"/);
    expect(shell).toMatch(/case "integrations":[\s\S]*?<IntegrationsSettings \/>/);
  });

  it("IntegrationsSettings 呈现 models.dev 官方生态卡片与 Sync Now 按钮", () => {
    const integrations = read("src/shared/components/settings/IntegrationsSettings.js");
    expect(integrations).toMatch(/models\.dev/);
    expect(integrations).toMatch(/Sync Now/);
    expect(integrations).toMatch(/Auto-syncs every 24 hours/);
    expect(
      fs.existsSync(path.join(ROOT, "src/shared/components/PricingModal.js")),
    ).toBe(false);
  });

  it("网关设置分段已彻底剥离 pricing，聚焦核心路由/重试/脱敏策略", () => {
    const gateway = read(
      "src/shared/components/settings/GatewaySettingsSection.js",
    );
    expect(gateway).toMatch(/groups=\{\["routing", "retry", "redaction"\]\}/);
    expect(gateway).not.toMatch(/"pricing"/);
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

  it("Integrations 与 Sync Now 等相关文案有多语言条目", () => {
    const zh = JSON.parse(read("public/i18n/literals/zh-CN.json"));
    expect(zh["Integrations"]).toBe("外部集成");
    expect(zh["Sync Now"]).toBeTruthy();
  });
});
