import { NextResponse } from "next/server";
import { DATA_FILE } from "@/lib/db/paths.js";

// 数据库文件位置。路径由网关回报而非界面硬编码：桌面版默认 ~/.irouter，
// 但上游默认是 ~/.9router，DATA_DIR 还可覆盖。前缀 /api/settings/database 已在
// dashboardGuard 的 ALWAYS_PROTECTED 里，本路由自动要求有效会话。
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { path: DATA_FILE },
    { headers: { "Cache-Control": "no-store" } },
  );
}
