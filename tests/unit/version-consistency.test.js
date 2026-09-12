// 版本号一致性守卫（ADR 0004）。
//
// 产品可见版本号的真源是 desktop/package.json，构建期由 build-server.mjs 经
// NEXT_PUBLIC_APP_VERSION 注入 src/shared/constants/config.js。但 config.js 还带一个
// 硬编码回退值，用于未经 build-server 的裸构建（CLI 形态、根目录直跑）。
//
// 那个回退值是 ADR 0004 明确接受的代价：**每次发版必须手改**。手改的事就会漏改，
// 漏改的后果是面板显示旧版本号——而 desktop/main.js 的冒烟断言只比对打包形态
// （注入值来自 app.getVersion()），裸构建/CLI 形态没有任何东西盯着。
// 本文件把这条耦合钉成可执行断言：发版只改 package.json 而忘了 config.js，CI 红。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(relPath) {
  return JSON.parse(readFileSync(join(REPO, relPath), "utf8"));
}

/** 从 config.js 源码里取 NEXT_PUBLIC_APP_VERSION 的回退字面量 */
function readConfigFallbackVersion() {
  const src = readFileSync(
    join(REPO, "src", "shared", "constants", "config.js"),
    "utf8",
  );
  const m = src.match(
    /version:\s*process\.env\.NEXT_PUBLIC_APP_VERSION\s*\|\|\s*"([^"]+)"/,
  );
  expect(
    m,
    'config.js 的版本行必须形如 process.env.NEXT_PUBLIC_APP_VERSION || "x.y.z"',
  ).toBeTruthy();
  return m[1];
}

describe("版本号一致性（ADR 0004）", () => {
  const productVersion = readJson("desktop/package.json").version;

  it("config.js 的回退值等于 desktop/package.json 的产品号", () => {
    // 漏改这里 = 裸构建/CLI 形态面板显示旧版本，且没有任何现有检查会失败
    expect(readConfigFallbackVersion()).toBe(productVersion);
  });

  it("desktop/package-lock.json 顶层版本与产品号一致", () => {
    const lock = readJson("desktop/package-lock.json");
    expect(lock.version).toBe(productVersion);
    expect(lock.packages?.[""]?.version).toBe(productVersion);
  });

  it("产品号与上游基线号保持解耦（不是同一个号）", () => {
    // ADR 0004：根/CLI 保持上游基线号（UA / X-Msh-Version 需与上游对齐），
    // desktop 是产品号。二者若相等，说明有人「顺手统一」了——回退该决策需要
    // 同时改三处并重新打包验证，不能靠改一个字符串完成。
    const baseline = readJson("package.json").version;
    expect(productVersion).not.toBe(baseline);
  });
});
