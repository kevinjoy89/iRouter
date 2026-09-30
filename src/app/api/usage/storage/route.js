import { NextResponse } from "next/server";
import {
  getRequestDetailsStorage,
  startRequestDetailsMaintenance,
} from "@/lib/db/repos/requestDetailsRepo.js";

export const dynamic = "force-dynamic";

// 本地库体积治理。请求详情明细曾因「无保留策略 + 单字段上限被放大」把 data.sqlite
// 撑到 10GB（见 docs/packaged-runtime-footprint.zh-CN.md）。
//
// 只暴露一个写动作 apply：按保留天数滚动清理，并自动把腾出的空间还给操作系统。
// 刻意**不提供「清空全部」**——一键抹掉全部诊断信息没有合理的日常用途，
// 需要腾空间时把保留天数调小再 apply 即可。删除与空间回收由服务端合并完成，
// 用户不需要理解 VACUUM。两者都不触碰 usageHistory / usageDaily，用量统计不受影响。

/**
 * GET /api/usage/storage
 *
 * @return {Promise<NextResponse>} 存储用量与保留策略快照
 * @author wei
 * @since 2026-09-29
 */
export async function GET() {
  try {
    const storage = await getRequestDetailsStorage();
    return NextResponse.json(storage);
  } catch (error) {
    console.error("[API] Failed to read request details storage:", error);
    return NextResponse.json({ error: "Failed to read storage stats" }, { status: 500 });
  }
}

/**
 * POST /api/usage/storage
 *
 * body: { action: "apply", days?: number }
 * - apply：**启动后台清理**（按保留天数删除超期详情 + 释放磁盘空间）并立即返回。
 *   清理分批执行、批间让出事件循环，因此网关全程可服务；进度用 GET 轮询
 *   `maintenance` 字段。此前是同步执行，清理期间整个网关停摆。
 *
 * @param {Request} request 请求对象
 * @return {Promise<NextResponse>} { ok, action, maintenance, storage }
 * @author wei
 * @since 2026-09-29
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action !== "apply") {
      return NextResponse.json({ error: 'action must be "apply"' }, { status: 400 });
    }

    const days = Number.isFinite(Number(body.days)) ? Number(body.days) : undefined;
    const started = startRequestDetailsMaintenance(days === undefined ? {} : { days });
    const storage = await getRequestDetailsStorage();
    return NextResponse.json({ ok: true, action: "apply", ...started, storage });
  } catch (error) {
    console.error("[API] Failed to start storage maintenance:", error);
    return NextResponse.json({ error: error.message || "Storage action failed" }, { status: 500 });
  }
}
