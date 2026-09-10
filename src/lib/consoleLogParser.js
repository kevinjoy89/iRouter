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
  [/✗|✘/, "ERROR"], // 行内失败标记（如 "🔵 ✗ ERROR 429 · ..."）
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

// [时间] 图标 [TAG] 文本；时间/TAG 均可缺失（解析见 parseLogLine，
// 优先识别 [TAG] 开头，再按 emoji 图标在前解析）
const LINE_RE = null; // 占位：早期正则已并入 parseLogLine 分支逻辑

export function parseLogLine(raw) {
  const rawStr = String(raw ?? "");
  // 时间戳分支：先尝试 [TAG] 开头（补时间戳的裸 console 输出，如
  // "[00:32:05] [DB] better-sqlite3 ..."），否则按 logger 形状
  // "[time] emoji [TAG] 文本" 解析（emoji 图标在前）
  const tm = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*/.exec(rawStr);
  if (!tm) {
    // 无时间戳前缀的行（Next 错误行 ⨯ Error: …、Warning: … 等）按文本标记识别
    return {
      time: "",
      icon: "",
      tag: "",
      // 与时间戳分支一致：摊平内部换行（堆栈类多行日志）
      text: rawStr.replace(/\s*\n\s*/g, " ").replace(/\s+$/, ""),
      level: detectByMarkers(rawStr) || "LOG",
      raw: rawStr,
    };
  }
  let rest = rawStr.slice(tm[0].length);
  const tagFirst = /^\[([A-Z0-9_-]+)\]\s*/.exec(rest);
  let icon = "";
  let tag = "";
  let text = "";
  if (tagFirst) {
    tag = tagFirst[1];
    text = rest.slice(tagFirst[0].length);
  } else {
    const ic = /^(\S+?)(?:\s+|$)/u.exec(rest);
    if (ic) {
      icon = ic[1];
      rest = rest.slice(ic[0].length);
    }
    const tagM = /^\[([A-Z0-9_-]+)\]\s*/.exec(rest);
    if (tagM) {
      tag = tagM[1];
      text = rest.slice(tagM[0].length);
    } else {
      text = rest;
    }
  }
  return {
    time: tm[1],
    icon: icon.replace(/\uFE0F/g, ""),
    tag,
    // 摊平内部换行（堆栈类多行日志）：行视图定高单行渲染，保留 raw 供复制/搜索
    text: text.replace(/\s*\n\s*/g, " ").replace(/\s+$/, ""),
    level: EMOJI_LEVEL[icon.replace(/\uFE0F/g, "")] || detectByMarkers(rawStr) || "LOG",
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