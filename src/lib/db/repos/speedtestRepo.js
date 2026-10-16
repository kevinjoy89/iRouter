import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import { maskApiKey } from "@/shared/utils/maskKey.js";
import crypto from "node:crypto";

/**
 * 供应商与前缀对应映射表（规范化历史数据中显示名称与接入前缀的对应关系）
 */
const KNOWN_PROVIDER_PREFIXES = {
  "agnes ai": "agnes",
  agnes: "agnes",
  opencsg: "ocsg",
  ocsg: "ocsg",
  "商汤日日新": "sensenova",
  sensenova: "sensenova",
  "codebuddy cn": "codebuddy-cn",
  codebuddy: "codebuddy-cn",
  "基元律动": "tokenrhythm",
  tokenrhythm: "tokenrhythm",
  aihub: "aihub",
  antdigital: "ant",
  ant: "ant",
  senseaudio: "senseaudio",
  qimeng: "qimeng",
  tokenrouter: "tr",
  stepfun: "stepfun",
  heading: "hd",
  "share llm": "sharellm",
  "charm™ hyper": "chyper",
  deepseek: "deepseek",
  ollama: "ollama",
  nvidia: "nvidia",
  gemini: "gemini",
  openrouter: "openrouter",
  "opencode-go": "opencode-go",
};

/**
 * 规整模型完整路径标识（如 agnes/agnes-3.0-flash）
 *
 * @param {string} model 原始模型名
 * @param {string} provider 供应商标识或名称
 * @return {string} 规范化的模型完整路径
 */
export function normalizeModelPrefix(model, provider) {
  if (!model) return "-";
  if (model.includes("/")) {
    const slashIdx = model.indexOf("/");
    const rawPrefix = model.slice(0, slashIdx).trim().toLowerCase();
    const subModel = model.slice(slashIdx + 1);

    if (KNOWN_PROVIDER_PREFIXES[rawPrefix]) {
      return `${KNOWN_PROVIDER_PREFIXES[rawPrefix]}/${subModel}`;
    }

    if (rawPrefix.startsWith("openai-compatible") || rawPrefix.startsWith("anthropic-compatible")) {
      if (provider) {
        const pKey = String(provider).split("·")[0].trim().toLowerCase();
        const resolvedPrefix = KNOWN_PROVIDER_PREFIXES[pKey] || pKey.replace(/ai$/i, "").trim().replace(/[^a-z0-9_-]/g, "");
        if (resolvedPrefix) {
          return `${resolvedPrefix}/${subModel}`;
        }
      }
    }

    return model;
  }

  if (provider && provider !== "Custom") {
    const pKey = String(provider).split("·")[0].trim().toLowerCase();
    const resolvedPrefix = KNOWN_PROVIDER_PREFIXES[pKey] || pKey.replace(/ai$/i, "").trim().replace(/[^a-z0-9_-]/g, "");
    if (resolvedPrefix) {
      return `${resolvedPrefix}/${model}`;
    }
  }

  return model;
}

/**
 * 模型测速指标数据库仓储服务
 *
 * @author iRouter
 * @since 2026-10-16
 */

/**
 * 保存单条或单批次测速评测结果（敏感 Key 自动脱敏入库）
 *
 * @param {Object} record 测速结果数据对象
 * @return {Promise<string>} 成功写入的记录 ID
 */
