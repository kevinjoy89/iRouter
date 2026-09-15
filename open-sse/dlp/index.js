// 请求脱敏引擎：转发前检测并改写请求体中的敏感内容。
//
// 移植自参考实现 llm-retry-proxy 的 retry_proxy/dlp.py，语义对齐、语法直译。
// 与其最实质的差异：参考实现是 Python HTTP 代理，手里只有字节，故 `json.loads`
// → 改写 → `json.dumps` 往返；我们的调用点在 `await request.json()` 之后，手里
// 已经是解析好的对象，因此**全程对象进出、不做序列化往返**——顺带消除了
// JSON.stringify 的键序重排与大整数精度问题（见 design.md）。
//
// 三条设计约束（ADR 0005）：
//   1. 纯函数：不读 settings、不碰数据库、不发网络请求。规则与已知密钥由调用方注入。
//   2. 零 `@/` import：引擎不反向依赖 app 侧有状态模块。
//   3. 恒 fail-open：入口全量 try/catch，任何内部异常都返回原文并记日志，
//      绝不抛出。调用点（chatCore.js 同级的 hook）不包裹 try/catch，fail-open
//      是引擎自己的责任——与 open-sse/rtk/ 的既有约定一致。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYAML } from "confbox/yaml";

// 规则文件定位：**不能只用 import.meta.url**。
// Next 会把本模块打包进 .next/server/chunks/*.js，届时 import.meta.url 被构建设置为
// 构建机的绝对路径（实测 chunk 内硬编码 file:///Users/<builder>/.../open-sse/dlp/index.js）。
// 该路径在用户机器上不存在 → loadPolicy 抛错 → 引擎 fail-open → UI 显示已开启但实际
// 从不脱敏（最坏的失败模式：看起来在工作）。故按优先级探测：
//   1. DLP_RULE_FILE 环境变量（显式覆盖，最高优先）
//   2. cwd 相对（壳层 main.js 以 gateway/server 为 cwd 启动，产物内 yaml 随包同层）
//   3. 模块相对（源码直跑 / vitest）
// 三者都不可用时返回最后一个候选，交由调用方按 fail-open 处理并记录 error。
const RULE_FILE_NAME = "dlp_rules.yaml";
const MODULE_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
})();

function resolveDefaultRuleFile({
  envFile = process.env.DLP_RULE_FILE,
  cwd = process.cwd(),
  moduleDir = MODULE_DIR,
} = {}) {
  const candidates = [
    envFile,
    path.join(cwd, "open-sse", "dlp", RULE_FILE_NAME),
    moduleDir ? path.join(moduleDir, RULE_FILE_NAME) : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 探测失败继续下一个候选 */
    }
  }
  // 全都不存在：返回最后一个候选，交由 loadPolicy 抛错 → 调用方 fail-open 并记录 error
  return candidates[candidates.length - 1] || RULE_FILE_NAME;
}

const DEFAULT_RULE_FILE = resolveDefaultRuleFile();

// 身份证校验位权重（GB 11643-1999）
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = "10X98765432";

const FLAG_MAP = { IGNORECASE: "i", MULTILINE: "m", DOTALL: "s" };
const ACTIONS = new Set(["audit", "redact", "block"]);
const ACTION_PRIORITY = { audit: 1, redact: 2, block: 3 };
const VALIDATORS = new Set(["", "cn_id_checksum", "luhn"]);

// 这些字段名下的值若像内联二进制（data URI 或长 base64），跳过扫描：
// 图片/音频载荷里命中「看起来像密钥」的子串纯属噪声，且扫描成本高。
const BINARY_KEYS = new Set([
  "image",
  "image_url",
  "audio",
  "file_data",
  "data",
  "blob",
]);

// 整串是否像 base64（用于上面的内联二进制判定）
const BASE64_FULL = /^[A-Za-z0-9+/]+={0,2}$/;
// 候选编码片段：分别用于 hex / percent / base64 的递归解码
const BASE64_CANDIDATE =
  /(?<![A-Za-z0-9_+/-])[A-Za-z0-9_+/-]{16,}={0,2}(?![A-Za-z0-9_+/-])/g;
const HEX_CANDIDATE = /(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}){16,}(?![0-9A-Fa-f])/g;
const PERCENT_CANDIDATE =
  /(?<![A-Za-z0-9._~%-])(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}){16,}(?![A-Za-z0-9._~%-])/g;
