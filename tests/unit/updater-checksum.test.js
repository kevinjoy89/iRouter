/**
 * 安装包校验和解析与比对单元测试
 * 验证 sha256sum 输出格式解析、BOM 兼容及哈希校验逻辑
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  parseChecksums,
  verifyFileSha256,
} from "../../desktop/updater/checksum.js";

describe("updater/checksum 单元测试", () => {
  describe("parseChecksums 解析", () => {
    it("正确解析标准 sha256sum 格式", () => {
      const content = `
5fa5f33ff6ae46e0ded79e66946941b0953d279f9b12d6ac7b633e857f358a37  iRouter-0.3.2-macos-arm64.dmg
9d3159c8a170fba74bb3d52ed7948df27f5bc29478e209aaed8c828e46490c17  iRouter-0.3.2-windows-amd64-installer.exe
`;
      const result = parseChecksums(content);
      expect(result["iRouter-0.3.2-macos-arm64.dmg"]).toBe(
        "5fa5f33ff6ae46e0ded79e66946941b0953d279f9b12d6ac7b633e857f358a37",
      );
      expect(result["iRouter-0.3.2-windows-amd64-installer.exe"]).toBe(
        "9d3159c8a170fba74bb3d52ed7948df27f5bc29478e209aaed8c828e46490c17",
      );
    });

    it("兼容剥除 UTF-8 BOM 字符与二进制星号前缀", () => {
      const content = "\ufeff" + "11223344  *iRouter-test.dmg\n";
      const result = parseChecksums(content);
      expect(result["iRouter-test.dmg"]).toBe("11223344");
    });

    it("空内容安全返回空对象", () => {
      expect(parseChecksums("")).toEqual({});
      expect(parseChecksums(null)).toEqual({});
    });
  });

  describe("verifyFileSha256 文件校验", () => {
    it("文件哈希一致返回 true，不一致返回 false", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "irouter-chk-test-"));
      const testFile = path.join(tmpDir, "test.bin");
      const content = "Hello iRouter Updater!";
      fs.writeFileSync(testFile, content);

      const expectedSha256 = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      const match = await verifyFileSha256(testFile, expectedSha256);
      expect(match).toBe(true);

      const mismatch = await verifyFileSha256(testFile, "0000000000000000000000000000000000000000000000000000000000000000");
      expect(mismatch).toBe(false);

      fs.unlinkSync(testFile);
      fs.rmdirSync(tmpDir);
    });
  });
});
