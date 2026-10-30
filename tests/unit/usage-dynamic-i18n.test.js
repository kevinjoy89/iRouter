// 用量/配额模块动态消息的翻译守卫。
//
// 背景：配额跟踪器里显示的错误消息由 open-sse/services/usage/* 生成，形如
//   "Codex usage API error (503)"
//   "Codex error: socket hang up"
//   "CodeBuddy (codebuddy-cn) credential not available."
// 它们带状态码或上游错误原文，**无法靠字典精确匹配**——每次插值都不同。
// 缺了动态模式时，中文界面会在配额卡片里直接显示英文（问题见
// openspec/changes/upstream-sync-v0.5.112/i18n-audit.md 第 2 类缺口）。
//
// 本文件只测 translateDynamicPatterns 本身（不经过字典），确保：
//   1. 每类模板都能被识别并译成中文；
//   2. zh-TW 输出繁体字形；
//   3. 英文环境原样返回；
//   4. 不误伤非消息文本（如纯品牌名、URL）。
import { describe, it, expect } from "vitest";
import { translateDynamicPatterns } from "../../src/i18n/runtime.js";

// 直接测动态模式：这些句子都不在字典里，必须靠模式命中
const DYNAMIC_CASES = [
  ["Codex usage API error (503).", "503"],
  ["OpenCode Go usage API error (403).", "403"],
  ["MiniMax usage endpoint error (500)", "500"],
  ["Codex error: socket hang up", "socket hang up"],
  ["CodeBuddy (codebuddy-cn) credential not available.", "凭据不可用"],
  ["Qoder connected. Usage fetch returned 429.", "429"],
  ["Claude connected. Unable to fetch usage: timeout", "timeout"],
  ["Codex connected. Usage API temporarily unavailable (503).", "503"],
  ["Session (5h)", "5"],
  ["Limit (10)", "10"],
  ["API Error 401: unauthorized", "401"],
];

describe("用量模块动态消息翻译模式", () => {
  for (const [input, expectContain] of DYNAMIC_CASES) {
    it(`zh-CN: ${input}`, () => {
      const out = translateDynamicPatterns(input, "zh-CN");
      expect(out, `未命中任何动态模式，原样返回：${out}`).not.toBe(input);
      expect(out).toContain(expectContain);
      // 结果里必须含汉字（确实翻译了，而不是只改标点）
      expect(/[\u4e00-\u9fff]/.test(out), `译文无汉字：${out}`).toBe(true);
    });
  }

  it("zh-TW 使用繁体字形", () => {
    const out = translateDynamicPatterns("Codex error: timeout", "zh-TW");
    expect(out).not.toBe("Codex error: timeout");
    expect(out).toContain("錯誤"); // 繁体，非「错误」
  });

  it("英文环境不做任何转换", () => {
    for (const [input] of DYNAMIC_CASES) {
      expect(translateDynamicPatterns(input, "en")).toBe(input);
    }
  });

  it("不误伤普通文本", () => {
    const untouched = [
      "OpenCode Go",
      "https://example.com/usage",
      "a3ca2f9b",
    ];
    for (const s of untouched) {
      expect(translateDynamicPatterns(s, "zh-CN")).toBe(s);
    }
  });
});
