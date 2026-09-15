// 请求脱敏引擎测试。
//
// 移植自参考实现 llm-retry-proxy 的 tests/test_dlp_api.py。原测试大量针对
// Python 代理层（gzip 解压、Content-Length 限制、分块读上限、fail_closed），
// 这些按 design.md 的 Non-Goals 不在本版范围内；此处覆盖其**引擎语义**部分，
// 并补齐规则加载、fail-open 与并发不串味。
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectRequestBody,
  validatePolicy,
  loadPolicy,
  buildKnownSecretPattern,
  entropy,
  validIdCard,
  validBankCard,
  DEFAULT_RULE_FILE,
  resolveDefaultRuleFile,
} from "../../open-sse/dlp/index.js";
import { AI_TOKEN, AI_TOKEN_B64 } from "./helpers/dlpTokens.js";

// 输入与它的改写结果分开表示，否则断言退化为同义反复（既看不出改写是否发生，
// 也发现不了「根本没扫」）。曾用同一字面量表示二者。
// 见 tests/unit/helpers/dlpTokens.js（用 base64 构造，避开链路对 sk- 字面量的净化）。
const TOKEN = AI_TOKEN; // 输入：真实形状，过 min_entropy 与 keywords
const REDACTED = "[REDACTED:ai_tokens]"; // 输出：引擎写回的占位符

// 只启用 ai_tokens，与参考测试的 dlp_rules={"ai_tokens"} 对齐
const BASE = { rules: ["ai_tokens"] };

describe("DLP: 规则加载与校验", () => {
  it("内置规则文件可加载，15 条规则、11 条启用（4 条默认关：PII 三条 + 银行卡）", () => {
    expect(validatePolicy()).toEqual({ version: 2, rules: 15, enabled: 11 });
  });

  it("导出的默认规则文件路径存在", () => {
    expect(validatePolicy(DEFAULT_RULE_FILE).rules).toBe(15);
  });

  it("规则缺失 pattern 与 json_keys 时抛错", () => {
    expect(() => loadPolicy("/nonexistent/rules.yaml")).toThrow();
  });

  it("structured_secret 由 json_keys 定义，无需 pattern", () => {
    const policy = loadPolicy();
    const rule = policy.rules.get("structured_secret");
    expect(rule.pattern).toBeNull();
    expect(rule.jsonKeys.has("password")).toBe(true);
  });
});

// 打包回归：Next 会把引擎打进 .next/server/chunks/*.js，届时 import.meta.url 被冻结为
// **构建机**的绝对路径。若只用它定位规则文件，用户机器上 loadPolicy 会抛错 → 引擎
// fail-open → UI 显示已开启但从不脱敏（最坏的失败模式）。以下用例钉住探测优先级。
describe("DLP: 规则文件定位（打包回归）", () => {
  it("优先使用 DLP_RULE_FILE 环境变量", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-rules-"));
    const custom = join(dir, "custom.yaml");
    writeFileSync(custom, "version: 2\nrules:\n  x:\n    pattern: 'z'\n");
    expect(
      resolveDefaultRuleFile({ envFile: custom, cwd: dir, moduleDir: dir }),
    ).toBe(custom);
  });

  it("环境变量未设时回退到 cwd 相对路径（打包产物布局）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-cwd-"));
    const nested = join(dir, "open-sse", "dlp");
    mkdirSync(nested, { recursive: true });
    const expected = join(nested, "dlp_rules.yaml");
    writeFileSync(expected, "version: 2\nrules:\n  x:\n    pattern: 'z'\n");

    // 模拟打包后：moduleDir 指向不存在的构建机路径，cwd 才是产物目录
    const resolved = resolveDefaultRuleFile({
      envFile: undefined,
      cwd: dir,
      moduleDir: "/nonexistent/build-machine/open-sse/dlp",
    });
    expect(resolved).toBe(expected);
    expect(validatePolicy(resolved)).toEqual({
      version: 2,
      rules: 1,
      enabled: 1,
    });
  });

  it("构建机路径不存在且 cwd 无规则时，回退到模块相对路径", () => {
    const moduleDir = mkdtempSync(join(tmpdir(), "dlp-mod-"));
    const expected = join(moduleDir, "dlp_rules.yaml");
    writeFileSync(expected, "version: 2\nrules:\n  x:\n    pattern: 'z'\n");

    const resolved = resolveDefaultRuleFile({
      envFile: undefined,
      cwd: "/nonexistent/consumer/cwd",
      moduleDir,
    });
    expect(resolved).toBe(expected);
  });

  it("全部候选都不存在时返回路径而非抛错（交给 fail-open 记录 error）", () => {
    const resolved = resolveDefaultRuleFile({
      envFile: undefined,
      cwd: "/nonexistent/a",
      moduleDir: "/nonexistent/b",
    });
    expect(typeof resolved).toBe("string");
    expect(resolved).toContain("dlp_rules.yaml");
  });

  it("cwd 相对路径优先于模块相对路径（产物内 yaml 随包同层）", () => {
    const cwdDir = mkdtempSync(join(tmpdir(), "dlp-pri-cwd-"));
    const modDir = mkdtempSync(join(tmpdir(), "dlp-pri-mod-"));
    const cwdNested = join(cwdDir, "open-sse", "dlp");
    mkdirSync(cwdNested, { recursive: true });
    writeFileSync(
      join(cwdNested, "dlp_rules.yaml"),
      "version: 2\nrules:\n  a:\n    pattern: 'z'\n",
    );
    writeFileSync(
      join(modDir, "dlp_rules.yaml"),
      "version: 2\nrules:\n  b:\n    pattern: 'z'\n",
    );

    const resolved = resolveDefaultRuleFile({
      envFile: undefined,
      cwd: cwdDir,
      moduleDir: modDir,
    });
    expect(resolved).toBe(join(cwdNested, "dlp_rules.yaml"));
    expect(loadPolicy(resolved).rules.has("a")).toBe(true);
  });
});