export async function saveSpeedtestResult(record) {
  const db = await getAdapter();
  const id = record.id || crypto.randomUUID();
  const batchId = record.batchId || id;
  const createdAt = record.createdAt || new Date().toISOString();

  // 凭据脱敏指纹：若传入了原始 Key 则即时脱敏，数据库绝不落盘原始密钥
  const keyFingerprint = record.keyFingerprint || maskApiKey(record.apiKey);

  const chunkP50 = Number(record.chunkMetrics?.p50Ms ?? record.chunkP50Ms) || 0;
  const chunkP95 = Number(record.chunkMetrics?.p95Ms ?? record.chunkP95Ms) || 0;
  const chunkP99 = Number(record.chunkMetrics?.p99Ms ?? record.chunkP99Ms) || 0;
  const jitterRatio = record.chunkMetrics?.jitterRatio ?? record.jitterRatio ?? null;

  const avgSpeed = Number(record.avgSpeed) || 0;
  let steadySpeed = Number(record.steadySpeed) || 0;
  // 防御上游单包缓冲造成的突发极端值（> 5000 t/s）
  if (steadySpeed > 5000) {
    steadySpeed = avgSpeed;
  }

  const curveJson = typeof record.curvePoints === "string"
    ? record.curvePoints
    : JSON.stringify(record.curvePoints || []);

  const rawJson = typeof record.rawMetrics === "string"
    ? record.rawMetrics
    : JSON.stringify(record.rawMetrics || {});

  // 规整模型完整路径（如 agnes/agnes-3.0-flash）
  const modelName = normalizeModelPrefix(record.model, record.provider);

  const sql = `
    INSERT INTO speedtestResults (
      id, batchId, model, provider, gatewayUrl, protocol, promptTemplate,
      rounds, ttftMs, totalDurationMs, generationDurationMs, steadySpeed,
      avgSpeed, outputTokens, tokensEstimated, chunkP50Ms, chunkP95Ms,
      chunkP99Ms, jitterRatio, curvePointsJson, rawMetricsJson,
      keyFingerprint, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    id,
    batchId,
    modelName,
    record.provider || null,
    record.gatewayUrl || "",
    record.protocol || "openai",
    record.promptTemplate || "",
    Number(record.rounds) || 1,
    Number(record.ttftMs) || 0,
    Number(record.totalDurationMs) || 0,
    Number(record.generationDurationMs) || 0,
    steadySpeed,
    avgSpeed,
    Number(record.outputTokens) || 0,
    record.tokensEstimated ? 1 : 0,
    chunkP50,
    chunkP95,
    chunkP99,
    jitterRatio !== null ? Number(jitterRatio) : null,
    curveJson,
    rawJson,
    keyFingerprint,
    createdAt,
  ];

  await db.run(sql, params);
  return id;
}

/**
 * 分页查询测速历史记录
 *
 * @param {Object} options 过滤与分页参数
 * @param {number} [options.page=1] 页码
 * @param {number} [options.limit=20] 每页条数
 * @param {string} [options.model] 按模型名称筛选
 * @param {string} [options.gatewayUrl] 按网关地址筛选
 * @param {string} [options.batchId] 按测试批次筛选
 * @return {Promise<{records: Array, total: number, page: number, limit: number}>} 查询结果对象
 */
export async function getSpeedtestHistory({ page = 1, limit = 20, model, gatewayUrl, batchId } = {}) {
  const db = await getAdapter();
  const conditions = [];
  const params = [];

  if (model) {
    conditions.push("model LIKE ?");
    params.push(`%${model}%`);
  }
  if (gatewayUrl) {
    conditions.push("gatewayUrl LIKE ?");
    params.push(`%${gatewayUrl}%`);
  }
  if (batchId) {
    conditions.push("batchId = ?");
    params.push(batchId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = await db.get(
    `SELECT COUNT(*) AS total FROM speedtestResults ${whereClause}`,
    params
  );
  const total = countRow?.total || 0;

  const offset = (Math.max(1, page) - 1) * limit;
  const rows = await db.all(
    `SELECT * FROM speedtestResults ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const records = rows.map((row) => ({
    ...row,
    model: normalizeModelPrefix(row.model, row.provider),
    tokensEstimated: Boolean(row.tokensEstimated),
    curvePoints: parseJson(row.curvePointsJson) || [],
    rawMetrics: parseJson(row.rawMetricsJson) || {},
  }));

  return { records, total, page, limit };
}

/**
 * 聚合查询各模型与网关的历史测速统计指标（中位数稳定速度与平均 TTFT）
 *
 * @return {Promise<Array>} 聚合统计分析数组
 */
