import fs from "node:fs";
import { spawn } from "node:child_process";
import { getAdapter, getAdapterSync, registerDbShutdownHook } from "../driver.js";
import { DATA_FILE } from "../paths.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE_KB = 5;
const DEFAULT_MAX_JSON_SIZE = DEFAULT_MAX_JSON_SIZE_KB * 1024;
// 单字段落盘上限硬顶。settings.observabilityMaxJsonSize 可被历史版本或直接 PATCH 写成很大
// （线上实测为 2048 = 2MB/字段），而每行要存 4 个字段 → 单行最坏 8MB，9 天就撑到 10GB。
// 详见 docs/packaged-runtime-footprint.zh-CN.md。
const MAX_JSON_SIZE_BYTES = 256 * 1024;
// 请求详情保留策略：超期自动裁剪，避免本地库无界增长（0 = 不限制）。
const DEFAULT_RETENTION_DAYS = 7;
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETENTION_START_DELAY_MS = 30 * 1000;
// 内存缓冲上限：持久化持续失败时丢弃最旧记录，避免队列无界增长。
const MAX_BUFFERED_DETAILS = 200;
// 清理必须分批：同步驱动下一次 DELETE/VACUUM 会把整个网关卡住（实测 1GB 库即停摆 1.3s，
// 老库整库重写更是分钟级）。每批处理完主动让出事件循环，HTTP 请求才有机会被处理。
const PRUNE_BATCH_ROWS = 50;

/**
 * 让出事件循环一次，让进行中的 HTTP 请求有机会被处理
 *
 * 数据库驱动是同步的，进程内的批量操作必须靠「切成小批 + 批间让出」来避免长时间占住
 * 事件循环。（网关侧的清理已改为独立子进程，这里主要服务于库函数与测试。）
 *
 * @return {Promise<void>} 下一个事件循环 tick 后 resolve
 * @author wei
 * @since 2026-09-29
 */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

/**
 * 归一化 observabilityMaxJsonSize（单位 KB）并把单字段上限钳到 MAX_JSON_SIZE_BYTES
 *
 * @param {number|string} kb 设置项（KB）
 * @param {number|string} [fallbackKb] 缺省值（KB）
 * @return {number} 单字段字节上限
 * @author wei
 * @since 2026-09-29
 */
export function clampJsonSize(kb, fallbackKb = DEFAULT_MAX_JSON_SIZE_KB) {
  const raw = Number(kb);
  const fallback = Number(fallbackKb);
  const kbValue = Number.isFinite(raw) && raw > 0
    ? raw
    : (Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_MAX_JSON_SIZE_KB);
  return Math.min(Math.round(kbValue * 1024), MAX_JSON_SIZE_BYTES);
}

/**
 * 解析保留天数（0 = 不限制），非法值回落到默认 7 天
 *
 * @param {object} settings 全局设置对象
 * @return {number} 保留天数
 * @author wei
 * @since 2026-09-29
 */