describe("DLP: 检测与替换", () => {
  it("明文 AI token 被 redact，其余内容保留", () => {
    const body = {
      messages: [{ role: "user", content: `here is ${TOKEN} ok` }],
    };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });

    expect(r.matchedRules).toContain("ai_tokens");
    expect(r.body.messages[0].content).toBe(`here is ${REDACTED} ok`);
    expect(r.redactions).toBe(1);
    expect(r.error).toBeNull();
  });

  it("block 模式报告 blockedRules，但仍返回改写结果（由调用方决定拦截）", () => {
    const body = { messages: [{ role: "user", content: TOKEN }] };
    const r = inspectRequestBody(body, { mode: "block", ...BASE });

    expect(r.blockedRules).toContain("ai_tokens");
    expect(r.matchedRules).toContain("ai_tokens");
  });

  it("audit 模式只报告命中，不改写内容", () => {
    const body = { messages: [{ role: "user", content: `x ${TOKEN} y` }] };
    const r = inspectRequestBody(body, { mode: "audit", ...BASE });

    expect(r.auditedRules).toContain("ai_tokens");
    expect(r.redactions).toBe(0);
    expect(r.body.messages[0].content).toBe(`x ${TOKEN} y`);
  });

  it("低熵示例值被 allowlist 与熵阈值挡住，不误报", () => {
    const body = {
      messages: [{ role: "user", content: "sk-your_key_here_example" }],
    };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });

    expect(r.matchedRules).toEqual([]);
    expect(r.redactions).toBe(0);
  });

  it("不含关键词时不进入正则（keywords 预筛）", () => {
    const body = {
      messages: [{ role: "user", content: "nothing sensitive here at all" }],
    };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.matchedRules).toEqual([]);
  });

  it("mode=off 时直接原样返回", () => {
    const body = { messages: [{ role: "user", content: TOKEN }] };
    const r = inspectRequestBody(body, { mode: "off", ...BASE });
    expect(r.body).toBe(body);
    expect(r.matchedRules).toEqual([]);
  });

  it("不原地修改调用方对象", () => {
    const body = { messages: [{ role: "user", content: TOKEN }] };
    inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(body.messages[0].content).toBe(TOKEN);
  });
});

