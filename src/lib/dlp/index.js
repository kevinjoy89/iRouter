// 请求脱敏的 app 侧调用方。
//
// 分工（design.md 决策 1）：`open-sse/dlp/` 是纯函数引擎，不读 settings、不碰数据库；
// 设置读取、规则选择与已知密钥收集都在这里完成，再注入引擎。这样 open-sse
// 对 app 侧的耦合面不扩大。
import { inspectRequestBody } from "open-sse/dlp/index.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";

// 已知密钥：connections 里的上游凭据。命中即判泄漏、零误报。
// 排序去重后按长度降序交给引擎（长匹配优先，避免被短密钥前缀截断）。
const KNOWN_SECRET_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken"];
const KNOWN_SECRET_MIN_LENGTH = 8;
const KNOWN_SECRET_CACHE_TTL_MS = 30000;

let cachedSecrets = null;
let cachedSecretsAt = 0;

/**
 * 收集本机已知的上游凭据值。仅内存使用，不写日志、不外发。
 * 30 秒缓存：凭据变更不频繁，而它位于每个请求的路径上。
 */
export async function collectKnownSecrets() {
  if (cachedSecrets && Date.now() - cachedSecretsAt < KNOWN_SECRET_CACHE_TTL_MS) return cachedSecrets;
  try {
    const connections = await getProviderConnections();
    const secrets = new Set();
    for (const conn of connections || []) {
      for (const field of KNOWN_SECRET_FIELDS) {
        const value = conn?.[field];
        if (typeof value === "string" && value.length >= KNOWN_SECRET_MIN_LENGTH) secrets.add(value);
      }
    }
    cachedSecrets = [...secrets];
  } catch {
    // 读凭据失败不阻断请求：已知密钥匹配是增强项，规则匹配仍照常工作
    cachedSecrets = [];
  }
  cachedSecretsAt = Date.now();
  return cachedSecrets;
}

/** 设置变更后清缓存（settings/connections 写入时调用） */
export function invalidateKnownSecrets() {
  cachedSecrets = null;
  cachedSecretsAt = 0;
}

/**
 * 对已解析的请求体执行脱敏。
 *
 * @returns {{body:*, blocked:boolean, matchedRules:string[], blockedRules:string[],
 *            redactions:number, exemptions:number, scannedFields:number, scannedChars:number,
 *            limitExceeded:boolean, error:string|null}}
 *   `blocked` 为 true 时调用方必须拦截（不转发）。恒不抛出（引擎 fail-open，ADR 0005）。
 */
export async function applyRequestRedaction(body, settings) {
  const result = {
    body, blocked: false, matchedRules: [], blockedRules: [],
    redactions: 0, exemptions: 0, scannedFields: 0, scannedChars: 0,
    limitExceeded: false, error: null,
  };
  const mode = settings?.dlpMode || "off";
  if (mode === "off") return result;

  const knownSecrets = settings.dlpKnownSecrets === false ? [] : await collectKnownSecrets();
  const out = inspectRequestBody(body, {
    mode,
    rules: Array.isArray(settings.dlpRules) && settings.dlpRules.length ? settings.dlpRules : undefined,
    knownSecrets,
    allowExemptions: settings.dlpAllowExemptions === true,
  });

  result.body = out.body;
  result.matchedRules = out.matchedRules;
  result.blockedRules = out.blockedRules;
  result.redactions = out.redactions;
  result.exemptions = out.exemptions;
  result.scannedFields = out.scannedFields;
  result.scannedChars = out.scannedChars;
  result.limitExceeded = out.limitExceeded;
  result.error = out.error;
  // block 动作命中 → 拦截（对应参考实现的 422 sensitive_data_blocked）
  result.blocked = out.blockedRules.length > 0;
  return result;
}

/**
 * 拦截响应（422）。载荷形状对齐参考实现的 sensitive_data_blocked，
 * 便于客户端按 error.type 识别；额外带 rules 便于用户定位是哪条规则命中。
 */
export function blockedResponse(blockedRules) {
  return new Response(JSON.stringify({
    error: {
      type: "sensitive_data_blocked",
      message: "Request blocked by sensitive data policy",
      rules: blockedRules,
    },
  }), {
    status: 422,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * 记录一次脱敏结果。**每个请求都应调用**（mode=off 除外）。
 *
 * 为什么零命中也要记：脱敏开着但内容不含凭据是常态——默认规则全是凭据类
 * （ai_tokens / private_key / jwt / connection_string / 身份证 / 银行卡），
 * 普通对话、代码、文档都不该命中。若零命中不留痕，「扫了但没命中」与「根本没跑」
 * 在日志里完全相同，用户就无从判断功能是否生效（真机反馈即此）。
 * 故零命中记 info 级：每请求一行，与既有请求日志同量级；嫌吵可调 LOG_LEVEL。
 */
export function logDlpOutcome(logger, mode, redaction) {
  if (!mode || mode === "off") return; // 关闭状态不留痕，避免误导
  const scanned = `scanned=${redaction.scannedFields}field/${redaction.scannedChars}char`;
  const rules = redaction.matchedRules.join(",");
  if (redaction.redactions > 0) {
    logger.warn("DLP", `redacted rules=${rules} count=${redaction.redactions} ${scanned}`);
  } else if (redaction.matchedRules.length) {
    logger.info("DLP", `matched(no-rewrite) rules=${rules} ${scanned}`);
  } else {
    logger.info("DLP", `no match mode=${mode} ${scanned}`);
  }
}