function resolveRetentionDays(settings) {
  const raw = Number(settings?.observabilityRetentionDays);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(raw);
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
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: clampJsonSize(settings.observabilityMaxJsonSize, process.env.OBSERVABILITY_MAX_JSON_SIZE),
        retentionDays: resolveRetentionDays(settings),
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
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: clampJsonSize(settings.observabilityMaxJsonSize, process.env.OBSERVABILITY_MAX_JSON_SIZE),
      retentionDays: resolveRetentionDays(settings),
    };
  } catch {
    cachedConfig = {
      enabled: false,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
      retentionDays: DEFAULT_RETENTION_DAYS,
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
      const before = writeBuffer.length;
      flushRequestDetailsSync(db);
      // flushRequestDetailsSync 内部吞异常并把记录 unshift 回队列；
      // 排空失败时长度不减少，必须退出，否则是同步死循环。
      if (writeBuffer.length >= before) break;
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
  // 队列上限：持久化持续失败时丢弃最旧记录，避免内存无界增长
  while (writeBuffer.length > MAX_BUFFERED_DETAILS) writeBuffer.shift();

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
  // requestDetails 记录已全量持久化保留，与 usageHistory 取并集确保全量曾用供应商均可查询
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

/**
 * 统计数据库真实占用：主文件 + WAL
 *
 * WAL 模式下新数据先落 -wal，只 stat 主文件会严重低估（实测装满 2MB 时主文件仍只有 4KB），
 * 「压缩回收了多少」也会因此算错。
 *
 * @return {number|null} 字节数；文件不存在时返回 null
 * @author wei
 * @since 2026-09-29
 */
function measureDbBytes() {
  let total = 0;
  let found = false;
  for (const suffix of ["", "-wal"]) {
    try {
      total += fs.statSync(DATA_FILE + suffix).size;
      found = true;
    } catch {
      // 文件不存在（内存适配器 / 尚未落盘）：跳过
    }
  }
  return found ? total : null;
}

/**
 * 计算回收字节数（读数缺失时返回 null）
 *
 * @param {number|null} before 操作前字节数
 * @param {number|null} after 操作后字节数
 * @return {number|null} 回收字节数
 * @author wei
 * @since 2026-09-29
 */
function diffBytes(before, after) {
  return before != null && after != null ? Math.max(0, before - after) : null;
}

/**
 * 请求详情存储用量与保留策略快照
 *
 * @return {Promise<object>} { rows, oldest, newest, dbBytes, retentionDays, maxJsonSizeKb, enabled }
 * @author wei
 * @since 2026-09-29
 */
export async function getRequestDetailsStorage() {
  const db = await getAdapter();
  const config = await getObservabilityConfig();
  const row = db.get("SELECT COUNT(*) AS c, MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM requestDetails") || {};
  return {
    rows: row.c || 0,
    oldest: row.oldest || null,
    newest: row.newest || null,
    dbBytes: measureDbBytes(),
    retentionDays: config.retentionDays,
    maxJsonSizeKb: Math.round(config.maxJsonSize / 1024),
    enabled: config.enabled === true,
    // 后台维护进度：面板据此显示「正在清理」而不是点完就没反应
    maintenance: getMaintenanceState(),
  };
}

/**
 * 按保留天数裁剪 requestDetails
 *
 * 只删「请求详情」明细；用量/成本统计来自 usageHistory / usageDaily，不受影响。
 *
 * @param {object} [options] { days } 覆盖设置里的保留天数
 * @return {Promise<object>} { days, cutoff, deleted, remaining }
 * @author wei
 * @since 2026-09-29
 */
export async function pruneRequestDetails(options = {}) {
  const config = await getObservabilityConfig();
  const days = options.days ?? config.retentionDays;
  if (!Number.isFinite(Number(days)) || Number(days) <= 0) {
    return { days: 0, cutoff: null, deleted: 0, remaining: null };
  }
  const db = await getAdapter();
  const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString();

  // 分批删除并在批间让出事件循环。单条明细可达 MB 级（线上实例平均 1MB/条），
  // 一条 DELETE 扫掉几 GB 会让网关整个停摆——同步驱动下事件循环不转，
  // 面板与 /v1 转发一起卡死。
  let deleted = 0;
  if (typeof options.beforeBatch === "function") options.beforeBatch();
  for (;;) {
    const res = db.run(
      "DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails WHERE timestamp < ? LIMIT ?)",
      [cutoff, PRUNE_BATCH_ROWS]
    );
    const changes = typeof res?.changes === "number" ? res.changes : 0;
    deleted += changes;
    if (typeof options.onProgress === "function") options.onProgress({ deleted });
    if (changes < PRUNE_BATCH_ROWS) break;
    await yieldToEventLoop();
  }

  const remaining = db.get("SELECT COUNT(*) AS c FROM requestDetails");
  return {
    days: Number(days),
    cutoff,
    deleted,
    remaining: remaining?.c ?? null,
  };
}

// 维护任务的状态文件（放在库文件旁边）。子进程写、网关读：
// 网关只做「派发 + 读进度」，绝不在自己的线程里跑 SQL。
const MAINTENANCE_STATUS_FILE = `${DATA_FILE}.maintenance.json`;
// 子进程心跳超过这个时长就认为它已死（被 kill / 崩溃），允许重新派发
const MAINTENANCE_STALE_MS = 90 * 1000;

/**
 * 子进程脚本：在**独立进程**里完成裁剪与空间回收
 *
 * 为什么必须独立进程：数据库驱动是同步的，`incremental_vacuum` 在 GB 级库上单次就要数秒
 * （实测网关主线程 2303/2305 个采样都卡在 `DatabaseSync::Exec`），放在网关里无论怎么分批
 * 都会让请求排队数秒。这里用 `process.execPath -e` 跑内联脚本——打包形态没有可 fork 的
 * 脚本文件，Electron 以 ELECTRON_RUN_AS_NODE 启动的 helper 同样支持 -e。
 * 进度写进状态文件，网关读它来显示「正在后台清理 · N 条已删除」。
 *
 * 注意：这里的 SQL 与 `pruneRequestDetails()` 有重复——那份是进程内可测的库函数，
 * 这份跑在无依赖的子进程里（不能 import 应用的模块）。改动需同步两处。
 */
const MAINTENANCE_CHILD_SCRIPT = `
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const [dbPath, daysArg, statusPath] = process.argv.slice(1);
const days = Number(daysArg) || 0;
let state = { running: true, phase: "starting", days, deleted: 0, reclaimed: null,
              startedAt: Date.now(), finishedAt: null, error: null, childPid: process.pid };
const write = (patch) => {
  Object.assign(state, patch, { heartbeat: Date.now() });
  try { fs.writeFileSync(statusPath, JSON.stringify(state)); } catch (e) {}
};
const sizeOf = () => {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try { total += fs.statSync(dbPath + suffix).size; } catch (e) {}
  }
  return total;
};
// 子进程里可以放心睡：阻塞的是它自己，不是网关
const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };

let db = null;
try {
  write({});
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 60000");
  db.exec("PRAGMA journal_mode = WAL");
  const before = sizeOf();

  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    for (;;) {
      const r = db.prepare("DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails WHERE timestamp < ? LIMIT ?)").run(cutoff, 200);
      const n = Number(r.changes || 0);
      state.deleted += n;
      write({ phase: "pruning" });
      if (n < 200) break;
      nap(10);
    }
  }

  write({ phase: "compacting" });
  const mode = Number(Object.values(db.prepare("PRAGMA auto_vacuum").get())[0]) || 0;
  if (mode === 2) {
    for (let i = 0; i < 200000; i += 1) {
      const free = Number(Object.values(db.prepare("PRAGMA freelist_count").get())[0]) || 0;
      if (free <= 0) break;
      db.exec("PRAGMA incremental_vacuum(" + Math.min(1000, free) + ")");
      write({ phase: "compacting" });
      nap(20);
    }
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}
  } else if (mode === 1) {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}
  } else {
    // 老库（auto_vacuum=NONE）要缩小文件只能整库重写，而 VACUUM 需要**独占**整个库：
    // 运行期做这件事，网关的每一次写都会等满 busy_timeout 后报 "database is locked"，
    // 读也会被挡住。所以运行期只标记「需要离线压缩」，由用户在应用退出后执行。
    write({ needsOfflineCompaction: true });
  }

  const after = sizeOf();
  state.reclaimed = Math.max(0, before - after);
  write({ phase: "done", running: false, finishedAt: Date.now() });
} catch (err) {
  write({ phase: "error", running: false, error: String(err && err.message || err), finishedAt: Date.now() });
} finally {
  try { if (db) db.close(); } catch (e) {}
}
`;

/**
 * 读取维护状态（网关侧只读文件，不碰数据库）
 *
 * @return {object} 状态对象；无状态文件或子进程已死时返回空闲态
 * @author wei
 * @since 2026-09-29
 */
function readMaintenanceStatus() {
  const idle = {
    running: false, phase: "idle", days: null, deleted: 0,
    reclaimed: null, startedAt: null, finishedAt: null, error: null,
    needsOfflineCompaction: false,
  };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(MAINTENANCE_STATUS_FILE, "utf8"));
  } catch {
    return idle;
  }
  if (!raw || typeof raw !== "object") return idle;
  // 心跳过期 = 子进程被 kill 或崩溃，不能一直显示「清理中」
  const stale = raw.running === true && (!raw.heartbeat || Date.now() - raw.heartbeat > MAINTENANCE_STALE_MS);
  return { ...idle, ...raw, running: raw.running === true && !stale };
}

