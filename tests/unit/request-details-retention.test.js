// 请求详情保留策略 + 落盘上限钳制 + 单动作空间回收（刻意不提供「清空全部」）。
// 背景：打包版实例的 data.sqlite 曾增长到 10.31GB（8982 条详情、平均 1MB/条），
// 根因是「单字段上限被放大 + 没有任何保留策略 + 删除后空间从不归还」，
// 见 docs/packaged-runtime-footprint.zh-CN.md。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const DAY_MS = 86400000;
const AUTO_VACUUM_INCREMENTAL = 2; // SQLite: 0=NONE / 1=FULL / 2=INCREMENTAL

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-retention-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete globalThis.__requestDetailsRetentionTimer;
  // 派发守卫是进程级 global，跨用例会互相影响，必须一并清掉
  delete globalThis.__requestDetailsMaintenanceSpawnedAt;
  delete globalThis.__requestDetailsMaintenanceChild;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete globalThis.__requestDetailsRetentionTimer;
  delete globalThis.__requestDetailsMaintenanceSpawnedAt;
  delete globalThis.__requestDetailsMaintenanceChild;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

/**
 * 建库并按给定时间戳插入请求详情
 *
 * @param {number[]} agesInDays 每条记录距今天数
 * @return {Promise<object>} 数据库适配器
 * @author wei
 * @since 2026-09-29
 */
async function seedRequestDetails(agesInDays) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  for (const age of agesInDays) {
    const ts = new Date(Date.now() - age * DAY_MS).toISOString();
    db.run(
      "INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)",
      [`${ts}-${age}`, ts, "openai", "gpt-test", null, "200", JSON.stringify({ marker: age })]
    );
  }
  return db;
}

/**
 * 灌入一批大载荷记录（用于验证「删除后空间真的还回去了」）
 *
 * @param {object} db 数据库适配器
 * @param {string} prefix id 前缀
 * @param {number} ageInDays 距今天数
 * @param {number} [count] 条数
 * @return {void}
 * @author wei
 * @since 2026-09-29
 */
function seedBigRows(db, prefix, ageInDays, count = 40) {
  const ts = new Date(Date.now() - ageInDays * DAY_MS).toISOString();
  for (let i = 0; i < count; i++) {
    db.run(
      "INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)",
      [`${prefix}-${i}`, ts, "openai", "gpt-test", null, "200", "x".repeat(50000)]
    );
  }
}

/**
 * 读取 auto_vacuum 数值
 *
 * @param {object} db 数据库适配器
 * @return {number} 0=NONE / 1=FULL / 2=INCREMENTAL
 * @author wei
 * @since 2026-09-29
 */
function autoVacuumMode(db) {
  return Number(Object.values(db.get("PRAGMA auto_vacuum"))[0]);
}

