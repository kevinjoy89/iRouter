// Verify 3-tier driver fallback: better-sqlite3 → node:sqlite → sql.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-chain-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Driver fallback chain", () => {
  it("default → picks better-sqlite3 when available", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(["better-sqlite3", "node:sqlite", "sql.js"]).toContain(db.driver);
  });

  it("falls back to node:sqlite when better-sqlite3 unavailable", async () => {
    // Mock the better-sqlite3 adapter to throw
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    // Node 22.5+ should give node:sqlite, else sql.js
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      expect(db.driver).toBe("node:sqlite");
    } else {
      expect(db.driver).toBe("sql.js");
    }
  });

  it("可选依赖缺失（MODULE_NOT_FOUND）静默降级，不刷告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 从适配器内部抛出（等价于真实场景：适配器顶层 import 原生模块失败），
    // vi.doMock 工厂抛错会被 vitest 自身的 mock 校验拦截，模拟不到这条分支
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => ({
      createBetterSqliteAdapter: () => {
        const err = new Error("Cannot find module 'better-sqlite3'");
        err.code = "MODULE_NOT_FOUND";
        throw err;
      },
    }));
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const noisy = warn.mock.calls.filter((c) => String(c[0]).includes("better-sqlite3"));
    expect(noisy).toEqual([]);
    expect(["node:sqlite", "sql.js"]).toContain(db.driver);
    warn.mockRestore();
  });

  // Node >= 24：上游 guard 在 import 适配器之前就 return null（better-sqlite3 原生插件
  // 在 Node >= 24 加载即 SIGSEGV，是 try/catch 兜不住的进程级崩溃），所以"装了但加载失败"
  // 的分支在此版本上不可达，此时断言不告警才是正确行为。
  const [maj] = process.versions.node.split(".").map(Number);
  const nativeSkipped = maj >= 24;

  it("装了但加载失败（ABI 不匹配等）仍然告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => ({
      createBetterSqliteAdapter: () => {
        const err = new Error("NODE_MODULE_VERSION 147. This version requires 149");
        err.code = "ERR_DLOPEN_FAILED";
        throw err;
      },
    }));
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();
    const warned = warn.mock.calls.some((c) => String(c[0]).includes("better-sqlite3"));
    // Node >= 24 上适配器根本不会被 import，告警分支不可达
    expect(warned).toBe(!nativeSkipped);
    warn.mockRestore();
  });

  it("Node >= 24 直接跳过 better-sqlite3（避免原生插件加载即 SIGSEGV）", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    if (nativeSkipped) {
      expect(["node:sqlite", "sql.js"]).toContain(db.driver);
    } else {
      expect(["better-sqlite3", "node:sqlite", "sql.js"]).toContain(db.driver);
    }
  });

  it("falls back to sql.js when both native drivers unavailable", async () => {
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.driver).toBe("sql.js");
  });
});
