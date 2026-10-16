import { NextResponse } from "next/server";
import {
  saveSpeedtestResult,
  getSpeedtestHistory,
  getSpeedtestStats,
  exportSpeedtestHistoryJsonl,
  clearSpeedtestHistory,
  getApiKeys,
} from "@/lib/db";
import { getProviderConnectionById } from "@/models";
import { PROVIDERS } from "open-sse/providers/index.js";
import {
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

/**
 * 测速历史与统计数据查询/导出接口
 *
 * @param {Request} request HTTP 请求对象
 * @return {Promise<Response>} 响应对象
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "history";

    // 获取指定连接的直连测速配置（URL、协议与密钥）
    if (action === "target-config") {
      const connectionId = searchParams.get("connectionId");
      if (!connectionId) {
        return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
      }
      const conn = await getProviderConnectionById(connectionId);
      if (!conn) {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }

      let targetUrl = "";
      let protocol = "openai";
      const apiKey =
        conn.apiKey ||
        conn.accessToken ||
        conn.providerSpecificData?.apiKey ||
        conn.data?.accessToken ||
        "";

      let customHeaders = {};

      if (isOpenAICompatibleProvider(conn.provider)) {
        let base = conn.providerSpecificData?.baseUrl || conn.baseUrl || "";
        base = base.replace(/\/+$/, "");
        targetUrl = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
        protocol = "openai";
      } else if (isAnthropicCompatibleProvider(conn.provider)) {
        let base = conn.providerSpecificData?.baseUrl || conn.baseUrl || "";
        base = base.replace(/\/+$/, "");
        targetUrl = base.endsWith("/v1/messages") ? base : `${base}/v1/messages`;
        protocol = "anthropic";
      } else {
        const std = PROVIDERS[conn.provider];
        if (std?.headers) {
          customHeaders = { ...std.headers };
        }
        if (conn.provider === "anthropic") {
          targetUrl = "https://api.anthropic.com/v1/messages";
          protocol = "anthropic";
        } else if (conn.provider === "openai") {
          targetUrl = "https://api.openai.com/v1/chat/completions";
          protocol = "openai";
        } else if (conn.provider === "deepseek") {
          targetUrl = "https://api.deepseek.com/chat/completions";
          protocol = "openai";
        } else if (conn.provider === "siliconflow") {
          targetUrl = "https://api.siliconflow.cn/v1/chat/completions";
          protocol = "openai";
        } else if (conn.provider === "moonshot") {
          targetUrl = "https://api.moonshot.cn/v1/chat/completions";
          protocol = "openai";
        } else if (conn.provider === "groq") {
          targetUrl = "https://api.groq.com/openai/v1/chat/completions";
          protocol = "openai";
        } else {
          targetUrl =
            conn.providerSpecificData?.baseUrl ||
            conn.baseUrl ||
            std?.baseUrl ||
            std?.url ||
            "https://api.openai.com/v1/chat/completions";
          protocol = std?.format === "anthropic" ? "anthropic" : "openai";
        }
      }

      // 获取当前本地可用的 API Key 用于网关代理模式鉴权
      const allKeys = await getApiKeys();
      const activeKey = allKeys.find((k) => k.isActive) || allKeys[0];
      const gatewayApiKey = activeKey?.key || "";

      return NextResponse.json({
        targetUrl,
        protocol,
        apiKey,
        gatewayApiKey,
        customHeaders,
        provider: conn.provider,
        name: conn.name,
      });
    }

    // 导出 JSONL 文件
    if (action === "export") {
      const jsonl = await exportSpeedtestHistoryJsonl();
      return new Response(jsonl, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": 'attachment; filename="speedtest-results.jsonl"',
        },
      });
    }

    // 聚合统计看板数据
    if (action === "stats") {
      const stats = await getSpeedtestStats();
      return NextResponse.json({ stats });
    }

    // 默认历史记录分页查询
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "20", 10);
    const model = searchParams.get("model") || undefined;
    const gatewayUrl = searchParams.get("gatewayUrl") || undefined;
    const batchId = searchParams.get("batchId") || undefined;

    const result = await getSpeedtestHistory({ page, limit, model, gatewayUrl, batchId });
    return NextResponse.json(result);
  } catch (error) {
    console.error("查询测速数据异常:", error);
    return NextResponse.json({ error: error.message || "查询测速数据失败" }, { status: 500 });
  }
}

/**
 * 持久化保存测速评测结果接口
 *
 * @param {Request} request HTTP 请求对象
 * @return {Promise<Response>} 响应对象
 */
export async function POST(request) {
  try {
    const body = await request.json();
    if (!body || !body.model) {
      return NextResponse.json({ error: "缺少必要的测速结果数据" }, { status: 400 });
    }
    const id = await saveSpeedtestResult(body);
    return NextResponse.json({ success: true, id }, { status: 201 });
  } catch (error) {
    console.error("保存测速结果异常:", error);
    return NextResponse.json({ error: error.message || "保存测速结果失败" }, { status: 500 });
  }
}

/**
 * 清理测速历史记录接口
 *
 * @param {Request} request HTTP 请求对象
 * @return {Promise<Response>} 响应对象
 */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const batchId = searchParams.get("batchId") || undefined;
    const beforeDate = searchParams.get("beforeDate") || undefined;

    const deletedCount = await clearSpeedtestHistory({ batchId, beforeDate });
    return NextResponse.json({ success: true, deletedCount });
  } catch (error) {
    console.error("清理测速记录异常:", error);
    return NextResponse.json({ error: error.message || "清理测速记录失败" }, { status: 500 });
  }
}
