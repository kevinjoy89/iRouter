import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { invalidateKnownSecrets } from "@/lib/dlp/index.js";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const PASSWORD_HEADER = "x-9r-password";

// CLI token requests are already trusted (local machine); skip password re-auth.
function isCliRequest(request) {
  return Boolean(request.headers.get(CLI_TOKEN_HEADER));
}

export async function GET(request) {
  try {
    if (!isCliRequest(request) && !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const payload = await exportDb();
    return NextResponse.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { password, ...payload } = await request.json();
    if (!isCliRequest(request) && !(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    await importDb(payload);

    // 导入替换的是整个配置层，所以三处缓存都要失效——不同于 PATCH /api/settings
    // 的按字段条件失效，这里无条件。缺了 comboRotation 与 dlp 已知密钥的失效，
    // 导入的新组合模型与脱敏规则要重启网关才生效（见 ADR 0006）。
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
      invalidateKnownSecrets();
      resetComboRotation();
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply imported settings:", err);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}
