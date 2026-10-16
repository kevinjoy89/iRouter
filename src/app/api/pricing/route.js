import { NextResponse } from "next/server";
import {
  getPricing,
  getModelsDevPricingMeta,
  syncModelsDevPricing,
  checkAndAutoSyncPricing,
} from "@/lib/localDb.js";
import { getDefaultPricing } from "open-sse/providers/pricing.js";

/**
 * GET /api/pricing
 * 获取当前定价配置与 models.dev 同步状态（并在后台自适应检测过期自动同步）
 *
 * @returns {Promise<NextResponse>}
 */
export async function GET() {
  try {
    // 异步触发自适应静默同步检测
    checkAndAutoSyncPricing();
    const pricing = await getPricing();
    return NextResponse.json(pricing);
  } catch (error) {
    console.error("Error fetching pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch pricing" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/pricing
 * 手动触发与 models.dev 的实时定价同步
 *
 * @returns {Promise<NextResponse>}
 */
export async function POST() {
  try {
    const result = await syncModelsDevPricing(true);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error triggering pricing sync:", error);
    return NextResponse.json(
      { error: "Failed to sync pricing" },
      { status: 500 }
    );
  }
}

/**
 * GET_DEFAULTS
 * 获取内置默认定价配置（用于离线静态兜底）
 *
 * @returns {Promise<NextResponse>}
 */
export async function GET_DEFAULTS() {
  try {
    const defaultPricing = getDefaultPricing();
    return NextResponse.json(defaultPricing);
  } catch (error) {
    console.error("Error fetching default pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch default pricing" },
      { status: 500 }
    );
  }
}