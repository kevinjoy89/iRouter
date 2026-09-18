import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { getDeclaredLevels, clampLevel, resolveRequestedEffort, applyEffortToBody } from "open-sse/services/effortCaps.js";
import { stripThinkingSuffix } from "open-sse/translator/concerns/thinkingUnified.js";
import { resolveAutoRetry, withAutoRetry, isRetryable, waitBeforeRetry, parseRetryAfterHeader } from "open-sse/services/autoRetry.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { applyRequestRedaction, blockedResponse, logDlpOutcome } from "@/lib/dlp/index.js";

// effort-aware 路由开关（自维护特性，ADR 0003）：每 combo 配置覆盖全局默认。
// 全局默认开（settings.effortAwareRoute !== false）。
function effortAwareRouteFor(settings, comboName) {
  const specific = (settings.comboStrategies || {})[comboName]?.effortAwareRoute;
  if (typeof specific === "boolean") return specific;
  return settings.effortAwareRoute !== false;
}

/**
 * Handle chat completion request（自维护特性 ADR 0003：外层包自动重试）
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 *
 * 请求级自动重试：整条回退链（账号 → combo 成员）穷尽且错误可重试（429/5xx/限流
 * 文本）时，按 settings.autoRetry 等待后整组重来，防止 Agent 因临时限流停摆。
 * 重试只发生在首字节之前；客户端断开（request.signal）立即停止等待。
 * 耗尽后原样返回最后一个错误（429 + Retry-After），由客户端自行兜底。
 */
export async function handleChat(request, clientRawRequest = null) {
  const settings = await getSettings();
  // 完整异常日志开关：每次请求按最新设置刷新，开关改动即时生效
  log.setVerboseErrors(settings.verboseErrorLog);
  const cfg = resolveAutoRetry(settings);

  // 请求体只能读一次：`request.json()` 消费流，重试闭包内再读会抛
  // `TypeError: Body is unusable`，导致第 2 次尝试恒返回 400（限流重试整体失效）。
  // 解析提到重试之外，重试复用同一对象。对 body 的原地改写
  // （stripUnsupportedModalities / prefetchRemoteImages / applyEffortToBody）
  // 均为幂等，重复执行结果一致——账号回退与 combo 成员回退早已是同一模式。
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // 请求脱敏（ADR 0005）：在客户端 body 上做一次，统一覆盖全部 translator；
  // 与重试共用同一对象，故重试期间不会出现「首次脱敏、重试漏脱敏」。
  // 引擎恒 fail-open（出错返回原文），block 命中才拦截。
  const redaction = await applyRequestRedaction(body, settings);
  if (redaction.error) {
    log.warn("DLP", `inspection failed, forwarding as-is: ${redaction.error}`);
  }
  if (redaction.blocked) {
    log.warn("DLP", `blocked rules=${redaction.blockedRules.join(",")}`);
    return blockedResponse(redaction.blockedRules);
  }
  // 每个请求都记一行（含零命中）：否则「扫了但没命中」与「根本没跑」在日志里
  // 无法区分——这正是排查「开了脱敏却没看到命中」时最容易误导人的地方。
  logDlpOutcome(log, settings.dlpMode, redaction);
  body = redaction.body;

  if (!cfg.enabled) return handleChatOnce(request, clientRawRequest, settings, null, body);
  const retryState = { waitedMs: 0 };
  return withAutoRetry(
    () => handleChatOnce(request, clientRawRequest, settings, retryState, body),
    cfg,
    { signal: request?.signal, retryState, log, label: "RETRY" }
  );
}

async function handleChatOnce(request, clientRawRequest = null, settings = null, retryState = null, body = null) {
  if (!settings) settings = await getSettings();
  // body 由 handleChat 解析后传入；缺省时兜底自解析（直接调用本函数的测试/路径）。
  if (!body) {
    try {
      body = await request.json();
    } catch {
      log.warn("CHAT", "Invalid JSON body");
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    }
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);
  const autoRetryCfg = resolveAutoRetry(settings);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, retryState),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      comboStickyRespectRetries: !!settings.comboStickyRespectRetries,
      effortCaps: settings.effortCaps,
      effortAwareRoute: effortAwareRouteFor(settings, modelStr),
      autoRetry: autoRetryCfg,
      retryState,
      signal: request?.signal
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, retryState),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      comboStickyRespectRetries: !!settings.comboStickyRespectRetries,
      effortCaps: settings.effortCaps,
      effortAwareRoute: effortAwareRouteFor(settings, modelStr),
      autoRetry: autoRetryCfg,
      retryState,
      signal: request?.signal
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, retryState);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, retryState = null) {
  const settings = await getSettings();
  const modelInfo = await getModelInfo(modelStr);

  // 思考强度上限（自维护特性，ADR 0003）：声明集合用于
  // ① 漏斗钳制（模型后缀/body 档位字段）② 传入翻译层钳制线上产出档位——
  // 客户端思考意图可能是 budget 形状（如 Claude Code），且各格式映射非单调
  // （deepseek 把 xhigh 升为 max），必须在翻译输出处兜底。
  const declared = getDeclaredLevels(settings, modelStr);
  if (declared) {
    const req = resolveRequestedEffort(body, modelStr);
    if (req?.level) {
      const clamped = clampLevel(req.level, declared);
      if (clamped !== req.level) {
        log.info("EFFORT", `clamp ${modelStr}: ${req.level} → ${clamped}`);
        if (req.viaSuffix) {
          modelStr = `${stripThinkingSuffix(modelStr)}(${clamped})`;
        } else if (req.shape) {
          applyEffortToBody(body, req.shape, clamped);
        }
      }
    }
  }

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = settings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        effortCaps: settings.effortCaps,
        effortAwareRoute: effortAwareRouteFor(settings, modelStr)
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const autoRetryCfg = resolveAutoRetry(chatSettings);
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;

    const executeCoreCall = async () => handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      effortCap: declared,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    let result = await executeCoreCall();
    if (result.success) return result.response;

    // 账号级原地重试（accountRetries）：在切下个账号前优先在当前账号原地等待重试
    if (autoRetryCfg.accountRetries > 0 && isRetryable(result.status, result.error, autoRetryCfg)) {
      for (let a = 0; a < autoRetryCfg.accountRetries; a++) {
        const retryAfterMs = parseRetryAfterHeader(result.response?.headers?.get?.("retry-after"));
        const proceed = await waitBeforeRetry({
          cfg: autoRetryCfg,
          attempt: a,
          retryAfterMs,
          retryState,
          signal: request?.signal,
          log,
          label: "ACC-RETRY",
        });
        if (!proceed) {
          if (request?.signal?.aborted) return result.response;
          break;
        }
        log.info("ACC-RETRY", `Retrying account ${credentials.connectionName} for ${provider}/${model} (${a + 1}/${autoRetryCfg.accountRetries})`);
        const retried = await executeCoreCall();
        if (retried.success) {
          log.info("ACC-RETRY", `Account ${credentials.connectionName} succeeded on retry ${a + 1}/${autoRetryCfg.accountRetries}`);
          return retried.response;
        }
        result = retried;
        if (!isRetryable(result.status, result.error, autoRetryCfg)) {
          break;
        }
      }
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