// 控制字符（可打印性判定，近似 Python str.isprintable）
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

// ---------------------------------------------------------------------------
// 校验器与熵
// ---------------------------------------------------------------------------

/** 中国大陆身份证校验位（最后一位）验证 */
export function validIdCard(value) {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(value[i]) * ID_WEIGHTS[i];
  return value[17].toUpperCase() === ID_CHECK[sum % 11];
}

/** 银行卡 Luhn 校验。注意：Python 用 str.isdigit()（Unicode），此处用 [0-9]（ASCII）——卡号本就是 ASCII。 */
export function validBankCard(value) {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (new Set(digits).size === 1) return false;
  let total = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[i]);
    if (i % 2 === parity) n = n > 4 ? n * 2 - 9 : n * 2;
    total += n;
  }
  return total % 10 === 0;
}

/**
 * Shannon 熵（bits/字符）。按 code point 迭代以对齐 Python 的字符语义
 * （JS 的 .length 是 UTF-16 码元数，对非 ASCII 不等价）。
 */
export function entropy(value) {
  if (!value) return 0;
  const counts = new Map();
  let length = 0;
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) || 0) + 1);
    length++;
  }
  let sum = 0;
  for (const count of counts.values()) {
    const p = count / length;
    sum -= p * Math.log2(p);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// 规则加载与校验
// ---------------------------------------------------------------------------

function stringList(value, field, ruleName = "") {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    const prefix = ruleName
      ? `DLP rule ${JSON.stringify(ruleName)} `
      : "DLP policy ";
    throw new Error(`${prefix}${field} must be a string array`);
  }
  return value;
}

/**
 * 加载并校验规则文件。格式或正则错误**在加载期抛出**，不静默降级——
 * 静默失败等于让人以为防护开着而实际没有。调用方决定如何处理该异常
 * （见 inspectRequestBody 的 fail-open）。
 */
