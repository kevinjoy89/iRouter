// 完整异常日志（设置项 settings.verboseErrorLog，默认关）：上游异常时把「发给 LLM
// 的请求体」与「LLM 返回的原文」整段写入控制台日志，用于定位上游为何失败
// （如内容审核 400 到底撞在 prompt 的哪一段）。
//
// 开关判断走 duck-typing 的 log.isVerboseErrors（与 log.errorDetail / log.errorLine
// 同一套约定），且前置短路：关掉时不做任何序列化，大 body 的 JSON.stringify 开销为零。
import { VERBOSE_STREAM_CAPTURE_MAX_BYTES } from "../config/runtimeConfig.js";

function enabled(log) {
  return log?.isVerboseErrors?.() === true && typeof log.errorDetail === "function";
}

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const byteLen = (s) => (typeof Buffer !== "undefined" ? Buffer.byteLength(s, "utf8") : s.length);

/**
 * 打印一次完整的请求/响应交换（两条日志行：REQ 与 RES）。
 * @param {object} log - 请求 logger（需具备 isVerboseErrors + errorDetail）
 * @param {string} tag - 会话关联色点（reqTag）
 * @param {object} opts
 * @param {string} opts.stage - 异常出口标记（UPSTREAM / EXEC / STREAM / PARSE / …）
 * @param {string} [opts.status] - 上游状态码或错误信息
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {string} [opts.url] - 上游 URL
 * @param {object|string} [opts.requestBody] - 实际发给 LLM 的 body（finalBody || translatedBody）
 * @param {object|string} [opts.responseText] - LLM 返回的原文
 */
export function logVerboseExchange(log, tag, { stage, status, provider, model, url, requestBody, responseText } = {}) {
  if (!enabled(log)) return;
  const head = [stage, [provider, model].filter(Boolean).join("/"), url, status != null && status !== "" ? `status=${status}` : ""]
    .filter(Boolean)
    .join(" · ");
  const req = asText(requestBody);
  if (req) log.errorDetail(tag, "✗", `REQ · ${head} · ${byteLen(req)}B:\n${req}`);
  const res = asText(responseText);
  if (res) log.errorDetail(tag, "✗", `RES · ${head} · ${byteLen(res)}B:\n${res}`);
}

/**
 * 把上游 body 接进捕获器：内联透传（不缓冲、不 tee），仅在开关开启时生效。
 * 用于还没读成文本就被下游消费的流（如 Responses API SSE→JSON）。
 */
export function tapUpstreamStream(body, capture) {
  if (!capture || !body) return body;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      capture.push(chunk);
      controller.enqueue(chunk);
    },
  }));
}

/**
 * 流式原文累积器：仅在开关开启时收集上游原始报文，异常出口一次性取出。
 * 上限按字符近似（SSE 报文是 JSON 转义的 ASCII，字符数≈字节数），防止长流式输出撑爆内存。
 * @param {object} log - 请求 logger
 * @param {string} [url] - 上游 URL（打印到 REQ/RES 行头）
 * @param {string} [reqTag] - 会话关联色点
 * @param {string} [provider]
 * @param {string} [model]
 * @param {object|string} [requestBody]
 * @param {string|number} [status]
 * @returns {null|{push: Function, take: Function, dump: Function}}
 */
export function createUpstreamCapture(log, { url, reqTag, provider, model, requestBody, status } = {}) {
  if (!enabled(log)) return null;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let truncated = false;
  let taken = false;
  return {
    push(chunk) {
      if (truncated || taken) return;
      try {
        text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      } catch {
        return; // 捕获失败绝不打断请求
      }
      if (text.length >= VERBOSE_STREAM_CAPTURE_MAX_BYTES) {
        text = text.slice(0, VERBOSE_STREAM_CAPTURE_MAX_BYTES);
        truncated = true;
      }
    },
    // 取出即释放（只打印一次：异常出口可能被多条路径命中）
    take() {
      if (taken) return null;
      taken = true;
      try {
        text += decoder.decode(); // 冲刷被切开的末尾多字节字符
      } catch { /* 忽略：已解出的部分照常打印 */ }
      if (!text) return null;
      const out = truncated ? `${text}…[truncated at ${VERBOSE_STREAM_CAPTURE_MAX_BYTES}B]` : text;
      text = "";
      return out;
    },
    // 异常出口：打印请求体 + 已累积的上游原文
    dump(extra = {}) {
      if (taken) return;
      logVerboseExchange(log, reqTag, {
        stage: "STREAM",
        status: extra.status ?? status,
        provider, model, url,
        requestBody,
        responseText: this.take(),
      });
    },
  };
}
