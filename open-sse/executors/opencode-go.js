import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { translateSessionId, OPENCODE_SESSION_RE } from "./opencode.js";
import { modelTargetFormat } from "../providers/models/schema.js";
import { getProviderModels } from "../config/providerModels.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";

const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeGoSession";
const MAX_SESSION_LENGTH = 256;

const RESPONSES_BASE_URL = "https://opencode.ai/zen/go/v1/responses";
const MAX_TOOL_NAME_LEN = 128;

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

/**
 * 提取并校验请求头中的原生合法 OpenCode 会话标识
 *
 * @param {Record<string, unknown>|null|undefined} headers 请求头对象
 * @return {string|null} 原生合法会话标识
 */
function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const norm = normalizeSession(value);
      if (norm && OPENCODE_SESSION_RE.test(norm)) return norm;
    }
  }
  return null;
}

/**
 * 将外部会话标识确定性转换为符合规范的 OpenCode 会话标识
 *
 * @param {string} sessionId 原始外部会话标识
 * @param {string} [clientTool=""] 客户端工具名称
 * @return {string} 规范的 OpenCode 会话标识
 */
function translatedSession(sessionId, clientTool) {
  return translateSessionId(sessionId, clientTool || "opencode-go");
}

// Strip the thinking suffix "model(level)" so checks hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

// 判定是否为 Responses 协议模型（包括 muse-spark 系列及注册表中声明为 openai-responses 的模型）
function isResponsesModel(model) {
  const base = baseModelId(model);
  if (isMuseSparkModel(base)) return true;
  const entry = getProviderModels("opencode-go").find((m) => m.id === base);
  return modelTargetFormat(entry) === "openai-responses";
}

// Flatten Chat Completions tool declarations into the Responses flat shape and
// drop hosted/nameless tools the /responses endpoint rejects.
function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    // Mirror the request translator: {type:"object"} without properties is rejected
    // by strict Responses backends, so fill in the empty properties map.
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

/**
 * 清洗 Responses 模型的 input 消息项
 * 过滤历史推理项并移除非法字段，确保工具调用参数和标识符合规范
 *
 * @param {Record<string, unknown>} body 请求体对象
 * @return {void}
 */
function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // 过滤上一轮历史思维链项，防范多账号池轮换触发加密内容校验 400 异常
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

export class OpenCodeGoExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-go");
  }

  /**
   * 构建上游请求目标 URL，支持自定义 Base URL 中转 Responses 模型
   *
   * @param {string} model 模型名称
   * @param {boolean} [stream=true] 是否流式
   * @param {number} [urlIndex=0] URL 索引
   * @param {Record<string, unknown>} [credentials=null] 凭据信息
   * @return {string} 上游目标 URL
   */
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (isResponsesModel(model)) {
      const customBase = credentials?.providerSpecificData?.baseUrl;
      if (typeof customBase === "string" && customBase.trim()) {
        const normalized = customBase.trim().replace(/\/$/, "");
        return `${normalized}/responses`;
      }
      return RESPONSES_BASE_URL;
    }
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const native = nativeSession(sourceCredentials.rawHeaders);
    const resolved = normalizeSession(providerSessionId) || resolveSessionId({
      headers: sourceCredentials.rawHeaders,
      body,
      connectionId: sourceCredentials.connectionId,
      scope: "opencode-go",
    });

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: native || translatedSession(resolved, clientTool),
    };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    return super.execute({ ...args, credentials });
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials || {}, stream, url, model);
    const prepared = credentials?.[SESSION_FIELD];
    if (prepared) {
      headers[SESSION_HEADER] = prepared;
      return headers;
    }

    const fallback = this.prepareRequestCredentials({ credentials });
    headers[SESSION_HEADER] = fallback[SESSION_FIELD];
    return headers;
  }

  /**
   * @Override
   * 转换请求体以适配 Responses 格式，并注入会话缓存键
   *
   * @param {string} model 模型名称
   * @param {Record<string, unknown>} body 待发送请求体
   * @param {boolean} stream 是否流式
   * @param {Record<string, unknown>} credentials 凭据信息
   * @return {Record<string, unknown>} 转换后的请求体
   */
  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body, stream, credentials);
    const preparedSession = credentials?.[SESSION_FIELD];
    if (preparedSession && out && typeof out === "object" && !out.prompt_cache_key) {
      out.prompt_cache_key = preparedSession;
    }
    if (!isResponsesModel(model || body?.model)) return out;
    const normalized = normalizeResponsesInput(out.input);
    if (normalized) out.input = normalized;
    if (!Array.isArray(out.input) || out.input.length === 0) {
      out.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }
    // Responses names the output cap max_output_tokens, not max_tokens.
    if (out.max_output_tokens === undefined) {
      if (out.max_completion_tokens !== undefined) out.max_output_tokens = out.max_completion_tokens;
      else if (out.max_tokens !== undefined) out.max_output_tokens = out.max_tokens;
    }
    delete out.max_tokens;
    delete out.max_completion_tokens;
    if (out.reasoning_effort !== undefined && out.reasoning === undefined) {
      out.reasoning = { effort: out.reasoning_effort, summary: "auto" };
    }
    if (out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning)) {
      if (!out.reasoning.summary) out.reasoning.summary = "auto";
    }
    delete out.reasoning_effort;
    out.stream = true;
    out.store = false;
    normalizeResponsesTools(out);
    sanitizeResponsesItems(out);
    return out;
  }
}
