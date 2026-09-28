/**
 * 版本号解析与比较工具单元测试
 * 验证语义化版本解析、主次修订号比较与新版本判定逻辑
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

import { describe, it, expect } from "vitest";
import {
  parseVersion,
  compareVersions,
  hasNewVersion,
} from "../../desktop/updater/version.js";

describe("updater/version 单元测试", () => {
  describe("parseVersion 解析逻辑", () => {
    it("正确解析标准数字版本号", () => {
      expect(parseVersion("0.3.2")).toEqual({ major: 0, minor: 3, patch: 2 });
      expect(parseVersion("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    });

    it("正确剥离前导 v 字符", () => {
      expect(parseVersion("v0.3.2")).toEqual({ major: 0, minor: 3, patch: 2 });
      expect(parseVersion("V1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it("兼容带后缀与元数据的版本字符串", () => {
      expect(parseVersion("0.3.2-beta.1")).toEqual({ major: 0, minor: 3, patch: 2 });
      expect(parseVersion("v0.3.2+20260929")).toEqual({ major: 0, minor: 3, patch: 2 });
    });

    it("对非法版本输入返回 null", () => {
      expect(parseVersion("")).toBeNull();
      expect(parseVersion(null)).toBeNull();
      expect(parseVersion("invalid")).toBeNull();
      expect(parseVersion("dev")).toBeNull();
    });
  });

  describe("compareVersions 比较逻辑", () => {
    it("正确识别高于、低于与相等版本", () => {
      expect(compareVersions("0.3.2", "0.3.1")).toBe(1);
      expect(compareVersions("0.3.1", "0.3.2")).toBe(-1);
      expect(compareVersions("0.3.2", "0.3.2")).toBe(0);
      expect(compareVersions("v0.3.2", "0.3.2")).toBe(0);
    });

    it("跨主版本和次版本比较", () => {
      expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
      expect(compareVersions("0.4.0", "0.3.9")).toBe(1);
      expect(compareVersions("0.3.0", "0.3.1")).toBe(-1);
    });

    it("非法版本容错返回 0", () => {
      expect(compareVersions("dev", "0.3.2")).toBe(0);
      expect(compareVersions("0.3.2", null)).toBe(0);
    });
  });

  describe("hasNewVersion 新版本判定", () => {
    it("存在更高版本时返回 true", () => {
      expect(hasNewVersion("0.3.1", "0.3.2")).toBe(true);
      expect(hasNewVersion("0.3.1", "v0.3.2")).toBe(true);
      expect(hasNewVersion("0.3.1", "1.0.0")).toBe(true);
    });

    it("相同或更低版本返回 false", () => {
      expect(hasNewVersion("0.3.2", "0.3.2")).toBe(false);
      expect(hasNewVersion("0.3.2", "0.3.1")).toBe(false);
      expect(hasNewVersion("1.0.0", "0.9.9")).toBe(false);
    });

    it("本地开发版 dev 不判定存在更新", () => {
      expect(hasNewVersion("dev", "0.3.2")).toBe(false);
      expect(hasNewVersion("local", "0.3.2")).toBe(false);
    });
  });
});