describe("DLP: 结构感知（防误伤）", () => {
  it("扫描 user 与 tool 消息，跳过 system 与 assistant", () => {
    const body = {
      messages: [
        { role: "system", content: `sys ${TOKEN}` },
        { role: "user", content: `usr ${TOKEN}` },
        { role: "assistant", content: `asst ${TOKEN}` },
        { role: "tool", content: `tool ${TOKEN}` },
      ],
    };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });

    expect(r.body.messages[0].content).toBe(`sys ${TOKEN}`); // system 不扫
    expect(r.body.messages[1].content).toBe(`usr ${REDACTED}`);
    expect(r.body.messages[2].content).toBe(`asst ${TOKEN}`); // assistant 不扫
    expect(r.body.messages[3].content).toBe(`tool ${REDACTED}`);
  });

  it("Responses 风格：扫描 *_call_output 的 output 字段", () => {
    const body = {
      input: [{ type: "local_shell_call_output", output: TOKEN }],
    };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.body.input[0].output).toBe(REDACTED);
  });

  it("扫描顶层 prompt 与 query", () => {
    const r1 = inspectRequestBody(
      { prompt: TOKEN },
      { mode: "redact", ...BASE },
    );
    expect(r1.body.prompt).toBe(REDACTED);
    const r2 = inspectRequestBody(
      { query: TOKEN },
      { mode: "redact", ...BASE },
    );
    expect(r2.body.query).toBe(REDACTED);
  });

  it("无法识别结构时退化为递归扫描全部字符串", () => {
    const body = { weird: { nested: [TOKEN] } };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.body.weird.nested[0]).toBe(REDACTED);
  });

  it("内联二进制（data URI / 长 base64 字段）跳过扫描", () => {
    const body = { image: `data:image/png;base64,${"A".repeat(8000)}` };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.body.image).toBe(body.image);
    expect(r.matchedRules).toEqual([]);
  });

  it("json_keys 规则按字段名命中（structured_secret）", () => {
    // 注意：结构识别的短路语义（对齐参考实现）——顶层若有 messages/input/prompt/query，
    // 只遍历这些字段；其它顶层字段不进入扫描。故此处用未被识别的形状走递归兜底。
    const body = { config: { password: "hunter2xyz" } };
    const r = inspectRequestBody(body, {
      mode: "redact",
      rules: ["structured_secret"],
    });
    expect(r.matchedRules).toContain("structured_secret");
    expect(r.body.config.password).toBe("[REDACTED:structured_secret]");
  });

  it("json_keys 命中但值被 allowlist 放过时不改写", () => {
    const body = { config: { password: "changeme" } };
    const r = inspectRequestBody(body, {
      mode: "redact",
      rules: ["structured_secret"],
    });
    expect(r.body.config.password).toBe("changeme");
    expect(r.matchedRules).toEqual([]);
  });
});

describe("DLP: 嵌套编码（防绕过）", () => {
  it("base64 编码的 AI token 被识别为 encoded_secret（block 模式不改写）", () => {
    // 参考实现语义：只有 action=redact 的 span 才参与替换，block 只上报规则名。
    // 故此处断言命中与拦截，而非改写结果。
    const encoded = AI_TOKEN_B64;
    const body = {
      input: [{ type: "local_shell_call_output", output: encoded }],
    };
    const r = inspectRequestBody(body, { mode: "block", ...BASE });

    expect(r.matchedRules).toContain("encoded_secret");
    expect(r.blockedRules).toContain("encoded_secret");
    expect(r.body.input[0].output).toBe(encoded);
  });

  it("base64 编码的 AI token 在 redact 模式下整段替换", () => {
    const encoded = AI_TOKEN_B64;
    const body = {
      input: [{ type: "local_shell_call_output", output: encoded }],
    };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });

    expect(r.matchedRules).toContain("encoded_secret");
    expect(r.body.input[0].output).toBe("[REDACTED:encoded_secret]");
  });

  it("两层 base64 仍可识别", () => {
    const once = Buffer.from(TOKEN).toString("base64");
    const twice = Buffer.from(once).toString("base64");
    const body = { input: twice };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.matchedRules).toContain("encoded_secret");
  });

  it("hex 编码的 token 被识别", () => {
    const hex = Buffer.from(TOKEN).toString("hex");
    const body = { input: hex };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.matchedRules).toContain("encoded_secret");
  });

  it("percent 编码的 token 被识别", () => {
    const pct = [...Buffer.from(TOKEN)]
      .map((b) => `%${b.toString(16).padStart(2, "0")}`)
      .join("");
    const body = { input: pct };
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.matchedRules).toContain("encoded_secret");
  });

  it("解码预算耗尽时置 limitExceeded（对应参考实现的 413 语义）", () => {
    const a = Buffer.from("A".repeat(18)).toString("base64");
    const b = Buffer.from("B".repeat(18)).toString("base64");
    const body = { input: `${a} ${b}` };
    const r = inspectRequestBody(body, {
      mode: "redact",
      ...BASE,
      decodeMaxCandidates: 1,
    });

    expect(r.limitExceeded).toBe(true);
  });

  it("decodeDepth=0 时不递归解码", () => {
    const encoded = AI_TOKEN_B64;
    const r = inspectRequestBody(
      { input: encoded },
      { mode: "redact", ...BASE, decodeDepth: 0 },
    );
    expect(r.matchedRules).toEqual([]);
  });
});