export function loadPolicy(ruleFile = DEFAULT_RULE_FILE) {
  let raw;
  try {
    const text = fs.readFileSync(ruleFile, "utf8");
    raw = ruleFile.toLowerCase().endsWith(".json")
      ? JSON.parse(text)
      : parseYAML(text);
  } catch (err) {
    // 保留抛出（这是加载期契约），但补上文件名：调用方只记 err.message，
    // 没有文件名时 ENOENT 与「规则写错」在日志里长得一模一样。
    throw new Error(`DLP rule file ${ruleFile}: ${err?.message}`);
  }

  if (
    !raw ||
    typeof raw !== "object" ||
    (raw.version !== 1 && raw.version !== 2)
  ) {
    throw new Error("unsupported or malformed DLP rule file");
  }
  if (!raw.rules || typeof raw.rules !== "object") {
    throw new Error("DLP rule file has no rules object");
  }
  const defaults = raw.version === 2 ? raw.defaults || {} : {};
  if (typeof defaults !== "object")
    throw new Error("DLP defaults must be an object");

  const defaultAction = defaults.action || "redact";
  const defaultPlaceholder = defaults.placeholder || "[REDACTED:{rule}]";
  if (!ACTIONS.has(defaultAction))
    throw new Error(
      `unknown default DLP action ${JSON.stringify(defaultAction)}`,
    );
  if (
    typeof defaultPlaceholder !== "string" ||
    !defaultPlaceholder.includes("{rule}")
  ) {
    throw new Error("DLP default placeholder must contain {rule}");
  }

  const rules = new Map();
  for (const [name, def] of Object.entries(raw.rules)) {
    if (!def || typeof def !== "object")
      throw new Error(`DLP rule ${JSON.stringify(name)} must be an object`);

    let flags = "g"; // g 用于 matchAll 迭代；d 用于取捕获组偏移
    for (const flag of stringList(def.flags, "flags", name)) {
      if (!FLAG_MAP[flag])
        throw new Error(
          `DLP rule ${JSON.stringify(name)} uses unknown regex flag ${JSON.stringify(flag)}`,
        );
      flags += FLAG_MAP[flag];
    }

    const jsonKeys = new Set(
      stringList(def.json_keys, "json_keys", name).map((k) => k.toLowerCase()),
    );
    const patternText = def.pattern;
    if (!patternText && jsonKeys.size === 0)
      throw new Error(
        `DLP rule ${JSON.stringify(name)} needs pattern or json_keys`,
      );
    if (patternText != null && typeof patternText !== "string") {
      throw new Error(
        `DLP rule ${JSON.stringify(name)} pattern must be a string`,
      );
    }

    const validator = def.validator || "";
    if (!VALIDATORS.has(validator))
      throw new Error(
        `DLP rule ${JSON.stringify(name)} uses unknown validator ${JSON.stringify(validator)}`,
      );

    const action = def.action || "";
    if (action && !ACTIONS.has(action))
      throw new Error(
        `DLP rule ${JSON.stringify(name)} uses unknown action ${JSON.stringify(action)}`,
      );

    const placeholder = def.placeholder || "";
    if (
      placeholder &&
      (typeof placeholder !== "string" || !placeholder.includes("{rule}"))
    ) {
      throw new Error(
        `DLP rule ${JSON.stringify(name)} placeholder must contain {rule}`,
      );
    }

    const minEntropy = Number(def.min_entropy ?? 0);
    const maxMatches = Number(def.max_matches ?? 100);
    const secretGroup = Number(def.secret_group ?? 0);
    const enabled = def.enabled ?? true;
    // deny：候选文本命中任一即跳过。用来压掉「代码里讨论凭据」的误报——
    // 命中的是标识符（`updateData.accessToken`）而非秘密值。编译期校验，
    // 写错的正则在加载时抛出，不会静默失去防护。
    const deny = stringList(def.deny, "deny", name).map((item, index) => {
      try {
        return new RegExp(item, "d");
      } catch (e) {
        throw new Error(
          `DLP rule ${JSON.stringify(name)} deny[${index}] is not a valid regex: ${e.message}`,
        );
      }
    });
    if (typeof enabled !== "boolean")
      throw new Error(
        `DLP rule ${JSON.stringify(name)} enabled must be boolean`,
      );
    if (!(minEntropy >= 0) || !(maxMatches > 0) || !(secretGroup >= 0)) {
      throw new Error(`DLP rule ${JSON.stringify(name)} has invalid limits`);
    }

    // d 标志用于取 secret_group 的偏移；带 g 的正则一律用 matchAll 迭代，
    // 不共享 lastIndex（模块级正则的 lastIndex 会在并发请求间互相污染——移植时的头号坑）。
    const pattern = patternText ? new RegExp(patternText, flags + "d") : null;
    if (pattern && secretGroup > countGroups(patternText)) {
      throw new Error(
        `DLP rule ${JSON.stringify(name)} secret_group does not exist`,
      );
    }

    rules.set(name, {
      name,
      pattern,
      validator,
      keywords: stringList(def.keywords, "keywords", name).map((k) =>
        k.toLowerCase(),
      ),
      minEntropy,
      action,
      placeholder,
      allowlist: stringList(def.allowlist, "allowlist", name).map((k) =>
        k.toLowerCase(),
      ),
      deny,
      maxMatches,
      secretGroup,
      enabled,
      jsonKeys,
    });
  }

  if (raw.version === 1) {
    const legacyKeys = stringList(
      raw.sensitive_json_keys,
      "sensitive_json_keys",
    );
    if (legacyKeys.length) {
      rules.set("structured_secret", {
        name: "structured_secret",
        pattern: null,
        validator: "",
        keywords: [],
        minEntropy: 0,
        action: "",
        placeholder: "",
        allowlist: [],
        deny: [],
        maxMatches: 100,
        secretGroup: 0,
        enabled: true,
        jsonKeys: new Set(legacyKeys.map((k) => k.toLowerCase())),
      });
    }
  }

  return { version: raw.version, rules, defaultAction, defaultPlaceholder };
}

/** 统计正则中的捕获组数量（用于 secret_group 越界校验） */
function countGroups(patternText) {
  try {
    return new RegExp(`${patternText}|`).exec("").length - 1;
  } catch {
    return 0;
  }
}

let cachedPolicy = null;
let cachedPolicyKey = "";
/** 按 路径+mtime 缓存规则，规则文件改动无需重启即可生效（每次请求一次 stat） */
function getPolicy(ruleFile) {
  let key = ruleFile;
  try {
    key = `${ruleFile}:${fs.statSync(ruleFile).mtimeMs}`;
  } catch {
    /* 文件不存在等情形交给 loadPolicy 抛错 */
  }
  if (cachedPolicy && cachedPolicyKey === key) return cachedPolicy;
  const policy = loadPolicy(ruleFile);
  cachedPolicy = policy;
  cachedPolicyKey = key;
  return policy;
}