export async function getSpeedtestStats() {
  const db = await getAdapter();
  const sql = `
    SELECT
      model,
      provider,
      gatewayUrl,
      COUNT(*) AS runCount,
      AVG(ttftMs) AS avgTtft,
      MIN(ttftMs) AS minTtft,
      AVG(CASE WHEN steadySpeed > 5000 THEN avgSpeed ELSE steadySpeed END) AS avgSteadySpeed,
      MAX(CASE WHEN steadySpeed > 5000 THEN avgSpeed ELSE steadySpeed END) AS maxSteadySpeed,
      AVG(chunkP50Ms) AS avgChunkP50,
      AVG(jitterRatio) AS avgJitterRatio
    FROM speedtestResults
    GROUP BY model, gatewayUrl
    ORDER BY avgSteadySpeed DESC
  `;
  const rows = await db.all(sql);

  // 基于规范化模型名进行聚合去重（合并历史存量未加前缀与加了前缀的同名记录）
  const aggregatedMap = new Map();

  for (const r of rows) {
    const fullModel = normalizeModelPrefix(r.model, r.provider);
    const key = `${fullModel}__${r.gatewayUrl || ""}`;
    const runCount = Number(r.runCount) || 1;
    const avgTtft = Number(r.avgTtft) || 0;
    const avgSteadySpeed = Number(r.avgSteadySpeed) || 0;
    const maxSteadySpeed = Number(r.maxSteadySpeed) || 0;
    const avgChunkP50 = Number(r.avgChunkP50) || 0;

    if (!aggregatedMap.has(key)) {
      aggregatedMap.set(key, {
        model: fullModel,
        gatewayUrl: r.gatewayUrl,
        runCount,
        totalTtft: avgTtft * runCount,
        minTtft: Number(r.minTtft) || avgTtft,
        totalSpeed: avgSteadySpeed * runCount,
        maxSteadySpeed,
        totalChunkP50: avgChunkP50 * runCount,
        jitterRatios: r.avgJitterRatio !== null ? [Number(r.avgJitterRatio)] : [],
      });
    } else {
      const entry = aggregatedMap.get(key);
      entry.runCount += runCount;
      entry.totalTtft += avgTtft * runCount;
      entry.minTtft = Math.min(entry.minTtft, Number(r.minTtft) || avgTtft);
      entry.totalSpeed += avgSteadySpeed * runCount;
      entry.maxSteadySpeed = Math.max(entry.maxSteadySpeed, maxSteadySpeed);
      entry.totalChunkP50 += avgChunkP50 * runCount;
      if (r.avgJitterRatio !== null) entry.jitterRatios.push(Number(r.avgJitterRatio));
    }
  }

  const results = Array.from(aggregatedMap.values()).map((entry) => ({
    model: entry.model,
    gatewayUrl: entry.gatewayUrl,
    runCount: entry.runCount,
    avgTtft: Number((entry.totalTtft / entry.runCount).toFixed(1)),
    minTtft: Number(Number(entry.minTtft).toFixed(1)),
    avgSteadySpeed: Number((entry.totalSpeed / entry.runCount).toFixed(2)),
    maxSteadySpeed: Number(Number(entry.maxSteadySpeed).toFixed(2)),
    avgChunkP50: Number((entry.totalChunkP50 / entry.runCount).toFixed(1)),
    avgJitterRatio:
      entry.jitterRatios.length > 0
        ? Number((entry.jitterRatios.reduce((a, b) => a + b, 0) / entry.jitterRatios.length).toFixed(2))
        : null,
  }));

  results.sort((a, b) => b.avgSteadySpeed - a.avgSteadySpeed);
  return results;
}

/**
 * 导出全部测速历史数据为单行格式的 JSONL 文本内容
 *
 * @return {Promise<string>} 格式化完成的 JSONL 文本串
 */
export async function exportSpeedtestHistoryJsonl() {
  const db = await getAdapter();
  const rows = await db.all("SELECT * FROM speedtestResults ORDER BY createdAt ASC");
  return rows
    .map((row) => {
      const item = {
        ...row,
        tokensEstimated: Boolean(row.tokensEstimated),
        curvePoints: parseJson(row.curvePointsJson) || [],
        rawMetrics: parseJson(row.rawMetricsJson) || {},
      };
      delete item.curvePointsJson;
      delete item.rawMetricsJson;
      return JSON.stringify(item);
    })
    .join("\n");
}

/**
 * 清空或按条件清理历史测速数据
 *
 * @param {Object} [filter={}] 清理过滤条件
 * @param {string} [filter.batchId] 指定批次 ID
 * @param {string} [filter.beforeDate] 清理早于该 ISO 日期的记录
 * @return {Promise<number>} 成功清理的记录行数
 */
export async function clearSpeedtestHistory({ batchId, beforeDate } = {}) {
  const db = await getAdapter();
  if (batchId) {
    const res = await db.run("DELETE FROM speedtestResults WHERE batchId = ?", [batchId]);
    return res?.changes || 0;
  }
  if (beforeDate) {
    const res = await db.run("DELETE FROM speedtestResults WHERE createdAt < ?", [beforeDate]);
    return res?.changes || 0;
  }
  const res = await db.run("DELETE FROM speedtestResults");
  return res?.changes || 0;
}