describe("DLP: 已知密钥（精确匹配）", () => {
  it("编码后的号池密钥被识别为 known_secret 并整段替换（redact）", () => {
    const secret = "vendor-private-value-987654321";
    const encoded = Buffer.from(secret).toString("base64");
    const body = { input: encoded };
    const r = inspectRequestBody(body, {
      mode: "redact",
      ...BASE,
      knownSecrets: [secret],
    });

    expect(r.matchedRules).toContain("known_secret");
    expect(r.body.input).toBe("[REDACTED:encoded_secret]");
  });

  it("block 模式下编码的号池密钥上报 known_secret，但不改写", () => {
    const secret = "vendor-private-value-987654321";
    const encoded = Buffer.from(secret).toString("base64");
    const r = inspectRequestBody(
      { input: encoded },
      { mode: "block", ...BASE, knownSecrets: [secret] },
    );

    expect(r.blockedRules).toContain("known_secret");
    expect(r.body.input).toBe(encoded);
  });

  it("明文已知密钥直接命中", () => {
    const secret = "vendor-private-value-987654321";
    const r = inspectRequestBody(
      { input: `key=${secret}` },
      { mode: "redact", knownSecrets: [secret] },
    );
    expect(r.matchedRules).toContain("known_secret");
    expect(r.body.input).toBe("key=[REDACTED:known_secret]");
  });

  it("短于长度下限的凭据不参与匹配", () => {
    // 下限为 8（含），故 7 字符不参与、8 字符参与
    expect(buildKnownSecretPattern(["abc1234"])).toBeNull();
    const r = inspectRequestBody(
      { input: "abc1234" },
      { mode: "redact", knownSecrets: ["abc1234"] },
    );
    expect(r.matchedRules).toEqual([]);

    const r8 = inspectRequestBody(
      { input: "abc12345" },
      { mode: "redact", knownSecrets: ["abc12345"] },
    );
    expect(r8.matchedRules).toContain("known_secret");
  });

  it("长密钥优先，避免被短密钥前缀截断", () => {
    const short = "secret-value-aaa";
    const long = "secret-value-aaa-extended-tail";
    const pattern = buildKnownSecretPattern([short, long]);
    const m = [...`x ${long} y`.matchAll(pattern)];
    expect(m).toHaveLength(1);
    expect(m[0][0]).toBe(long);
  });

  it("正则元字符被转义，不会误匹配", () => {
    const pattern = buildKnownSecretPattern(["a.b*cxyz"]);
    expect(pattern).not.toBeNull();
    expect(pattern.test("aXbYcxyz")).toBe(false);
    expect(pattern.test("zz a.b*cxyz zz")).toBe(true);
  });

  it("空列表返回 null", () => {
    expect(buildKnownSecretPattern([])).toBeNull();
    expect(buildKnownSecretPattern([""])).toBeNull();
  });
});

