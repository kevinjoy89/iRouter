/**
 * 版本检查与 Releases 查询单元测试
 * 通过 Mock 请求完全隔离外部网络，验证过滤、版本比对、限流缓存与忽略版本逻辑
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

import { describe, it, expect } from "vitest";
import { checkForUpdates } from "../../desktop/updater/checker.js";

describe("updater/checker 单元测试", () => {
  const mockReleases = [
    {
      tag_name: "v0.3.3-pre",
      name: "Pre Release",
      prerelease: true,
      draft: false,
      assets: [],
    },
    {
      tag_name: "v0.3.2",
      name: "v0.3.2 Release",
      prerelease: false,
      draft: false,
      html_url: "https://github.com/kevinjoy89/iRouter/releases/tag/v0.3.2",
      body: "Release Notes for 0.3.2",
      assets: [
        {
          name: "iRouter-0.3.2-macos-arm64.dmg",
          browser_download_url: "https://example.com/iRouter-0.3.2-macos-arm64.dmg",
          size: 157000000,
        },
        {
          name: "checksums.txt",
          browser_download_url: "https://example.com/checksums.txt",
          size: 602,
        },
      ],
    },
    {
      tag_name: "v0.3.1",
      name: "v0.3.1 Release",
      prerelease: false,
      draft: false,
      assets: [],
    },
  ];

  const mockFetch = async () => mockReleases;

  it("当本地版本落后于远端最新正式版时，提示有可用更新并匹配资产", async () => {
    const res = await checkForUpdates({
      currentVersion: "0.3.1",
      platform: "darwin",
      arch: "arm64",
      force: true,
      fetchFn: mockFetch,
    });

    expect(res.updateAvailable).toBe(true);
    expect(res.latest).toBe("0.3.2");
    expect(res.assetName).toBe("iRouter-0.3.2-macos-arm64.dmg");
    expect(res.downloadURL).toBe("https://example.com/iRouter-0.3.2-macos-arm64.dmg");
    expect(res.checksumsURL).toBe("https://example.com/checksums.txt");
  });

  it("当本地版本已是最新或更高时，返回 updateAvailable 为 false", async () => {
    const res = await checkForUpdates({
      currentVersion: "0.3.2",
      platform: "darwin",
      arch: "arm64",
      force: true,
      fetchFn: mockFetch,
    });

    expect(res.updateAvailable).toBe(false);
    expect(res.latest).toBe("0.3.2");
  });

  it("在缓存有效期内且非强制检查时，命中缓存直接返回", async () => {
    const cachedResult = {
      current: "0.3.1",
      latest: "0.3.2",
      updateAvailable: true,
    };
    const settings = {
      lastCheckAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 分钟前
      lastCheckResult: cachedResult,
    };

    let fetchCalled = false;
    const fetchSpy = async () => {
      fetchCalled = true;
      return mockReleases;
    };

    const res = await checkForUpdates({
      currentVersion: "0.3.1",
      platform: "darwin",
      arch: "arm64",
      force: false,
      settings,
      fetchFn: fetchSpy,
    });

    expect(fetchCalled).toBe(false);
    expect(res.cached).toBe(true);
    expect(res.latest).toBe("0.3.2");
  });

  it("用户已忽略当前最新版本时，自动检查不提示更新，强制检查仍提示", async () => {
    const settings = {
      ignoredVersion: "0.3.2",
    };

    // 自动检查（force: false）
    const autoRes = await checkForUpdates({
      currentVersion: "0.3.1",
      platform: "darwin",
      arch: "arm64",
      force: false,
      settings,
      fetchFn: mockFetch,
    });
    expect(autoRes.updateAvailable).toBe(false);

    // 手动强制检查（force: true）
    const manualRes = await checkForUpdates({
      currentVersion: "0.3.1",
      platform: "darwin",
      arch: "arm64",
      force: true,
      settings,
      fetchFn: mockFetch,
    });
    expect(manualRes.updateAvailable).toBe(true);
  });
});