describe("requestDetails 保留策略与上限钳制", () => {
  it("clampJsonSize 把超大设置钳到 256KB 硬顶，非法值回落 5KB", async () => {
    const { clampJsonSize } = await import("@/lib/db/repos/requestDetailsRepo.js");

    // 线上实例里的 2048（2MB/字段）必须被钳住，否则单行最坏 8MB
    expect(clampJsonSize(2048)).toBe(256 * 1024);
    expect(clampJsonSize(5)).toBe(5 * 1024);
    expect(clampJsonSize(undefined)).toBe(5 * 1024);
    expect(clampJsonSize(0)).toBe(5 * 1024);
    expect(clampJsonSize("not-a-number")).toBe(5 * 1024);
    expect(clampJsonSize(64)).toBe(64 * 1024);
  });

  it("pruneRequestDetails 只删除超期记录", async () => {
    await seedRequestDetails([10, 3, 0]);
    const { pruneRequestDetails } = await import("@/lib/db/repos/requestDetailsRepo.js");

    const result = await pruneRequestDetails({ days: 7 });

    expect(result.deleted).toBe(1);
    expect(result.remaining).toBe(2);
    expect(result.days).toBe(7);
  });

  it("保留天数 0 表示不限制，不删除任何记录", async () => {
    await seedRequestDetails([30, 0]);
    const { pruneRequestDetails, getRequestDetailsStorage } = await import("@/lib/db/repos/requestDetailsRepo.js");

    const result = await pruneRequestDetails({ days: 0 });

    expect(result.deleted).toBe(0);
    expect((await getRequestDetailsStorage()).rows).toBe(2);
  });

  it("getRequestDetailsStorage 返回行数、时间范围与库文件大小", async () => {
    const db = await seedRequestDetails([5, 1]);
    db.checkpoint?.();
    const { getRequestDetailsStorage } = await import("@/lib/db/repos/requestDetailsRepo.js");

    const storage = await getRequestDetailsStorage();

    expect(storage.rows).toBe(2);
    expect(storage.oldest).toBeTruthy();
    expect(storage.newest).toBeTruthy();
    expect(storage.oldest < storage.newest).toBe(true);
    expect(storage.dbBytes).toBeGreaterThan(0);
    // settingsRepo 默认值：保留 7 天、单字段 5KB
    expect(storage.retentionDays).toBe(7);
    expect(storage.maxJsonSizeKb).toBe(5);
  });

  it("裁剪分批执行并在批间让出事件循环（这是「清理时网关不能用」的修复）", async () => {
    const db = await seedRequestDetails([]);
    const oldTs = new Date(Date.now() - 10 * DAY_MS).toISOString();
    for (let i = 0; i < 120; i++) {
      db.run(
        "INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)",
        [`batch-${i}`, oldTs, "openai", "gpt-test", null, "200", "x".repeat(2000)]
      );
    }
    const { pruneRequestDetails } = await import("@/lib/db/repos/requestDetailsRepo.js");

    // 同步驱动下如果一次性 DELETE 完，事件循环在整段时间里一次都不转。
    // 用 setImmediate 泵计数（与让出用的是同一队列，FIFO 交替，不会被毫秒级批处理跳过）
    let turns = 0;
    let stop = false;
    const pump = () => { turns += 1; if (!stop) setImmediate(pump); };
    setImmediate(pump);
    let progressCalls = 0;
    let result;
    try {
      result = await pruneRequestDetails({ days: 7, onProgress: () => { progressCalls += 1; } });
    } finally {
      stop = true;
    }

    expect(result.deleted).toBe(120);
    expect(progressCalls).toBeGreaterThanOrEqual(3); // 120 条按 50 一批 → 至少 3 批
    expect(turns).toBeGreaterThan(0);                // 批间确实让出了事件循环
  });

  it("后台维护：调用立即返回，清理跑在独立子进程里（网关不参与）", async () => {
    const db = await seedRequestDetails([10, 1]);
    seedBigRows(db, "expired", 10, 20);
    db.checkpoint?.();

    const { startRequestDetailsMaintenance, getMaintenanceState } = await import("@/lib/db/repos/requestDetailsRepo.js");
    const started = startRequestDetailsMaintenance({ days: 7 });

    // 关键：不等待任何清理动作就返回；进程内不做 SQL，只派发子进程
    expect(started.started).toBe(true);
    expect(started.alreadyRunning).toBe(false);

    // 轮询状态文件直到子进程完成
    let state = getMaintenanceState();
    for (let i = 0; i < 600 && !(state.finishedAt && !state.running); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      state = getMaintenanceState();
    }

    expect(state.running).toBe(false);
    expect(state.error).toBeNull();
    expect(state.deleted).toBe(21);
    expect(state.finishedAt).toBeTruthy();
    expect(state.reclaimed).toBeGreaterThan(0);
  });

  it("子进程写完状态文件前的空窗期也不会重复派发", async () => {
    const db = await seedRequestDetails([10]);
    seedBigRows(db, "expired", 10, 5);
    db.checkpoint?.();

    const { startRequestDetailsMaintenance, getMaintenanceState } = await import("@/lib/db/repos/requestDetailsRepo.js");
    const first = startRequestDetailsMaintenance({ days: 7 });
    const second = startRequestDetailsMaintenance({ days: 7 });

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.alreadyRunning).toBe(true);

    let state = getMaintenanceState();
    for (let i = 0; i < 600 && !(state.finishedAt && !state.running); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      state = getMaintenanceState();
    }
  });

  it("老库（auto_vacuum=NONE）运行期不做整库重写，只标记需要离线压缩", async () => {
    const db = await seedRequestDetails([10, 1]);
    db.exec("PRAGMA auto_vacuum=NONE");
    db.exec("VACUUM");
    expect(autoVacuumMode(db)).toBe(0);
    seedBigRows(db, "old-big", 10, 10);
    db.checkpoint?.();

    const { startRequestDetailsMaintenance, getMaintenanceState } = await import("@/lib/db/repos/requestDetailsRepo.js");
    startRequestDetailsMaintenance({ days: 7 });

    let state = getMaintenanceState();
    for (let i = 0; i < 900 && !(state.finishedAt && !state.running); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      state = getMaintenanceState();
    }

    expect(state.running).toBe(false);
    expect(state.error).toBeNull();
    expect(state.deleted).toBe(11);
    // VACUUM 要独占整个库，运行期做会让网关所有写操作报 "database is locked"，
    // 因此只标记，等应用退出后再压缩
    expect(state.needsOfflineCompaction).toBe(true);

    const { DatabaseSync } = await import("node:sqlite");
    const fresh = new DatabaseSync(path.join(tempDir, "db", "data.sqlite"));
    const mode = Number(Object.values(fresh.prepare("PRAGMA auto_vacuum").get())[0]);
    fresh.close();
    expect(mode).toBe(0); // 未在运行期被改写
  });

  it("后台维护输出完整的开始/完成日志（只有「已派发」一行时看不到结果）", async () => {
    const db = await seedRequestDetails([10, 1]);
    seedBigRows(db, "expired", 10, 20);
    db.checkpoint?.();

    const logs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args) => { logs.push(args.join(" ")); };
    console.warn = (...args) => { logs.push(args.join(" ")); };

    try {
      const { startRequestDetailsMaintenance, getMaintenanceState } = await import("@/lib/db/repos/requestDetailsRepo.js");
      startRequestDetailsMaintenance({ days: 7 });
      for (let i = 0; i < 600 && !getMaintenanceState().finishedAt; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // 等子进程 exit 回调里的收尾日志
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }

    const started = logs.find((l) => l.includes("后台维护开始"));
    expect(started).toBeTruthy();
    expect(started).toContain("保留 7 天");

    const done = logs.find((l) => l.includes("后台维护完成"));
    expect(done).toBeTruthy();
    expect(done).toContain("删除 21 条");
    expect(done).toMatch(/用时 \d+\.\d+s/);
    // 成功路径不应出现失败/异常日志
    expect(logs.some((l) => l.includes("后台维护失败"))).toBe(false);
    expect(logs.some((l) => l.includes("后台维护异常结束"))).toBe(false);
  });

  it("startRequestDetailsRetention 只挂一次定时器（HMR 幂等）", async () => {
    const { startRequestDetailsRetention } = await import("@/lib/db/repos/requestDetailsRepo.js");

    startRequestDetailsRetention();
    const first = globalThis.__requestDetailsRetentionTimer;
    startRequestDetailsRetention();

    expect(first).toBeTruthy();
    expect(globalThis.__requestDetailsRetentionTimer).toBe(first);
  });

  it("端到端：设置被写成 2048（2MB/字段）时，单行落盘仍被钳在 256KB 以内", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    // 复刻线上实例的病态配置：observability 打开 + 单字段 2MB
    await updateSettings({ enableObservability: true, observabilityMaxJsonSize: 2048 });

    const { saveRequestDetail, flushRequestDetailsSync, getRequestDetailsStorage, __test__ } =
      await import("@/lib/db/repos/requestDetailsRepo.js");

    const huge = { messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }] };
    __test__.clearBuffer();
    await saveRequestDetail({ model: "gpt-test", provider: "openai", status: 200, request: huge, providerResponse: huge });
    flushRequestDetailsSync(db);

    const row = db.get("SELECT LENGTH(data) AS len FROM requestDetails ORDER BY timestamp DESC LIMIT 1");
    // 4 个字段 × 256KB 上限 + 元数据；远小于修复前的最坏 8MB
    expect(row.len).toBeLessThan(300 * 1024);

    const storage = await getRequestDetailsStorage();
    expect(storage.maxJsonSizeKb).toBe(256);
  });
});
