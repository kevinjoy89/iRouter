// 思考强度上限（effort cap）：按 (provider, model) 声明的可接受档位集合，
// 提供钳制/降级的纯函数，供 combo.js（能力感知排序、反应式降档重试）与
// chat.js（漏斗钳制）共用。档位序与 thinkingLevels.js 的既有语义一致。
// 自维护特性（ADR 0003）：上游无此能力，逻辑全部收敛在本模块。
import { extractThinking, parseSuffix, stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";

// 档位梯（降序）。none/auto 是开关语义，不参与钳制与降级步进。
export const EFFORT_LADDER_DESC = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal"];

// settings.effortCaps: { "provider/model": ["low","medium","high","xhigh"] }（升序）。
// 取声明集合；未声明返回 null。modelStr 自动剥离思考后缀 "model(high)"。
export function getDeclaredLevels(settings, modelStr) {
  const caps = settings?.effortCaps;
  if (!caps || typeof caps !== "object") return null;
  const set = caps[stripThinkingSuffix(modelStr)];
  return Array.isArray(set) && set.length > 0 ? set : null;
}

// 钳 level 到声明集合：取集合内 ≤ level 的最大档；集合整体高于 level 时取下限。
// level 不在档位梯上（none/auto/未知）或集合恰好包含它时原样返回。
export function clampLevel(level, declared) {
  if (!declared?.length || declared.includes(level)) return level;
  const idx = EFFORT_LADDER_DESC.indexOf(level);
  if (idx < 0) return level;
  for (const l of EFFORT_LADDER_DESC.slice(idx)) {
    if (declared.includes(l)) return l;
  }
  return declared[0];
}

// 请求中思考强度的来源。模型后缀 "model(high)" 优先于 body 字段，与
// applyThinking 的 override > intent 一致。viaSuffix 时改模型名即可，无需改 body。
export function resolveRequestedEffort(body, modelStr = "") {
  const suffix = parseSuffix(modelStr);
  if (suffix.override?.mode === "level") {
    return { level: suffix.override.level, viaSuffix: true, shape: null };
  }
  const intent = extractThinking(body);
  if (intent?.mode === "level") {
    return { level: intent.level, viaSuffix: false, shape: detectEffortShape(body) };
  }
  return null;
}

// 定位 body 中承载档位的字段形状（与 extractThinking 的检测顺序一致）。
function detectEffortShape(body) {
  if (body?.output_config?.effort) return "output_config";
  if (body?.reasoning_effort) return "reasoning_effort";
  if (body?.reasoning?.effort) return "reasoning";
  if (body?.thinkingConfig?.thinkingLevel) return "thinkingConfig";
  if (body?.generationConfig?.thinkingConfig?.thinkingLevel) return "thinkingConfig-gen";
  if (body?.request?.generationConfig?.thinkingConfig?.thinkingLevel) return "thinkingConfig-req";
  return null;
}

// 把档位写回 body 的指定形状（只改找到的字段，不动其它）。
export function applyEffortToBody(body, shape, level) {
  switch (shape) {
    case "output_config":
      body.output_config = { ...body.output_config, effort: level };
      break;
    case "reasoning_effort":
      body.reasoning_effort = level;
      break;
    case "reasoning":
      body.reasoning = { ...body.reasoning, effort: level };
      break;
    case "thinkingConfig":
      body.thinkingConfig = { ...body.thinkingConfig, thinkingLevel: level };
      break;
    case "thinkingConfig-gen":
      body.generationConfig = {
        ...body.generationConfig,
        thinkingConfig: { ...body.generationConfig.thinkingConfig, thinkingLevel: level },
      };
      break;
    case "thinkingConfig-req":
      body.request = {
        ...body.request,
        generationConfig: {
          ...body.request.generationConfig,
          thinkingConfig: { ...(body.request.generationConfig.thinkingConfig || {}), thinkingLevel: level },
        },
      };
      break;
  }
  return body;
}

// 下一降级档：有声明集合 → 跳至集合内低于 current 的最高档（尽量少发被拒请求）；
// 无声明 → 沿档位梯降一档。已到梯底或集合下限之下 → null（不再降）。
export function nextLowerLevel(current, declared) {
  const idx = EFFORT_LADDER_DESC.indexOf(current);
  if (idx < 0 || idx >= EFFORT_LADDER_DESC.length - 1) return null;
  const below = EFFORT_LADDER_DESC.slice(idx + 1);
  if (declared?.length) {
    for (const l of below) {
      if (declared.includes(l)) return l;
    }
    return null;
  }
  return below[0];
}

// invalid-effort 类错误的窄匹配：400/422 且错误文本提及 reasoning_effort/effort 字段。
// 例如 "fieldReasoningEffort invalid, should be one of: low,medium, high, xhigh"。
export function isInvalidEffortError(status, errorText) {
  if (status !== 400 && status !== 422) return false;
  const text = String(errorText ?? "").toLowerCase();
  return /reasoning.?effort/.test(text) || /(^|[^a-z])effort[^a-z0-9]/.test(text);
}