describe("DLP: 豁免标记", () => {
  // 引擎不内置标记值（参考实现里来自 DLP_EXEMPT_START/END 环境变量），由调用方注入。
  // 标记用码点构造：源码/中间层改写方括号时会静默改变实际标记。
  const B = String.fromCharCode(91, 91),
    E = String.fromCharCode(93, 93);
  const START = `${B}ALLOW_SENSITIVE${E}`,
    END = `${B}/ALLOW_SENSITIVE${E}`;
  const EXEMPT = { exemptStart: START, exemptEnd: END };
  const body = { input: START + TOKEN + END };

  it("默认关闭豁免：标记区间照常检测", () => {
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.redactions).toBe(1);
  });

  // 对齐参考实现 dlp.py:474：开了豁免却没给可用标记对 → 整请求不可检视。
  // 静默零扫描是这个功能最坏的失败形态（面板显示已开启、每条请求却零扫描），
  // 故必须报 uninspectable 而非返回「干净」。
  it("开了豁免但未传标记对：报 uninspectable，不静默零扫描", () => {
    const r = inspectRequestBody(
      { input: TOKEN },
      { mode: "redact", ...BASE, allowExemptions: true },
    );
    expect(r.error).toBeTruthy();
    expect(r.error).toMatch(/exemptStart/);
    expect(r.scannedFields).toBe(0);
    expect(r.redactions).toBe(0);
  });

  it("启用后区间内跳过检测，且标记被剥除", () => {
    const r = inspectRequestBody(body, {
      mode: "redact",
      ...BASE,
      allowExemptions: true,
      ...EXEMPT,
    });
    expect(r.body.input).toBe(TOKEN);
    expect(r.exemptions).toBe(1);
    expect(r.redactions).toBe(0);
    expect(r.error).toBeNull();
  });

  it("stripExemptMarkers=false 时保留标记", () => {
    const r = inspectRequestBody(body, {
      mode: "redact",
      ...BASE,
      allowExemptions: true,
      stripExemptMarkers: false,
      ...EXEMPT,
    });
    expect(r.body.input).toBe(START + TOKEN + END);
  });

  it("未配对的标记按普通正文处理，不报错", () => {
    const r = inspectRequestBody(
      { input: START + TOKEN },
      { mode: "redact", ...BASE, allowExemptions: true, ...EXEMPT },
    );
    expect(r.redactions).toBe(1); // 未配对 → 不产生豁免
    expect(r.exemptions).toBe(0);
  });

  it("嵌套标记按普通正文处理，不产生豁免", () => {
    const nested = { input: `${START}a${START}${TOKEN}${END}` };
    const r = inspectRequestBody(nested, {
      mode: "redact",
      ...BASE,
      allowExemptions: true,
      ...EXEMPT,
    });
    expect(r.exemptions).toBe(0);
    expect(r.redactions).toBe(1);
  });
});

describe("DLP: 键保真（own __proto__ 与原型安全）", () => {
  // JSON.parse('{"__proto__":{...}}') 产出的是 **own** 属性，Object.entries 能枚举到。
  // 但 `out[key] = v` 走 [[Set]]，命中 Object.prototype 的 __proto__ setter：
  // 该字段静默消失，值反而挂到结果对象的原型上。引擎必须用 defineProperty 建 own 属性。
  const RAW = '{"safe":"ok","__proto__":{"polluted":"yes"},"nested":{"a":1}}';

  it("own 的 __proto__ 键被保留，且值不逃到原型上", () => {
    const body = JSON.parse(RAW);
    const r = inspectRequestBody(body, { mode: "audit" });

    expect(Object.hasOwn(r.body, "__proto__")).toBe(true);
    expect(Object.keys(r.body)).toEqual(["safe", "__proto__", "nested"]);
    expect(JSON.stringify(r.body)).toBe(RAW); // 往返无损
    expect(Object.getPrototypeOf(r.body)).toBe(Object.prototype); // 未被替换
    expect({}.polluted).toBeUndefined(); // 无全局污染
  });

  it("深层对象里的 own __proto__ 同样保留", () => {
    const raw = '{"weird":{"__proto__":{"z":1},"k":2}}';
    const r = inspectRequestBody(JSON.parse(raw), { mode: "audit" });
    expect(JSON.stringify(r.body)).toBe(raw);
  });

  it("消息对象上的 own __proto__ 不丢失", () => {
    const raw =
      '{"messages":[{"role":"user","content":"hi","__proto__":{"x":1}}]}';
    const r = inspectRequestBody(JSON.parse(raw), { mode: "audit" });
    expect(JSON.stringify(r.body)).toBe(raw);
  });
});