/** 校验规则文件（`npx` 形式的 CLI 与测试用） */
export function validatePolicy(ruleFile = DEFAULT_RULE_FILE) {
  const policy = loadPolicy(ruleFile);
  let enabled = 0;
  for (const rule of policy.rules.values()) if (rule.enabled) enabled++;
  return { version: policy.version, rules: policy.rules.size, enabled };
}

// ---------------------------------------------------------------------------
// 嵌套编码解码（防绕过）
// ---------------------------------------------------------------------------

function decodedText(raw) {
  let value;
  try {
    value = utf8Strict.decode(raw);
  } catch {
    return null; // 非 UTF-8
  }
  if (!value || CONTROL_CHARS.test(value)) return null;
  return value;
}

/** 严格 base64/base64url 解码；不合法返回 null（对齐 Python validate=True 语义） */
function decodeBase64(candidate) {
  if (candidate.length % 4 === 1) return null;
  const padded = candidate + "=".repeat((4 - (candidate.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  return Buffer.from(normalized, "base64");
}

/** percent 解码为字节（对齐 Python urllib.parse.unquote_to_bytes：非 %XX 部分按 UTF-8 编码保留） */
function decodePercent(candidate) {
  const bytes = [];
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === "%" && i + 2 < candidate.length) {
      const hex = candidate.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    for (const b of Buffer.from(candidate[i], "utf8")) bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * 产出 (start, end, decoded) 三元组。预算耗尽时置 budget.exhausted 并停止——
 * 调用方在 redact/block 模式下据此返回 413，避免攻击者用伪候选挤掉真实秘密。
 */
function* decodeCandidates(value, budget) {
  for (const [kind, pattern] of [
    ["hex", HEX_CANDIDATE],
    ["percent", PERCENT_CANDIDATE],
    ["base64", BASE64_CANDIDATE],
  ]) {
    // 关键：带 g 的正则用 matchAll 迭代（每次调用新建迭代器，不共享 lastIndex）
    for (const match of value.matchAll(pattern)) {
      const candidate = match[0];
      if (kind === "percent" && !candidate.includes("%")) continue;

      if (budget.bytes <= 0) {
        budget.exhausted = true;
        return;
      }
      // 超大候选直接跳过且不消耗预算：否则攻击者前置一个巨大编码块
      // 就能压制其后真实秘密的扫描。
      if (candidate.length > budget.bytes * 3 + 8) continue;

      let raw;
      try {
        if (kind === "base64") {
          // hex 形状的串交给 hex 分支处理，避免重复（对齐 _HEX_CANDIDATE.fullmatch）
          if (/^(?:[0-9A-Fa-f]{2}){16,}$/.test(candidate)) continue;
          raw = decodeBase64(candidate);
        } else if (kind === "hex") {
          raw = Buffer.from(candidate, "hex");
        } else {
          raw = decodePercent(candidate);
        }
      } catch {
        continue;
      }
      if (!raw || raw.length === 0) continue;
      if (raw.length > budget.bytes) {
        budget.exhausted = true;
        return;
      }
      budget.bytes -= raw.length;

      const decoded = decodedText(raw);
      if (decoded == null || decoded === candidate) continue;
      if (budget.candidates <= 0) {
        budget.exhausted = true;
        return;
      }
      budget.candidates -= 1;
      yield [match.index, match.index + candidate.length, decoded];
    }
  }
}

// ---------------------------------------------------------------------------
// 检测
// ---------------------------------------------------------------------------

function ruleAction(rule, mode, policy) {
  return rule.action || (ACTIONS.has(mode) ? mode : policy.defaultAction);
}

/**
 * 写回一个键，保留 own 的 "__proto__" 键。
 *
 * 客户端可发送 own 的 "__proto__"（JSON.parse 把它建成 own 属性，Object.entries
 * 能枚举到），而 `obj[key] = v` 走的是 [[Set]] —— 命中 Object.prototype 上的
 * __proto__ setter：字段静默消失，值反而挂到结果对象的原型上。
 * defineProperty 建的是 own 数据属性，与 spread（CreateDataProperty）一致。
 *
 * 只对这一个键走慢路径，其余键保持普通赋值。
 */
function defineKey(target, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

function candidateAllowed(candidate, rule) {
  const lowered = candidate.toLowerCase();
  return rule.allowlist.some((item) => lowered.includes(item));
}

/** deny：候选（或被捕获的 secret_group）形如代码标识符/路径，而非凭据值 */
function candidateDenied(candidate, rule) {
  if (!rule.deny || !rule.deny.length) return false;
  return rule.deny.some((re) => {
    re.lastIndex = 0; // deny 正则无 g 标志，重置只为防御
    return re.test(candidate);
  });
}

function candidateValid(candidate, rule) {
  if (candidateAllowed(candidate, rule)) return false;
  if (candidateDenied(candidate, rule)) return false;
  if (rule.minEntropy > 0 && entropy(candidate) < rule.minEntropy) return false;
  if (rule.validator === "cn_id_checksum") return validIdCard(candidate);
  if (rule.validator === "luhn") return validBankCard(candidate);
  return true;
}

/** 已知密钥合并正则：长度降序（长匹配优先，避免前缀截断）、按长度下限过滤 */
export function buildKnownSecretPattern(knownSecrets, minLength = 8) {
  const secrets = [...new Set(knownSecrets)]
    .filter((s) => typeof s === "string" && s.length >= minLength)
    .sort((a, b) => b.length - a.length);
  if (!secrets.length) return null;
  return new RegExp(
    secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gd",
  );
}

function collectSpans(
  value,
  enabledRules,
  mode,
  policy,
  knownSecretPattern,
  decodeDepth,
  budget,
) {
  const spans = [];
  const matched = new Set();
  const blocked = new Set();
  const audited = new Set();
  const lowered = value.toLowerCase();

  for (const name of enabledRules) {
    const rule = policy.rules.get(name);
    if (!rule || !rule.enabled || !rule.pattern) continue;
    // keywords 预筛：缺席时零正则开销，这是性能的主要来源
    if (rule.keywords.length && !rule.keywords.some((k) => lowered.includes(k)))
      continue;

    let count = 0;
    for (const match of value.matchAll(rule.pattern)) {
      const candidate = match[rule.secretGroup] ?? match[0];
      if (!candidateValid(candidate, rule)) continue;
      const action = ruleAction(rule, mode, policy);
      const [start, end] = match.indices[rule.secretGroup] || [
        match.index,
        match.index + match[0].length,
      ];
      spans.push([start, end, name, action, rule]);
      matched.add(name);
      if (action === "block") blocked.add(name);
      if (action === "audit") audited.add(name);
      if (++count >= rule.maxMatches) break;
    }
  }

  // 已知密钥：精确匹配，零误报。日志只记规则名，不记值。
  const knownAction = ACTIONS.has(mode) ? mode : policy.defaultAction;
  const knownRule = { name: "known_secret", placeholder: "" };
  if (knownSecretPattern) {
    let count = 0;
    for (const match of value.matchAll(knownSecretPattern)) {
      spans.push([
        match.index,
        match.index + match[0].length,
        "known_secret",
        knownAction,
        knownRule,
      ]);
      matched.add("known_secret");
      if (knownAction === "block") blocked.add("known_secret");
      if (knownAction === "audit") audited.add("known_secret");
      if (++count >= 100) break;
    }
  }

  // 递归解码：编码后的秘密命中时，整个原始编码片段被处理
  if (decodeDepth > 0) {
    const encodedRule = { name: "encoded_secret", placeholder: "" };
    for (const [start, end, decoded] of decodeCandidates(value, budget)) {
      const nested = collectSpans(
        decoded,
        enabledRules,
        mode,
        policy,
        knownSecretPattern,
        decodeDepth - 1,
        budget,
      );
      if (!nested.spans.length) continue;
      const action = nested.spans.reduce(
        (best, span) =>
          ACTION_PRIORITY[span[3]] > ACTION_PRIORITY[best] ? span[3] : best,
        "audit",
      );
      spans.push([start, end, "encoded_secret", action, encodedRule]);
      for (const n of nested.matched) matched.add(n);
      matched.add("encoded_secret");
      for (const n of nested.blocked) blocked.add(n);
      for (const n of nested.audited) audited.add(n);
      if (action === "block") blocked.add("encoded_secret");
      if (action === "audit") audited.add("encoded_secret");
    }
  }

  return { spans, matched, blocked, audited };
}

/** span 选择（重叠时按 起点 → 动作优先级 → 长度 排序取先到者）并替换 */
function inspectText(
  value,
  enabledRules,
  mode,
  policy,
  knownSecretPattern,
  decodeDepth,
  budget,
) {
  const { spans, matched, blocked, audited } = collectSpans(
    value,
    enabledRules,
    mode,
    policy,
    knownSecretPattern,
    decodeDepth,
    budget,
  );
  if (!spans.length) return { value, matched, redactions: 0, blocked, audited };

  const selected = [];
  const occupied = [];
  const ordered = [...spans].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (ACTION_PRIORITY[a[3]] !== ACTION_PRIORITY[b[3]])
      return ACTION_PRIORITY[b[3]] - ACTION_PRIORITY[a[3]];
    return b[1] - b[0] - (a[1] - a[0]);
  });
  for (const span of ordered) {
    const [start, end] = span;
    if (occupied.some(([s, e]) => start < e && end > s)) continue;
    selected.push(span);
    occupied.push([start, end]);
  }

  const transforms = selected
    .filter((s) => s[3] === "redact")
    .sort((a, b) => a[0] - b[0]);
  if (!transforms.length)
    return { value, matched, redactions: 0, blocked, audited };

  const out = [];
  let position = 0;
  for (const [start, end, name, , rule] of transforms) {
    out.push(value.slice(position, start));
    const template = rule.placeholder || policy.defaultPlaceholder;
    out.push(template.replace("{rule}", name));
    position = end;
  }
  out.push(value.slice(position));
  return {
    value: out.join(""),
    matched,
    redactions: transforms.length,
    blocked,
    audited,
  };
}

/**
 * 按豁免标记切分文本：标记区间内不参与规则匹配，标记本身在转发前移除。
 * 未配对或嵌套（区间内再现起始标记）按普通正文处理——不报错、不中断链路。
 */
function processText(
  value,
  opts,
  enabledRules,
  mode,
  policy,
  knownSecretPattern,
  decodeDepth,
  budget,
) {
  const { exemptStart, exemptEnd, stripExemptMarkers, allowExemptions } = opts;
  const matched = new Set();
  const blocked = new Set();
  const audited = new Set();
  let exemptions = 0;
  let redactions = 0;

  const inspect = (segment) => {
    const r = inspectText(
      segment,
      enabledRules,
      mode,
      policy,
      knownSecretPattern,
      decodeDepth,
      budget,
    );
    for (const n of r.matched) matched.add(n);
    for (const n of r.blocked) blocked.add(n);
    for (const n of r.audited) audited.add(n);
    redactions += r.redactions;
    return r.value;
  };

  if (
    !allowExemptions ||
    !exemptStart ||
    !exemptEnd ||
    exemptStart === exemptEnd
  ) {
    return {
      value: inspect(value),
      matched,
      exemptions: 0,
      redactions,
      blocked,
      audited,
    };
  }

  const out = [];
  let position = 0;
  while (position < value.length) {
    const start = value.indexOf(exemptStart, position);
    if (start < 0) {
      out.push(inspect(value.slice(position)));
      break;
    }
    out.push(inspect(value.slice(position, start)));
    const end = value.indexOf(exemptEnd, start + exemptStart.length);
    if (end < 0) {
      out.push(inspect(value.slice(start)));
      break;
    }
    const content = value.slice(start + exemptStart.length, end);
    if (content.includes(exemptStart)) {
      // 嵌套：整段按普通正文处理
      out.push(inspect(value.slice(start, end + exemptEnd.length)));
      position = end + exemptEnd.length;
      continue;
    }
    exemptions += 1;
    out.push(stripExemptMarkers ? content : exemptStart + content + exemptEnd);
    position = end + exemptEnd.length;
  }
  return {
    value: out.join(""),
    matched,
    exemptions,
    redactions,
    blocked,
    audited,
  };
}

/** Responses/Chat 风格里承载用户与工具内容的字段名 */
const SENSITIVE_ITEM_TYPES = new Set([
  "function_call_output",
  "computer_call_output",
  "local_shell_call_output",
  "mcp_call_output",
]);

/**
 * 结构化遍历。只扫「用户可控且会被模型当作上下文处理」的内容：
 *   - messages[] 中 role 为 user/tool 的 content
 *   - Responses 风格 input[] 中的 *_output 项
 *   - 顶层 prompt / query
 *   - 识别不了结构时，递归扫描全部字符串（退化路径）
 * 刻意不扫：system/developer 指令、assistant 内容、JSON Schema、协议字段
 * （id / call_id / tool_call_id / type / status）——这些命中只会造成误伤。
 */
function inspectJson(
  value,
  opts,
  enabledRules,
  mode,
  policy,
  knownSecretPattern,
  decodeDepth,
  budget,
  acc,
) {
  const visit = (node) => {
    if (typeof node === "string") {
      // 统计实际扫描过的字符串字段数：用于区分「跑了但没命中」与「根本没跑」。
      // 这是排查「开了脱敏却没看到任何命中」时最关键的一项证据——没有它，两种情况
      // 在日志里长得一模一样。
      acc.scannedFields += 1;
      acc.scannedChars += node.length;
      const r = processText(
        node,
        opts,
        enabledRules,
        mode,
        policy,
        knownSecretPattern,
        decodeDepth,
        budget,
      );
      for (const n of r.matched) acc.matched.add(n);
      for (const n of r.blocked) acc.blocked.add(n);
      for (const n of r.audited) acc.audited.add(n);
      acc.exemptions += r.exemptions;
      acc.redactions += r.redactions;
      return r.value;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") {
      const out = {};
      const structured = policy.rules.get("structured_secret");
      for (const [key, item] of Object.entries(node)) {
        // 内联二进制（data URI 或长 base64）跳过扫描
        if (
          BINARY_KEYS.has(key.toLowerCase()) &&
          typeof item === "string" &&
          (item.startsWith("data:") ||
            (item.length > 4096 && BASE64_FULL.test(item)))
        ) {
          defineKey(out, key, item);
          continue;
        }
        let cleaned = visit(item);
        // json_keys 规则：按字段名判定（值仍需过熵阈值与 allowlist）
        if (
          structured &&
          enabledRules.includes("structured_secret") &&
          structured.enabled &&
          structured.jsonKeys.has(key.toLowerCase()) &&
          typeof item === "string" &&
          item &&
          candidateValid(item, structured)
        ) {
          const trimmed = item.trim();
          if (
            !(
              trimmed.startsWith(opts.exemptStart) &&
              trimmed.endsWith(opts.exemptEnd)
            )
          ) {
            const action = ruleAction(structured, mode, policy);
            acc.matched.add("structured_secret");
            if (action === "block") acc.blocked.add("structured_secret");
            else if (action === "audit") acc.audited.add("structured_secret");
            else if (!cleaned.includes("[REDACTED:")) {
              cleaned = (
                structured.placeholder || policy.defaultPlaceholder
              ).replace("{rule}", "structured_secret");
              acc.redactions += 1;
            }
          }
        }
        defineKey(out, key, cleaned);
      }
      return out;
    }
    return node;
  };

  const visitSensitiveItem = (item) => {
    const out = { ...item };
    let fields = [];
    if (item.role === "user" || item.role === "tool") fields = ["content"];
    else if (SENSITIVE_ITEM_TYPES.has(item.type))
      fields = ["output", "content"];
    for (const field of fields) {
      if (field in item) out[field] = visit(item[field]);
    }
    return out;
  };

  const visitSensitiveItems = (items) => {
    const indexes = items
      .map((item, i) =>
        item &&
        typeof item === "object" &&
        (item.role === "user" ||
          item.role === "tool" ||
          SENSITIVE_ITEM_TYPES.has(item.type))
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    if (!indexes.length)
      return items.map((item) =>
        typeof item === "string" ? visit(item) : item,
      );
    const out = [...items];
    for (const i of indexes) out[i] = visitSensitiveItem(items[i]);
    return out;
  };

  if (Array.isArray(value)) return value.map(visit);
  if (!value || typeof value !== "object") return visit(value);

  const cleaned = { ...value };
  let recognized = false;
  if (Array.isArray(value.messages)) {
    cleaned.messages = visitSensitiveItems(value.messages);
    recognized = true;
  }
  if ("input" in value) {
    cleaned.input = Array.isArray(value.input)
      ? visitSensitiveItems(value.input)
      : visit(value.input);
    recognized = true;
  }
  for (const key of ["prompt", "query"]) {
    if (typeof value[key] === "string") {
      cleaned[key] = visit(value[key]);
      recognized = true;
    }
  }
  return recognized ? cleaned : visit(value);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 检测并（按模式）改写请求体。
 *
 * @param {*} body 已解析的请求体对象（原样返回或返回改写后的副本，不原地修改）
 * @param {object} options
 *   - mode: "off" | "audit" | "redact" | "block"
 *   - rules: string[] 启用的规则名（默认取规则文件里 enabled 的全部）
 *   - ruleFile: 自定义规则文件路径
 *   - knownSecrets: string[] 本机已知凭据（精确匹配）
 *   - allowExemptions / exemptStart / exemptEnd / stripExemptMarkers
 *   - decodeDepth / decodeMaxCandidates / decodeMaxBytes
 * @returns {{body:*, matchedRules:string[], blockedRules:string[], auditedRules:string[],
 *            redactions:number, exemptions:number, scannedFields:number, scannedChars:number,
 *            limitExceeded:boolean, error:string|null}}
 *   永不抛出：任何内部异常都返回原文 + error 描述（fail-open，ADR 0005）。
 */
export function inspectRequestBody(body, options = {}) {
  const empty = {
    body,
    matchedRules: [],
    blockedRules: [],
    auditedRules: [],
    redactions: 0,
    exemptions: 0,
    scannedFields: 0,
    scannedChars: 0,
    limitExceeded: false,
    error: null,
  };
  const mode = options.mode || "off";
  if (mode === "off" || !ACTIONS.has(mode)) return empty;
  if (!body || typeof body !== "object") return empty;

  // 对齐参考实现（dlp.py:474）：开了豁免却没给可用的标记对 → **整请求不可检视**。
  // 静默零扫描是这个功能最坏的失败形态（面板显示已开启、每条请求却零扫描），
  // 故这里显式报错。调用方会把 error 打进日志（fail-open 的常规路径）。
  if (options.allowExemptions === true) {
    const start = options.exemptStart || "";
    const end = options.exemptEnd || "";
    if (!start || !end || start === end) {
      const msg =
        "allowExemptions=true requires distinct exemptStart/exemptEnd";
      console.warn(`[DLP] ${msg}, passing through uninspected`);
      return { ...empty, error: msg };
    }
  }

  try {
    const ruleFile = options.ruleFile || DEFAULT_RULE_FILE;
    const policy = getPolicy(ruleFile);
    const enabledRules = options.rules?.length
      ? options.rules.filter((name) => policy.rules.has(name))
      : [...policy.rules.keys()];

    const opts = {
      exemptStart: options.exemptStart || "[[ALLOW_SENSITIVE]]",
      exemptEnd: options.exemptEnd || "[[/ALLOW_SENSITIVE]]",
      stripExemptMarkers: options.stripExemptMarkers !== false,
      allowExemptions: options.allowExemptions === true,
    };

    const budget = {
      candidates: Math.max(0, options.decodeMaxCandidates ?? 100),
      bytes: Math.max(0, options.decodeMaxBytes ?? 1048576),
      exhausted: false,
    };
    const knownSecretPattern = buildKnownSecretPattern(
      options.knownSecrets || [],
      options.knownSecretMinLength ?? 8,
    );

    const acc = {
      matched: new Set(),
      blocked: new Set(),
      audited: new Set(),
      redactions: 0,
      exemptions: 0,
      scannedFields: 0,
      scannedChars: 0,
    };
    const decodeDepth = Math.max(0, options.decodeDepth ?? 2);
    const cleaned = inspectJson(
      body,
      opts,
      enabledRules,
      mode,
      policy,
      knownSecretPattern,
      decodeDepth,
      budget,
      acc,
    );

    return {
      body: cleaned,
      matchedRules: [...acc.matched].sort(),
      blockedRules: [...acc.blocked].sort(),
      auditedRules: [...acc.audited].sort(),
      redactions: acc.redactions,
      exemptions: acc.exemptions,
      scannedFields: acc.scannedFields,
      scannedChars: acc.scannedChars,
      limitExceeded: budget.exhausted,
      error: null,
    };
  } catch (err) {
    // fail-open：脱敏失败绝不能让用户的请求失败
    console.warn(`[DLP] inspect failed, passing through: ${err?.message}`);
    return { ...empty, error: err?.message || String(err) };
  }
}

export { DEFAULT_RULE_FILE, resolveDefaultRuleFile };