/**
 * 派发一次后台维护（**立即返回**，清理全部在独立子进程里做）
 *
 * @param {object} [options] { days } 覆盖设置里的保留天数；不传用设置值
 * @return {object} { started, alreadyRunning, state }
 * @author wei
 * @since 2026-09-29
 */
function spawnMaintenanceChild(options = {}) {
  const current = readMaintenanceStatus();
  // 子进程写完状态文件前有一小段空窗，用进程内的派发时间兜住，避免重复起进程
  const spawnedRecently = globalThis.__requestDetailsMaintenanceSpawnedAt
    && Date.now() - globalThis.__requestDetailsMaintenanceSpawnedAt < MAINTENANCE_STALE_MS;
  if (current.running || spawnedRecently) {
    return { started: false, alreadyRunning: true, state: current };
  }

  const days = Number.isFinite(Number(options.days))
    ? Number(options.days)
    : Number(current.days) || 0;

  try {
    fs.mkdirSync(pathDirname(MAINTENANCE_STATUS_FILE), { recursive: true });
  } catch {
    /* 目录已存在 */
  }

  const sizeBefore = measureDbBytes();
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    ["-e", MAINTENANCE_CHILD_SCRIPT, DATA_FILE, String(days), MAINTENANCE_STATUS_FILE],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  globalThis.__requestDetailsMaintenanceChild = true;
  globalThis.__requestDetailsMaintenanceSpawnedAt = startedAt;

  console.log(
    `[requestDetails] 后台维护开始：保留 ${days} 天，当前库 ${(sizeBefore / 1048576).toFixed(1)}MB` +
    "（独立进程执行，网关不参与）"
  );

  // 子进程把结果写进状态文件后退出，这里补上「完成 / 异常」的收尾日志：
  // 只有开始一行的话，日志里看不到这次清理到底做了什么、失败了没有。
  child.once("exit", (code) => {
    globalThis.__requestDetailsMaintenanceChild = false;
    const st = readMaintenanceStatus();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (st.error) {
      console.warn(`[requestDetails] 后台维护失败（用时 ${seconds}s）：${st.error}`);
      return;
    }
    if (!st.finishedAt) {
      console.warn(
        `[requestDetails] 后台维护异常结束（退出码 ${code}，用时 ${seconds}s），未写入结果，` +
        "下次巡检会重试"
      );
      return;
    }

    const parts = [`[requestDetails] 后台维护完成：删除 ${st.deleted} 条`];
    if (st.reclaimed > 0) parts.push(`释放 ${(st.reclaimed / 1048576).toFixed(1)}MB`);
    else if (st.deleted === 0) parts.push("无可回收空间");
    parts.push(`用时 ${seconds}s`);
    if (st.needsOfflineCompaction) parts.push("该库需离线压缩才能缩小文件");
    console.log(parts.join("，"));
  });

  return { started: true, alreadyRunning: false, state: readMaintenanceStatus() };
}

