/**
 * 发布产物匹配模块单元测试
 * 验证各平台架构与安装形态的文件名匹配与回退机制
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

import { describe, it, expect } from "vitest";
import {
  getExpectedAssetName,
  selectAsset,
} from "../../tools/asset.js";

describe("updater/asset 单元测试", () => {
  describe("getExpectedAssetName 文件名生成", () => {
    it("正确生成 macOS arm64 与 amd64 产物文件名", () => {
      expect(getExpectedAssetName("0.3.2", "darwin", "arm64")).toBe("iRouter-0.3.2-macos-arm64.dmg");
      expect(getExpectedAssetName("v0.3.2", "darwin", "x64")).toBe("iRouter-0.3.2-macos-amd64.dmg");
    });

    it("正确生成 Windows 安装器与便携版文件名", () => {
      expect(getExpectedAssetName("0.3.2", "win32", "x64", "installer")).toBe(
        "iRouter-0.3.2-windows-amd64-installer.exe",
      );
      expect(getExpectedAssetName("0.3.2", "win32", "x64", "portable")).toBe(
        "iRouter-0.3.2-windows-amd64-portable.zip",
      );
    });

    it("正确生成 Linux deb 与 tarball 文件名", () => {
      expect(getExpectedAssetName("0.3.2", "linux", "x64", "deb")).toBe(
        "iRouter-0.3.2-linux-amd64.deb",
      );
      expect(getExpectedAssetName("0.3.2", "linux", "x64", "tarball")).toBe(
        "iRouter-0.3.2-linux-amd64.tar.gz",
      );
    });
  });

  describe("selectAsset 产物选择匹配", () => {
    const mockAssets = [
      { name: "iRouter-0.3.2-macos-arm64.dmg", browser_download_url: "https://example.com/mac-arm.dmg", size: 100 },
      { name: "iRouter-0.3.2-macos-amd64.dmg", browser_download_url: "https://example.com/mac-x64.dmg", size: 100 },
      { name: "iRouter-0.3.2-windows-amd64-installer.exe", browser_download_url: "https://example.com/win-setup.exe", size: 100 },
      { name: "iRouter-0.3.2-windows-amd64-portable.zip", browser_download_url: "https://example.com/win-port.zip", size: 100 },
      { name: "iRouter-0.3.2-linux-amd64.deb", browser_download_url: "https://example.com/linux.deb", size: 100 },
      { name: "iRouter-0.3.2-linux-amd64.tar.gz", browser_download_url: "https://example.com/linux.tar.gz", size: 100 },
      { name: "checksums.txt", browser_download_url: "https://example.com/checksums.txt", size: 600 },
    ];

    it("在真实 asset 列表中精准匹配对应产物", () => {
      const mac = selectAsset(mockAssets, "0.3.2", "darwin", "arm64");
      expect(mac).not.toBeNull();
      expect(mac.name).toBe("iRouter-0.3.2-macos-arm64.dmg");

      const winInstaller = selectAsset(mockAssets, "0.3.2", "win32", "x64", "installer");
      expect(winInstaller.name).toBe("iRouter-0.3.2-windows-amd64-installer.exe");

      const winPortable = selectAsset(mockAssets, "0.3.2", "win32", "x64", "portable");
      expect(winPortable.name).toBe("iRouter-0.3.2-windows-amd64-portable.zip");
    });

    it("找不到匹配产物时安全返回 null", () => {
      const notFound = selectAsset(mockAssets, "0.3.2", "unknown", "x64");
      expect(notFound).toBeNull();
    });
  });
});
