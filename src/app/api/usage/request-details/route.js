import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { getProviderNameMap } from "@/lib/usageProviders";
import { DELETED_PROVIDER_ID } from "@/shared/constants/providers";

/**
 * 对请求入参进行敏感内容脱敏，保留核心配置与消息结构
 *
 * @param {object|null|undefined} req 请求载荷对象
 * @return {object|null|undefined} 脱敏后的请求对象
 * @author wei
 * @since 2026-09-19
 */
function redactRequestPayload(req) {
  if (!req || typeof req !== "object") return req;
  const clone = { ...req };

  // 若包含 messages 数组，保留角色属性并将消息文本替换为脱敏占位
  if (Array.isArray(clone.messages)) {
    clone.messages = clone.messages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      const msgClone = { ...msg };
      if (typeof msgClone.content === "string") {
        msgClone.content = `[REDACTED (${msgClone.content.length} chars)]`;
      } else if (Array.isArray(msgClone.content)) {
        // 多模态或复合内容数组
        msgClone.content = msgClone.content.map((part) => {
          if (part && typeof part === "object") {
            if (part.type === "text" && typeof part.text === "string") {
              return { ...part, text: `[REDACTED (${part.text.length} chars)]` };
            }
            if (part.type === "image_url" || part.type === "image") {
              return { type: part.type, source: "[REDACTED_MEDIA]" };
            }
          }
          return { type: part?.type || "unknown", redacted: true };
        });
      }
      return msgClone;
    });
  }

  // 若包含 input/prompt 字符串
  if (typeof clone.prompt === "string") {
    clone.prompt = `[REDACTED (${clone.prompt.length} chars)]`;
  }
  if (typeof clone.input === "string") {
    clone.input = `[REDACTED (${clone.input.length} chars)]`;
  }

  return clone;
}

/**
 * 对请求详情列表进行安全脱敏，同时保障错误排障所需的上下文完整性
 *
 * @param {Array<object>} details 请求明细记录数组
 * @return {Array<object>} 脱敏后的请求明细记录数组
 * @author wei
 * @since 2026-09-19
 */
export function redactDetails(details) {
  return (details || []).map((d) => {
    const redacted = { ...d };
    const isError = d.status === "error" || Boolean(d.response?.error);

    // 1. 请求载荷脱敏：保留模型与调用参数，对对话消息正文执行掩码
    if (redacted.request !== undefined) {
      redacted.request = redactRequestPayload(redacted.request);
    }
    if (redacted.providerRequest !== undefined) {
      redacted.providerRequest = redactRequestPayload(redacted.providerRequest);
    }

    // 2. 提供商原始响应脱敏：错误状态保留上游报错以供排障
    if (redacted.providerResponse !== undefined) {
      if (isError) {
        redacted.providerResponse = redacted.providerResponse;
      } else {
        redacted.providerResponse = { redacted: true };
      }
    }

    // 3. 客户端最终响应脱敏：错误状态保留关键排障字段
    if (redacted.response !== undefined) {
      if (isError) {
        redacted.response = {
          error: d.response?.error || "Unknown error",
          status: d.response?.status,
        };
      } else {
        redacted.response = { redacted: true };
      }
    }

    return redacted;
  });
}

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider === DELETED_PROVIDER_ID) {
      // "Deleted Providers" is a UI grouping, not a real provider id: match every
      // provider that no longer resolves to a configured node or built-in provider.
      filter.providerNotIn = Object.keys(await getProviderNameMap());
    } else if (provider) {
      filter.provider = provider;
    }
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await getRequestDetails(filter);
    const redactedDetails = redactDetails(result.details);

    return NextResponse.json({ ...result, details: redactedDetails });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
