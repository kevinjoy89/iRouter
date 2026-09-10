// Usage → Overview: the Est. Cost card carries the only in-app entry point to
// the pricing editor. The standalone page at src/app/dashboard/settings/pricing
// is outside the (dashboard) route group (no sidebar) and is linked from nowhere,
// so this button is what actually exposes the feature. Guard the wiring.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("usage overview → pricing editor entry point", () => {
  const cards = read("src/app/(dashboard)/dashboard/usage/components/OverviewCards.js");
  const usage = read("src/shared/components/UsageStats.js");

  it("Est. Cost card exposes an Edit Pricing button", () => {
    expect(cards).toMatch(/onEditPricing/);
    expect(cards).toMatch(/Edit Pricing/);
    // Optional prop: the card still renders when no handler is passed.
    expect(cards).toMatch(/\{onEditPricing && \(/);
    expect(cards).toMatch(/onClick=\{onEditPricing\}/);
  });

  it("UsageStats opens the pricing modal from that button", () => {
    expect(usage).toMatch(/import PricingModal from "\.\/PricingModal"/);
    expect(usage).toMatch(/<PricingModal/);
    expect(usage).toMatch(/onEditPricing=\{\(\) => setShowPricing\(true\)\}/);
  });

  it("saving pricing recomputes the displayed cost", () => {
    // Costs derive from the rates, so the stats fetch must re-run after a save.
    expect(usage).toMatch(/setStatsReloadKey\(\(k\) => k \+ 1\)/);
    expect(usage).toMatch(/\}, \[period, statsReloadKey\]\)/);
  });

  it("the hidden pricing page is not the only surface (it has no sidebar)", () => {
    const hiddenPage = read("src/app/dashboard/settings/pricing/page.js");
    expect(hiddenPage).toMatch(/Pricing Settings/);
    // Not under the (dashboard) route group → inherits no DashboardLayout.
    const inGroup = fs.existsSync(
      path.join(ROOT, "src/app/(dashboard)/dashboard/settings/pricing/page.js")
    );
    expect(inGroup).toBe(false);
  });

  it("Edit Pricing has a translation entry", () => {
    const zh = JSON.parse(read("public/i18n/literals/zh-CN.json"));
    expect(zh["Edit Pricing"]).toBeTruthy();
    expect(zh["Pricing Configuration"]).toBeTruthy();
  });
});
