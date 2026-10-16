import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import {
  MODELS_DEV_URL,
  parseModelsDevData,
  setRuntimePricingCache,
  getRuntimePricingCache,
  getPricingForModel as resolveConstPricing,
  PROVIDER_PRICING,
} from "open-sse/providers/pricing.js";

const systemKv = makeKv("system");
const PRICING_KV_KEY = "models_dev_pricing";
const AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

let isSyncing = false;
let isInitialized = false;

/**
 * 从数据库初始化 models.dev 运行时定价缓存
 *
 * @returns {Promise<object|null>} 成功加载的定价缓存或 null
 */
async function ensureInitialized() {
  if (isInitialized) return getRuntimePricingCache();
  try {
    const saved = await systemKv.get(PRICING_KV_KEY);
    if (saved && typeof saved === "object" && saved.byModel) {
      setRuntimePricingCache(saved);
    }
  } catch (e) {
    console.warn("[pricing] Failed to load cached models.dev pricing from localDb:", e.message);
  } finally {
    isInitialized = true;
  }
  return getRuntimePricingCache();
}

/**
 * 获取当前 models.dev 定价同步元信息
 *
 * @returns {Promise<object>} 包含数据源标识、最后更新时间、已收录模型数和同步状态
 */
export async function getModelsDevPricingMeta() {
  await ensureInitialized();
  const cache = getRuntimePricingCache();
  return {
    source: "models.dev",
    url: "https://models.dev",
    lastUpdated: cache?.lastUpdated || null,
    modelCount: cache?.modelCount || 0,
    isSyncing,
  };
}

/**
 * 从 models.dev 远程 API 同步最新模型定价并持久化到本地
 *
 * @param {boolean} force 是否强制同步（忽略冷却与已有数据）
 * @returns {Promise<object>} 同步结果对象
 */
export async function syncModelsDevPricing(force = false) {
  if (isSyncing) {
    const meta = await getModelsDevPricingMeta();
    return { success: false, message: "Sync already in progress", ...meta };
  }

  isSyncing = true;
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const rawData = await response.json();
    const slimData = parseModelsDevData(rawData);

    // 持久化存储到数据库
    await systemKv.set(PRICING_KV_KEY, slimData);
    setRuntimePricingCache(slimData);
    isInitialized = true;

    return {
      success: true,
      lastUpdated: slimData.lastUpdated,
      modelCount: slimData.modelCount,
      isSyncing: false,
    };
  } catch (err) {
    console.warn("[pricing] Failed to sync pricing from models.dev:", err.message);
    const meta = await getModelsDevPricingMeta();
    return {
      success: false,
      error: err.message,
      lastUpdated: meta.lastUpdated,
      modelCount: meta.modelCount,
      isSyncing: false,
    };
  } finally {
    isSyncing = false;
  }
}

/**
 * 检查上次同步时间，并在过期（>24小时）或无缓存时在后台静默触发自动同步
 */
export function checkAndAutoSyncPricing() {
  ensureInitialized().then((cache) => {
    const last = cache?.lastUpdated ? new Date(cache.lastUpdated).getTime() : 0;
    const now = Date.now();
    if (!last || now - last > AUTO_SYNC_INTERVAL_MS) {
      syncModelsDevPricing(false).catch(() => {});
    }
  }).catch(() => {});
}

/**
 * 获取当前定价信息与元数据（向后兼容 UI 与 API）
 *
 * @returns {Promise<object>}
 */
export async function getPricing() {
  await ensureInitialized();
  const meta = await getModelsDevPricingMeta();
  return {
    ...meta,
    providers: PROVIDER_PRICING,
  };
}

/**
 * 解析特定提供商及模型的定价费率
 *
 * @param {string} provider 提供商标识
 * @param {string} model 模型名称
 * @returns {Promise<object|null>} 费率对象或 null
 */
export async function getPricingForModel(provider, model) {
  if (!model) return null;
  await ensureInitialized();
  return resolveConstPricing(provider, model);
}

/**
 * 历史手填保存方法兼容存根（已切换为 models.dev 标准源，不再支持手动覆写）
 *
 * @returns {Promise<object>}
 */
export async function updatePricing() {
  return await getPricing();
}

/**
 * 历史手填重置方法兼容存根
 *
 * @returns {Promise<object>}
 */
export async function resetPricing() {
  return await getPricing();
}

/**
 * 历史全量重置方法兼容存根
 *
 * @returns {Promise<object>}
 */
export async function resetAllPricing() {
  return await getPricing();
}
