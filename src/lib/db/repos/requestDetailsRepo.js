import { getAdapter, getAdapterSync, registerDbShutdownHook } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 1000;
const MIN_RETAINED_RECORDS = 100;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

/**
 * 解析并防御性校验请求详情最大保留条数
 *
 * @param {string|number} [customValue] 用户或环境变量配置的最大条数
 * @return {number} 合法且安全的保留条数下限
 * @author wei
 * @since 2026-09-18
 */
function resolveSafeMaxRecords(customValue) {
  const parsed = parseInt(customValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_RECORDS;
  // 防御性保护：保留条数至少为 MIN_RETAINED_RECORDS 条，防止异常配置引发过度淘汰
  return Math.max(MIN_RETAINED_RECORDS, parsed);
}

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      cachedConfig = {
        enabled,
        maxRecords: resolveSafeMaxRecords(settings.observabilityMaxRecords ?? process.env.OBSERVABILITY_MAX_RECORDS),
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? settings.enableObservability
      : envFallback;

    cachedConfig = {
      enabled,
      maxRecords: resolveSafeMaxRecords(settings.observabilityMaxRecords ?? process.env.OBSERVABILITY_MAX_RECORDS),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = {
  sanitizeHeaders,
  resolveSafeMaxRecords,
  getWriteBuffer: () => writeBuffer,
  clearBuffer: () => { writeBuffer = []; },
};

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

/**
 * 同步将内存缓冲区中的请求详情写入数据库
 *
 * @param {object} [targetAdapter] 可选的目标数据库适配器实例，未传时自动获取
 * @return {number} 本次成功持久化的记录条数
 * @throws {Error} 数据库操作失败时可能抛出异常
 * @author wei
 * @since 2026-09-18
 */
export function flushRequestDetailsSync(targetAdapter) {
  if (writeBuffer.length === 0) return 0;

  let db = targetAdapter;
  if (!db) {
    try {
      db = getAdapterSync();
    } catch {
      // 数据库尚未初始化或已销毁，无法执行同步写入
      return 0;
    }
  }
  if (!db) return 0;

  // 获取当前配置或兜底默认配置
  const config = cachedConfig || {
    maxRecords: DEFAULT_MAX_RECORDS,
    maxJsonSize: DEFAULT_MAX_JSON_SIZE,
  };

  // 取出当前缓冲区中的全部数据
  const items = writeBuffer.splice(0, writeBuffer.length);
  if (items.length === 0) return 0;

  try {
    db.transaction(() => {
      for (const item of items) {
        if (!item.id) item.id = generateDetailId(item.model);
        if (!item.timestamp) item.timestamp = new Date().toISOString();
        if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

        const record = {
          id: item.id,
          provider: item.provider || null,
          model: item.model || null,
          connectionId: item.connectionId || null,
          timestamp: item.timestamp,
          status: item.status || null,
          latency: item.latency || {},
          tokens: item.tokens || {},
          request: truncateField(item.request, config.maxJsonSize),
          providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
          providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
          response: truncateField(item.response, config.maxJsonSize),
          pxpipe: item.pxpipe || undefined,
        };

        db.run(
          `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
          [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
        );
      }

      const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
      if (cnt && cnt.c > config.maxRecords) {
        db.run(
          `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
          [cnt.c - config.maxRecords]
        );
      }
    });
    return items.length;
  } catch (e) {
    console.error("[requestDetailsRepo] 同步持久化请求详情失败:", e);
    // 写入失败时将未落盘记录放回缓冲队列头部，避免丢数据
    writeBuffer.unshift(...items);
    return 0;
  }
}

/**
 * 异步刷新内存缓冲区到数据库
 *
 * @return {Promise<void>} 异步任务 Promise
 * @author wei
 * @since 2026-09-18
 */
async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    const db = await getAdapter();
    // 循环排空，处理在异步等待期间新入队的记录
    while (writeBuffer.length > 0) {
      flushRequestDetailsSync(db);
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  // Sentinel filter: ids that resolve to no known provider. An empty known-list
  // still means "everything is unresolvable" → match any non-null provider.
  if (Array.isArray(filter.providerNotIn)) {
    conds.push(
      filter.providerNotIn.length
        ? `provider NOT IN (${filter.providerNotIn.map(() => "?").join(", ")})`
        : "provider IS NOT NULL"
    );
    params.push(...filter.providerNotIn);
  }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  // requestDetails 有保留上限（observabilityMaxRecords，默认 1000 条）并会被 LRU 淘汰，
  // 单独作为来源会让下拉框随窗口滑动而丢掉仍在使用的供应商。usageHistory 无上限，
  // 二者取并集才是「用过的全部供应商」。
  const rows = db.all(`
    SELECT provider FROM requestDetails WHERE provider IS NOT NULL
    UNION
    SELECT provider FROM usageHistory WHERE provider IS NOT NULL
    ORDER BY provider ASC
  `);
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

const _shutdownHandler = () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) {
    flushRequestDetailsSync();
  }
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();

// 注册到全局数据库适配器关闭钩子，确保在数据库连接关闭及 WAL TRUNCATE 之前完成写入
registerDbShutdownHook((adapter) => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushRequestDetailsSync(adapter);
});