/**
 * 取状态文件所在目录
 *
 * @param {string} file 文件路径
 * @return {string} 目录路径
 * @author wei
 * @since 2026-09-29
 */
function pathDirname(file) {
  const idx = file.lastIndexOf("/");
  return idx > 0 ? file.slice(0, idx) : ".";
}

/**
 * 维护任务状态（globalThis 单例：HMR / 重复导入不能各持一份）
 *
 * @return {object} 可变状态对象
 * @author wei
 * @since 2026-09-29
 */
/**
 * 判断是否值得跑一次维护（只读、廉价：走 timestamp 索引 + freelist 统计）
 *
 * @return {Promise<boolean>} 有超期记录或存在空闲页时为 true
 * @author wei
 * @since 2026-09-29
 */
async function needsMaintenance() {
  const config = await getObservabilityConfig();
  const days = config.retentionDays;
  const db = await getAdapter();
  if (Number(days) > 0) {
    const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const row = db.get("SELECT COUNT(*) AS c FROM requestDetails WHERE timestamp < ?", [cutoff]);
    if ((row?.c || 0) > 0) return true;
  }
  try {
    const free = db.get("PRAGMA freelist_count");
    if ((Number(free ? Object.values(free)[0] : 0) || 0) > 0) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * 读取维护任务状态（供 API / 面板轮询）—— 全部来自子进程写的状态文件
 *
 * @return {object} 状态副本
 * @author wei
 * @since 2026-09-29
 */
export function getMaintenanceState() {
  return readMaintenanceStatus();
}

export function startRequestDetailsMaintenance(options = {}) {
  return spawnMaintenanceChild(options);
}

/**
 * 按保留天数滚动清理：启动后延迟跑一次，之后每 6 小时一次
 *
 * 定时器 unref 不阻塞退出；用 globalThis 单例防 HMR/重复导入重复挂载。
 * 触发的是后台任务，不阻塞请求路径。
 *
 * @return {void}
 * @author wei
 * @since 2026-09-29
 */
export function startRequestDetailsRetention() {
  if (globalThis.__requestDetailsRetentionTimer) return;
  const sweep = () => {
    if (readMaintenanceStatus().running) return;
    // 没事就不起子进程：有超期记录、或库里有空闲页时才派发
    needsMaintenance()
      .then((needed) => { if (needed) startRequestDetailsMaintenance(); })
      .catch((e) => console.warn(`[requestDetails] 巡检失败: ${e.message}`));
  };
  setTimeout(sweep, RETENTION_START_DELAY_MS).unref?.();
  globalThis.__requestDetailsRetentionTimer = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS);
  globalThis.__requestDetailsRetentionTimer.unref?.();
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
