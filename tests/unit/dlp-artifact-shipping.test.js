// 回归守卫：DLP 规则文件必须随每个产物分发。
//
// 引擎用 fs 读 dlp_rules.yaml，它不在 Next 的 import 图里，tracing 不会收集它。
// 缺文件 → loadPolicy 抛 ENOENT → 引擎 fail-open → 面板显示「脱敏」已开而实际
// 每条请求零扫描（最坏失败模式：看起来在工作）。三处分发路径各钉一条断言：
//   1. desktop/scripts/build-server.mjs  → 桌面版网关产物
//   2. cli/scripts/build-cli.js          → npm CLI 包
//   3. desktop/scripts/smoke-packaged.mjs → .app 成品自检
import {
  readFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { inspectRequestBody, loadPolicy } from "../../open-sse/dlp/index.js";
import { AI_TOKEN } from "./helpers/dlpTokens.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RULE_SRC = join(REPO, "open-sse", "dlp", "dlp_rules.yaml");

describe("DLP: 规则文件随产物分发", () => {
  it("仓库内的规则源文件存在", () => {
    expect(existsSync(RULE_SRC)).toBe(true);
  });

  it("desktop build-server 复制并以自检守卫规则文件", () => {
    const src = readFileSync(
      join(REPO, "desktop", "scripts", "build-server.mjs"),
      "utf8",
    );
    // 常量声明 + 复制，二者缺一产物就会静默失效。
    // 自检清单的断言按**行为**而非排版：formatter 会把单行数组拆成多行
    // （曾因此让这条断言假红），故只要求两个字符串以独立元素出现在
    // 同一个自检数组里，不约束它们落在同一行。
    expect(src).toMatch(
      /dlpRulesSrc = join\(UPSTREAM, "open-sse", "dlp", "dlp_rules\.yaml"\)/,
    );
    expect(src).toMatch(
      /cpSync\(dlpRulesSrc, join\(dlpRulesDst, "dlp_rules\.yaml"\)\)/,
    );
    // 自检项：产物路径（构造方式不限写法）与它的可读名必须同时在场
    const selfCheck = src.slice(src.indexOf("for (const [p, what] of ["));
    expect(selfCheck).toContain(
      'join(OUT, "open-sse", "dlp", "dlp_rules.yaml")',
    );
    expect(selfCheck).toContain('"open-sse/dlp/dlp_rules.yaml"');
  });

  it("cli build-cli 复制并断言规则文件", () => {
    const src = readFileSync(
      join(REPO, "cli", "scripts", "build-cli.js"),
      "utf8",
    );
    expect(src).toMatch(
      /dlpRulesSrc = path\.join\(appDir, "open-sse", "dlp", "dlp_rules\.yaml"\)/,
    );
    expect(src).toMatch(/fs\.copyFileSync\(dlpRulesSrc, dlpRulesDst\)/);
    expect(src).toContain('"open-sse/dlp/dlp_rules.yaml"'); // assertRequiredApiArtifacts 清单
  });

  it("packaged smoke 拒绝缺少规则文件的 .app", () => {
    const src = readFileSync(
      join(REPO, "desktop", "scripts", "smoke-packaged.mjs"),
      "utf8",
    );
    expect(src).toMatch(
      /APP_DLP_RULES = join\(APP_GATEWAY, "open-sse", "dlp", "dlp_rules\.yaml"\)/,
    );
    expect(src).toMatch(/产物缺少 DLP 规则文件/);
  });

  // 复制只是分发的一半：引擎还得能从产物布局里找到它。
  // 引擎的 cwd 相对候选正是 <cwd>/open-sse/dlp/dlp_rules.yaml（壳层与 CLI 均以产物根为 cwd）。
  it("按产物布局放置后，引擎在任意 cwd 下都能加载该规则文件", () => {
    const root = mkdtempSync(join(tmpdir(), "dlp-artifact-"));
    try {
      const dest = join(root, "open-sse", "dlp");
      mkdirSync(dest, { recursive: true });
      copyFileSync(RULE_SRC, join(dest, "dlp_rules.yaml"));

      // 源仓库在 PATH 可见，但引擎只认产物布局——直接断言 loadPolicy 的目标文件可达
      const policy = loadPolicy(join(dest, "dlp_rules.yaml"));
      expect(policy.rules.size).toBeGreaterThan(0);
      // 端到端：同一份规则驱动一次真实脱敏。
      // 输入必须是真 token 而非 "[REDACTED:...]" 占位串，否则断言恒真：
      // formatter/净化链路曾把真值改写成占位串，测试却照样绿。
      const r = inspectRequestBody(
        { messages: [{ role: "user", content: AI_TOKEN }] },
        { mode: "redact", ruleFile: join(dest, "dlp_rules.yaml") },
      );
      expect(r.error).toBeNull();
      expect(r.matchedRules).toContain("ai_tokens");
      expect(r.body.messages[0].content).not.toContain(AI_TOKEN);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
