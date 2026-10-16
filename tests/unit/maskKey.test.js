import { describe, it, expect } from "vitest";
import { maskApiKey } from "@/shared/utils/maskKey.js";

/**
 * 敏感密钥脱敏工具测试套件
 *
 * @author iRouter
 * @since 2026-10-16
 */
describe("maskApiKey", () => {
  it("对标准长度 Key 正确保留前后 5 位并掩码中间字符", () => {
    const raw = "sk-ant-api03-abcdefghijklmnop12345";
    const masked = maskApiKey(raw);
    expect(masked.startsWith("sk-an")).toBe(true);
    expect(masked.endsWith("12345")).toBe(true);
    expect(masked.includes("****")).toBe(true);
  });

  it("对短于 10 位的密钥进行整体掩码保护", () => {
    expect(maskApiKey("short123")).toBe("******");
    expect(maskApiKey("123456789")).toBe("******");
  });

  it("对空值或无效入参返回空字符串", () => {
    expect(maskApiKey(null)).toBe("");
    expect(maskApiKey(undefined)).toBe("");
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey(12345)).toBe("");
  });
});
