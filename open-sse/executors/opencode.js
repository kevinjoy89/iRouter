import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";

const OPENCODE_UA = "opencode/1.18.31";
const MAX_SESSION_LENGTH = 256;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

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

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    if (isResponsesModel(model) && body && typeof body === "object") {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
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
