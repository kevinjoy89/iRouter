// 控制台日志行解析（自维护特性）：把网关运行日志的行形状
// "[HH:MM:SS] emoji [TAG] 文本" 解析为结构化元数据，供控制台页做
// 级别过滤、标签/内容搜索与配色。纯函数，便于单测。

export const LOG_LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "LOG"];

// emoji（去 U+FE0F 变体选择符后）→ 级别；未命中的（含会话色点 🟢 等）归为 LOG
const EMOJI_LEVEL = {
  "❌": "ERROR",
  "💥": "ERROR",
  "⚠": "WARN",
  "ℹ": "INFO",
  "🔍": "DEBUG",
  "⨯": "ERROR",
  "✗": "ERROR",
  "✘": "ERROR",
  "✖": "ERROR",
  "×": "ERROR",
};

// 无级别 emoji 的行按文本标记识别（Next 错误行以 ⨯ 开头、Warning:/Error: 等）
const TEXT_MARKERS = [
  [/^(?:⨯|✗|✘|✖|×|❌|💥)/, "ERROR"],
  [/(^|\s)Error:/, "ERROR"],
  [/^⚠/, "WARN"],
  [/(^|\s)Warning:/i, "WARN"],
  [/^🔍/, "DEBUG"],
  [/(^|\s)Debug:/i, "DEBUG"],
  [/^ℹ/, "INFO"],
];

function detectByMarkers(line) {
  for (const [re, lv] of TEXT_MARKERS) {
    if (re.test(line)) return lv;
  }
  return null;
}

// [时间] 图标 [TAG] 文本；时间/TAG 均可缺失
const LINE_RE = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*(\S+)\s*(?:\[([A-Z0-9_-]+)\])?\s?(.*)$/s;

export function parseLogLine(raw) {
  const rawStr = String(raw ?? "");
  const m = LINE_RE.exec(rawStr);
  if (!m) {
    // 无时间戳前缀的行（Next 错误行 ⨯ Error: …、Warning: … 等）按文本标记识别
    return {
      time: "",
      icon: "",
      tag: "",
      text: rawStr,
      level: detectByMarkers(rawStr) || "LOG",
      raw: rawStr,
    };
  }
  const [, time, iconRaw, tag = "", text = ""] = m;
  const icon = iconRaw.replace(/\uFE0F/g, "");
  return {
    time,
    icon,
    tag,
    text,
    level: EMOJI_LEVEL[icon] || detectByMarkers(rawStr) || "LOG",
    raw: rawStr,
  };
}

// 过滤：levels 为 Set（空/缺省 = 全部级别）；query 大小写不敏感匹配
// 原始行（文本/标签/时间一体匹配，输入 COMBO 即可只看组合日志）
export function matchesFilters(entry, { levels = null, query = "" } = {}) {
  if (levels && levels.size > 0 && !levels.has(entry.level)) return false;
  const q = query.trim().toLowerCase();
  if (q && !entry.raw.toLowerCase().includes(q)) return false;
  return true;
}