describe("DLP: fail-open", () => {
  it("规则文件不存在时返回原文 + error，不抛出", () => {
    const body = { messages: [{ role: "user", content: TOKEN }] };
    const r = inspectRequestBody(body, {
      mode: "redact",
      ruleFile: "/nonexistent/nope.yaml",
    });

    expect(r.error).toBeTruthy();
    expect(r.body).toBe(body);
    expect(r.matchedRules).toEqual([]);
  });

  it("未知 mode 视为关闭", () => {
    const body = { input: TOKEN };
    expect(inspectRequestBody(body, { mode: "bogus" }).body).toBe(body);
  });

  it("非对象 body 原样返回", () => {
    expect(inspectRequestBody(null, { mode: "redact" }).body).toBeNull();
    expect(inspectRequestBody("str", { mode: "redact" }).body).toBe("str");
  });

  it("循环引用不导致抛出（fail-open 兜底）", () => {
    // 结构识别的短路语义：{input:string} 属已识别形状，self 字段根本不遍历。
    // 要触发递归兜底的栈溢出，需用未被识别的形状。
    const body = { weird: {} };
    body.weird.self = body;
    const r = inspectRequestBody(body, { mode: "redact", ...BASE });
    expect(r.error).toBeTruthy();
    expect(r.body).toBe(body);
  });
});

describe("DLP: 并发不串味（正则 lastIndex）", () => {
  it("同一规则对象被多次/交错调用时结果稳定", () => {
    const bodies = Array.from({ length: 20 }, (_, i) => ({
      messages: [{ role: "user", content: `case ${i} ${TOKEN} tail` }],
    }));
    const results = bodies.map((b) =>
      inspectRequestBody(b, { mode: "redact", ...BASE }),
    );
    for (const r of results) {
      expect(r.redactions).toBe(1);
      expect(r.body.messages[0].content).toContain(REDACTED);
    }
  });

  it("高频交替命中与未命中不丢匹配", () => {
    for (let i = 0; i < 50; i++) {
      const hit = inspectRequestBody(
        { input: TOKEN },
        { mode: "redact", ...BASE },
      );
      expect(hit.redactions).toBe(1);
      const miss = inspectRequestBody(
        { input: "plain text nothing here" },
        { mode: "redact", ...BASE },
      );
      expect(miss.redactions).toBe(0);
    }
  });
});

describe("DLP: 校验器与熵", () => {
  it("身份证校验位：合法号通过，改动任一位后不通过", () => {
    const valid = "11010519491231002X";
    expect(validIdCard(valid)).toBe(true);
    expect(validIdCard("110105194912310021")).toBe(false);
  });

  it("Luhn：合法卡号通过，连号不通过", () => {
    expect(validBankCard("4111111111111111")).toBe(true);
    expect(validBankCard("1111111111111111")).toBe(false);
    expect(validBankCard("1234")).toBe(false);
  });

  it("熵：低熵串低于阈值，高熵串高于阈值", () => {
    expect(entropy("aaaaaaaaaaaaaaaa")).toBe(0);
    expect(entropy("A1b2C3d4E5f6G7h8")).toBeGreaterThan(3.5);
  });

  it("身份证规则只放行校验位合法的串", () => {
    const good = inspectRequestBody(
      { input: "11010519491231002X" },
      { mode: "redact", rules: ["id_card"] },
    );
    expect(good.matchedRules).toContain("id_card");

    const bad = inspectRequestBody(
      { input: "110105194912310021" },
      { mode: "redact", rules: ["id_card"] },
    );
    expect(bad.matchedRules).toEqual([]);
  });

  it("银行卡规则只放行 Luhn 合法的串（默认关，显式启用仍需过校验器）", () => {
    // bank_card 默认 enabled: false（误报率，见 dlp_rules.yaml 注释），
    // 但 luhn 校验器语义必须独立成立——用内联规则文件强制启用后验证。
    const dir = mkdtempSync(join(tmpdir(), "dlp-bankcard-"));
    const file = join(dir, "rules.yaml");
    writeFileSync(
      file,
      [
        "version: 2",
        "rules:",
        "  bank_card:",
        "    pattern: '(?<!\\d)(?:\\d[ -]?){12,18}\\d(?!\\d)'",
        "    validator: luhn",
      ].join("\n") + "\n",
    );
    const good = inspectRequestBody(
      { input: "4242" + "424242424242" },
      { mode: "redact", ruleFile: file },
    );
    expect(good.matchedRules).toContain("bank_card");
    const bad = inspectRequestBody(
      { input: "4111111111111112" },
      { mode: "redact", ruleFile: file },
    );
    expect(bad.matchedRules).toEqual([]);
  });

  it("私钥块被识别", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const r = inspectRequestBody(
      { input: pem },
      { mode: "redact", rules: ["private_key"] },
    );
    expect(r.matchedRules).toContain("private_key");
    expect(r.body.input).toBe("[REDACTED:private_key]");
  });

  it("连接串中的密码被识别", () => {
    const r = inspectRequestBody(
      { input: "postgres://user:s3cretpw@db.internal:5432/app" },
      { mode: "redact", rules: ["connection_string"] },
    );
    expect(r.matchedRules).toContain("connection_string");
  });

  it("JWT 被识别", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const r = inspectRequestBody(
      { input: jwt },
      { mode: "redact", rules: ["jwt"] },
    );
    expect(r.matchedRules).toContain("jwt");
  });
});

