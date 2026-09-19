import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  flushRequestDetailsSync,
  __test__,
} from "@/lib/db/repos/requestDetailsRepo.js";
import {
  executeDbShutdownHooks,
} from "@/lib/db/driver.js";

/**
 * 创建完全隔离的内存 Mock 数据库适配器
 *
 * @return {object} Mock 适配器对象
 * @author wei
 * @since 2026-09-18
 */
function createMockAdapter() {
  const rows = [];
  return {
    rows,
    transaction: vi.fn((fn) => fn()),
    run: vi.fn((sql, params) => {
      if (sql.startsWith("INSERT INTO requestDetails")) {
        rows.push({ id: params[0], timestamp: params[1], data: params[6] });
        return { changes: 1, lastInsertRowid: rows.length };
      }
      if (sql.startsWith("DELETE FROM requestDetails")) {
        const deleteCount = params[0] || 0;
        rows.splice(0, deleteCount);
        return { changes: deleteCount, lastInsertRowid: 0 };
      }
      return { changes: 0, lastInsertRowid: 0 };
    }),
    get: vi.fn((sql) => {
      if (sql.includes("COUNT(*)")) {
        return { c: rows.length };
      }
      return null;
    }),
    all: vi.fn(() => rows),
    exec: vi.fn(),
  };
}

describe("requestDetails 同步持久化与全量保留测试", () => {
  beforeEach(() => {
    __test__.clearBuffer();
  });

  it("flushRequestDetailsSync 同步批量持久化成功并清空缓冲区", () => {
    const mockDb = createMockAdapter();
    const buffer = __test__.getWriteBuffer();

    // 注入模拟的待落盘记录
    buffer.push(
      { model: "gpt-4o", provider: "openai", status: 200, tokens: { total: 100 } },
      { model: "claude-3-5-sonnet", provider: "anthropic", status: 200, tokens: { total: 200 } }
    );

    const count = flushRequestDetailsSync(mockDb);

    expect(count).toBe(2);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.rows.length).toBe(2);
    // 验证缓冲区已被完全排空
    expect(__test__.getWriteBuffer().length).toBe(0);
  });

  it("executeDbShutdownHooks 在关闭时能够正确触发数据同步刷盘", () => {
    const mockDb = createMockAdapter();
    const buffer = __test__.getWriteBuffer();

    buffer.push({ model: "gemini-2.5-pro", provider: "google", status: 200 });

    // 触发全局关闭钩子
    executeDbShutdownHooks(mockDb);

    expect(mockDb.rows.length).toBe(1);
    expect(__test__.getWriteBuffer().length).toBe(0);
  });

  it("数据库写入异常时未落盘数据安全退回缓冲区头部", () => {
    const mockDb = createMockAdapter();
    // 模拟 transaction 抛出异常
    mockDb.transaction.mockImplementation(() => {
      throw new Error("SQLite IO Error");
    });

    const buffer = __test__.getWriteBuffer();
    const record = { model: "deepseek-chat", provider: "deepseek", status: 200 };
    buffer.push(record);

    const count = flushRequestDetailsSync(mockDb);

    expect(count).toBe(0);
    // 验证数据已退回队列头部，没有被丢弃
    expect(__test__.getWriteBuffer().length).toBe(1);
    expect(__test__.getWriteBuffer()[0]).toBe(record);
  });

  it("写入时不执行任何淘汰删除，数据全量持久化保留", () => {
    const mockDb = createMockAdapter();
    // 模拟数据库中已有 1500 条记录
    for (let i = 0; i < 1500; i++) {
      mockDb.rows.push({ id: `rec-${i}`, timestamp: new Date().toISOString(), data: "{}" });
    }

    const buffer = __test__.getWriteBuffer();
    buffer.push({ model: "gpt-4o", provider: "openai", status: 200 });

    mockDb.get = vi.fn((sql) => {
      if (sql.includes("COUNT(*)")) {
        return { c: 1500 };
      }
      return null;
    });

    const count = flushRequestDetailsSync(mockDb);

    expect(count).toBe(1);
    // 验证未执行任何 DELETE 语句，数据无截断
    const deleteCalls = mockDb.run.mock.calls.filter((call) =>
      call[0].includes("DELETE FROM requestDetails")
    );
    expect(deleteCalls.length).toBe(0);
  });
});
