import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import {
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

const OPENCODE_UA = "opencode/1.18.31";
const MAX_SESSION_LENGTH = 256;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// OpenCode 免费端点强制要求客户端携带 Agent 必备工具指纹，缺失时会触发 403 FreeTierError
export const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];
const MAX_TOOL_NAME_LEN = 128;

/**
 * 校验 User-Agent 中的 OpenCode 版本是否满足最低要求（>= 1.17）
 *
 * @param {string} ua 客户端传入的 User-Agent 字符串
 * @return {boolean} 版本是否合规
 */
function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 17);
}

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

let lastTimestamp = 0;
let counter = 0;

/**
 * 生成 14 位 Base62 格式的伪随机字符序列
 *
 * @return {string} 14 位 Base62 字符串
 */
function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

/**
 * 生成符合 OpenCode 规范的会话标识符（ses_ + 12位十六进制时间戳 + 14位Base62随机串）
 *
 * @param {number} [timestamp=Date.now()] 时间戳毫秒数
 * @return {string} 格式化后的规范会话标识
 */
export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `ses_${time}${unstableRandom()}`;
}

/**
 * 生成符合 OpenCode 规范的请求标识符（msg_ + 12位十六进制时间戳 + 14位Base62随机串）
 *
 * @param {number} [timestamp=Date.now()] 时间戳毫秒数
 * @return {string} 格式化后的规范请求标识
 */
export function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

/**
 * 将外部传入的会话标识确定性转换为符合规范的 OpenCode 会话标识
 *
 * @param {string} sessionId 原始外部会话标识
 * @param {string} [clientTool=""] 客户端调用方工具标识
 * @return {string} 规范的 OpenCode 会话标识
 */
export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
}

/**
 * 规范化并校验会话字符串长度
 *
 * @param {unknown} value 待校验的会话值
 * @return {string|null} 去除首尾空白的会话字符串，若不合法则返回 null
 */
function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

/**
 * 从请求头中提取原生的合法 OpenCode 会话标识
 *
 * @param {Record<string, string>|null|undefined} headers 请求头对象
 * @return {string|null} 合法的原生会话标识，若不存在或不合规返回 null
 */
function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

/**
 * 解析并提取工具声明的名称
 *
 * @param {Record<string, unknown>|null|undefined} tool 工具声明对象
 * @return {string} 工具名称，解析失败返回空字符串
 */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  if (tool.function && typeof tool.function === "object" && typeof tool.function.name === "string") {
    return tool.function.name.trim();
  }
  return "";
}

/**
 * 为 Chat Completions 请求补齐 OpenCode 所需的工具指纹，防止触发免费层风控拦截
 *
 * @param {Record<string, unknown>} body 请求体对象
 * @return {void}
 */
function ensureChatFingerprintTools(body) {
  const existing = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) existing.add(name);
    }
  } else {
    body.tools = [];
  }
  // 注入缺少的指纹工具占位声明
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (existing.has(name)) continue;
    body.tools.push({
      type: "function",
      function: {
        name,
        description: "",
        parameters: { type: "object", properties: {} },
      },
    });
  }
}

/**
 * 为 Responses 请求补齐 OpenCode 所需的扁平结构工具指纹
 *
 * @param {Record<string, unknown>} body 请求体对象
 * @return {void}
 */
function ensureResponsesFingerprintTools(body) {
  const existing = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) existing.add(name);
    }
  } else {
    body.tools = [];
  }
  // 注入缺少的 Responses 格式指纹工具占位声明
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (existing.has(name)) continue;
    body.tools.push({
      type: "function",
      name,
      description: "",
      parameters: { type: "object", properties: {} },
    });
  }
}

/**
 * 将工具声明规范化为 Responses 格式，并过滤无效工具与未匹配的 tool_choice
 *
 * @param {Record<string, unknown>} body 请求体对象
 * @return {void}
 */
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
    // 对齐请求转换器：Responses 严格校验 schema，补充缺失的 properties
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

/**
 * 解析并生成当前请求所使用的 OpenCode 会话标识
 *
 * @param {unknown} body 请求体数据
 * @param {Record<string, unknown>} credentials 凭证信息
 * @param {string} [providerSessionId] 上游/调用方传入的会话标识
 * @param {string} [clientTool] 客户端工具名称
 * @return {string} 确定性或新生成的规范会话标识
 */
function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const resolved = incoming || normalizeSession(providerSessionId) || resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
  });

  return resolved ? translateSessionId(resolved, clientTool) : generateSessionId();
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  /**
   * 为单次请求准备专属凭据对象，挂载规范化的会话标识以避免并发请求状态覆盖
   *
   * @param {Object} [params] 准备参数
   * @param {unknown} [params.body] 请求体数据
   * @param {Record<string, unknown>} [params.credentials] 原始凭证
   * @param {string} [params.providerSessionId] 外部传入的会话标识
   * @param {string} [params.clientTool] 客户端工具名称
   * @return {Record<string, unknown>} 挂载了 _opencodeSession 的凭据副本
   */
  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const resolved = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: resolved,
    };
  }

  /**
   * 转换请求体以适配 OpenCode 端点规范
   * 强制启用 stream 流式传输、注入客户端工具指纹并清洗思维链字段
   *
   * @param {string} model 模型名称
   * @param {Record<string, unknown>} body 请求体数据
   * @param {boolean} stream 是否流式
   * @param {Record<string, unknown>} credentials 凭据信息
   * @return {Record<string, unknown>} 转换后的请求体
   */
  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object") {
      if (model && !body.model) body.model = model;
      // OpenCode 免费端点对 stream:false 返回 403 FreeTierError，在此强制设为 true
      // 如果下游客户端请求非流式，chatCore 会在接收 SSE 后聚合转换回完整 JSON
      body.stream = true;
    }
    if (isResponsesModel(model) && body && typeof body === "object") {
      // Responses API 将最大输出标记为 max_output_tokens，思维链映射为 reasoning:{effort,summary}
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      // OpenCode responses 端点不支持 store:true，在此强制关闭
      body.store = false;
      normalizeResponsesTools(body);
      ensureResponsesFingerprintTools(body);
      sanitizeResponsesItems(body);
      normalizeOpencodeReasoning(model, body);
    } else if (body && typeof body === "object") {
      ensureChatFingerprintTools(body);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  /**
   * @Override
   * 执行请求前注入当前调用专属的会话凭证
   *
   * @param {Object} args 执行参数
   * @return {Promise<Object>} 执行结果
   */
  async execute(args) {
    return super.execute({ ...args, credentials: this.prepareRequestCredentials(args) });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": session,
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
  }
}