// 真机反馈：开了 redact 之后工具输出里的**代码**被切碎到无法阅读。
// 实测 debug 场景——想确认某个标识符在文件里的位置，读回来却是占位符，
// 于是整轮对着不存在的字符串推理。命中的是赋值语句，值是标识符而非凭据。
// 故给规则加 deny，拒绝「值形如代码标识符」。见 CONTEXT.md「代码语境误报」。
describe("DLP: deny（代码语境误报压制）", () => {
  const IDENT = "newCredentials";

  it("赋值为驼峰标识符时跳过", () => {
    const input = `accessToken = ${IDENT}`;
    const r = inspectRequestBody(
      { input },
      { mode: "redact", rules: ["credentials"] },
    );
    expect(r.matchedRules).toEqual([]);
    expect(r.body.input).toBe(input);
  });

  it("赋值为点分路径时跳过", () => {
    const input = `updateData.accessToken = ${IDENT}.accessToken`;
    const r = inspectRequestBody(
      { input },
      { mode: "redact", rules: ["credentials"] },
    );
    expect(r.matchedRules).toEqual([]);
    expect(r.body.input).toBe(input);
  });

  it("赋值为真密钥时仍然改写（deny 不得放走秘密）", () => {
    const input = `accessToken = "${"ghp_" + "AbCdEf0123456789xyz0"}"`;
    const r = inspectRequestBody(
      { input },
      { mode: "redact", rules: ["credentials"] },
    );
    expect(r.matchedRules).toContain("credentials");
    expect(r.body.input).not.toContain("AbCdEf0123456789xyz0");
  });

  it("deny 是无效正则时在加载期抛出，不静默失去防护", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-deny-bad-"));
    const bad = join(dir, "bad.yaml");
    writeFileSync(
      bad,
      `version: 2\nrules:\n  x:\n    pattern: ${"\u0027"}z${"\u0027"}\n    deny:\n      - ${"\u0027"}[unclosed${"\u0027"}\n`,
    );
    expect(() => loadPolicy(bad)).toThrow(/deny\[0\] is not a valid regex/);
  });

  it("内置规则集：bank_card 默认关，credentials 与 structured_secret 带 deny", () => {
    const policy = loadPolicy();
    expect(policy.rules.get("bank_card").enabled).toBe(false);
    expect(policy.rules.get("credentials").deny.length).toBe(2);
    expect(policy.rules.get("structured_secret").deny.length).toBe(2);
  });

  it("内置规则集：长数字串不再被 bank_card 改写", () => {
    const input = "4242" + "424242424242";
    const r = inspectRequestBody({ input }, { mode: "redact" });
    expect(r.matchedRules).not.toContain("bank_card");
    expect(r.body.input).toBe(input);
  });
});
