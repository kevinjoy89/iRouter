"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import { translate } from "@/i18n/runtime";
import { AI_PROVIDERS, getProviderByAlias, DELETED_PROVIDER_ID, DELETED_PROVIDER_LABEL } from "@/shared/constants/providers";

let providerNameCache = null;
let providerNodesCache = null;

async function fetchProviderNames() {
  if (providerNameCache && providerNodesCache) {
    return { providerNameCache, providerNodesCache };
  }

  const nodesRes = await fetch("/api/provider-nodes");
  const nodesData = await nodesRes.json();
  const nodes = nodesData.nodes || [];
  providerNodesCache = {};

  for (const node of nodes) {
    providerNodesCache[node.id] = node.name;
  }

  providerNameCache = {
    ...AI_PROVIDERS,
    ...providerNodesCache
  };

  return { providerNameCache, providerNodesCache };
}

function getProviderName(providerId, cache) {
  if (!providerId) return providerId;
  if (!cache) return providerId;

  const cached = cache[providerId];

  if (typeof cached === 'string') {
    return cached;
  }

  if (cached?.name) {
    return cached.name;
  }

  const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
  return providerConfig?.name || providerId;
}

function CollapsibleSection({ title, children, defaultOpen = false, icon = null }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  
  return (
    <div className="border border-black/5 dark:border-white/5 rounded-lg overflow-hidden">
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon && <span className="material-symbols-outlined text-[18px] text-text-muted">{icon}</span>}
          <span className="font-semibold text-sm text-text-main">{title}</span>
        </div>
        <span className={cn(
          "material-symbols-outlined text-[20px] text-text-muted transition-transform duration-200",
          isOpen ? "rotate-90" : ""
        )}>
          chevron_right
        </span>
      </button>
      
      {isOpen && (
        <div className="p-4 border-t border-black/5 dark:border-white/5">
          {children}
        </div>
      )}
    </div>
  );
}

function getCachedTokens(tokens) {
  return tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
}

function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_input_tokens || 0;
}

function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  // Canonical storage keeps prompt cache-inclusive. Legacy Claude rows may have
  // stored prompt cache-exclusive; fall back to cache when it's larger so old
  // rows don't under-report input.
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

/**
 * 获取输出 Token 数，兼容 completion_tokens 与 output_tokens 命名
 *
 * @param {Object} tokens Token 统计对象
 * @return {number} 输出 Token 数
 */
function getOutputTokens(tokens) {
  return tokens?.completion_tokens ?? tokens?.output_tokens ?? 0;
}

/**
 * 将 Date 对象格式化为 datetime-local 输入框兼容的本地时间字符串（YYYY-MM-DDTHH:mm）
 *
 * @param {Date} date 日期对象
 * @return {string} 本地日期时间字符串
 * @author wei
 * @since 2026-09-19
 */
function formatLocalDateTime(date) {
  const pad = (num) => String(num).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d}T${h}:${min}`;
}

/**
 * 获取近 24 小时的默认开始与结束时间范围字符串
 *
 * @return {{startDate: string, endDate: string}} 时间范围对象
 * @author wei
 * @since 2026-09-19
 */
function getDefaultDateRange() {
  const now = new Date();
  const past24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return {
    startDate: formatLocalDateTime(past24Hours),
    endDate: formatLocalDateTime(now),
  };
}

/**
 * 请求详情 Tab 组件
 * 支持分页查看请求日志明细，并在第 1 页且抽屉未展开时支持静默自动刷新
 *
 * @author wei
 * @since 2026-09-16
 * @param {Object} props 组件入参
 * @param {number} [props.refreshKey=0] 外部刷新触发信号
 * @return {JSX.Element} 请求详情视图
 */
export default function RequestDetailsTab({ refreshKey = 0 } = {}) {
  const [details, setDetails] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0
  });
  const [loading, setLoading] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  const [providerNameCache, setProviderNameCache] = useState(null);
  const [filters, setFilters] = useState(() => {
    const range = getDefaultDateRange();
    return {
      provider: "",
      status: "",
      startDate: range.startDate,
      endDate: range.endDate,
    };
  });

  const fetchProviders = useCallback(() => {
    fetch("/api/usage/providers")
      .then((res) => res.json())
      .then((data) => {
        setProviders(data.providers || []);
        return fetchProviderNames();
      })
      .then((cache) => {
        if (cache?.providerNameCache) {
          setProviderNameCache(cache.providerNameCache);
        }
      })
      .catch((error) => {
        console.error("Failed to fetch providers:", error);
      });
  }, []);

  /**
   * 拉取请求明细列表
   *
   * @param {boolean} [isSilent=false] 是否静默拉取（静默拉取时不展示 loading 遮罩）
   * @return {Promise<void>} 异步拉取结果
   */
  const fetchDetails = useCallback(
    (isSilent = false) => {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
      });
      if (filters.provider) params.append("provider", filters.provider);
      if (filters.status) params.append("status", filters.status);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);

      return fetch(`/api/usage/request-details?${params}`)
        .then((res) => res.json())
        .then((data) => {
          setDetails(data.details || []);
          setPagination((prev) => ({ ...prev, ...data.pagination }));
        })
        .catch((error) => {
          console.error("Failed to fetch request details:", error);
        })
        .finally(() => {
          if (!isSilent) {
            setLoading(false);
          }
        });
    },
    [pagination.page, pagination.pageSize, filters]
  );

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    fetchDetails(false);
  }, [fetchDetails]);

  // 监听外部刷新触发信号
  useEffect(() => {
    if (refreshKey > 0) {
      // 仅在未打开详情抽屉且处于第 1 页时静默刷新最新请求列表，避免干扰用户排查
      if (!isDrawerOpen && pagination.page === 1) {
        fetchDetails(true);
      }
    }
  }, [refreshKey, isDrawerOpen, pagination.page, fetchDetails]);

  const handleViewDetail = (detail) => {
    setSelectedDetail(detail);
    setIsDrawerOpen(true);
  };

  const handlePageChange = (newPage) => {
    setLoading(true);
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const handlePageSizeChange = (newPageSize) => {
    setLoading(true);
    setPagination(prev => ({ ...prev, pageSize: newPageSize, page: 1 }));
  };

  /**
   * 重置筛选条件为近 24 小时默认值
   */
  const handleResetFilters = () => {
    const range = getDefaultDateRange();
    setFilters({
      provider: "",
      status: "",
      startDate: range.startDate,
      endDate: range.endDate,
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="none" className="overflow-hidden">
        {/* 表格顶部工具栏：筛选过滤与记录汇总 */}
        <div className="p-3 sm:px-4 sm:py-3 border-b border-black/5 dark:border-white/5 flex flex-wrap items-center justify-between gap-3 bg-black/[0.01] dark:bg-white/[0.01]">
          {/* 左侧筛选控件组 */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* 提供商筛选 */}
            <select
              id="provider-filter"
              aria-label="Provider"
              value={filters.provider}
              onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
              className={cn(
                "h-8.5 px-2.5 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-xs font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                "w-36 cursor-pointer"
              )}
              style={{ colorScheme: 'auto' }}
            >
              <option value="">All Providers</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.id === DELETED_PROVIDER_ID ? DELETED_PROVIDER_LABEL : provider.name}
                </option>
              ))}
            </select>

            {/* 状态筛选 */}
            <select
              id="status-filter"
              aria-label="Status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className={cn(
                "h-8.5 px-2.5 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-xs font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                "w-28 cursor-pointer"
              )}
              style={{ colorScheme: 'auto' }}
            >
              <option value="">All Statuses</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
            </select>
            
            {/* 时间范围连贯输入 */}
            <div className="flex items-center gap-1.5">
              <input
                id="start-date-filter"
                aria-label="Start Date"
                type="datetime-local"
                value={filters.startDate}
                onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
                className={cn(
                  "h-8.5 px-2 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                  "text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                  "w-[175px] cursor-pointer"
                )}
              />
              <span className="text-xs text-text-muted select-none">~</span>
              <input
                id="end-date-filter"
                aria-label="End Date"
                type="datetime-local"
                value={filters.endDate}
                onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
                className={cn(
                  "h-8.5 px-2 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                  "text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                  "w-[175px] cursor-pointer"
                )}
              />
            </div>
            
            {/* 重置按钮 */}
            <Button 
              variant="secondary" 
              onClick={handleResetFilters}
              icon="restart_alt"
              className="h-8.5 px-2.5 text-xs rounded-lg gap-1 shrink-0"
            >
              Reset
            </Button>
          </div>

          {/* 右侧明细记录统计 */}
          <div className="text-xs text-text-muted font-medium ml-auto hidden sm:block">
            {pagination.totalItems > 0 ? (
              <span>
                {translate("Total")}: <span className="font-mono text-text-main font-semibold">{pagination.totalItems.toLocaleString()}</span>
              </span>
            ) : null}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px]">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5">
                <th className="text-left p-4 text-sm font-semibold text-text-main">Timestamp</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Model</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Provider</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Input Tokens</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cached</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Output Tokens</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Latency</th>
                <th className="text-center p-4 text-sm font-semibold text-text-main">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="8" className="p-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                      Loading...
                    </div>
                  </td>
                </tr>
              ) : details.length === 0 ? (
                <tr>
                  <td colSpan="8" className="p-8 text-center text-text-muted">
                    No request details found
                  </td>
                </tr>
              ) : (
                details.map((detail, index) => (
                  <tr
                    key={`${detail.id}-${index}`}
                    className="border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="whitespace-nowrap p-4 text-sm text-text-main">
                      {new Date(detail.timestamp).toLocaleString()}
                    </td>
                    <td className="max-w-[260px] truncate p-4 font-mono text-sm text-text-main">
                      <div className="flex items-center gap-1.5">
                        {detail.status === "error" && (
                          <span className="inline-block shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-sans font-semibold text-red-600 dark:text-red-400">
                            ERROR
                          </span>
                        )}
                        <span className="truncate">{detail.model}</span>
                      </div>
                    </td>
                    <td className="max-w-[180px] truncate p-4 text-sm text-text-main">
                       <span className="font-medium">
                         {getProviderName(detail.provider, providerNameCache)}
                       </span>
                     </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getInputTokens(detail.tokens).toLocaleString()}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getCachedTokens(detail.tokens) > 0 ? getCachedTokens(detail.tokens).toLocaleString() : "—"}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getOutputTokens(detail.tokens).toLocaleString()}
                    </td>
                    <td className="p-4 text-sm text-text-muted">
                      <div className="flex flex-col gap-0.5">
                        <div>TTFT: <span className="font-mono">{detail.latency?.ttft || 0} ms</span></div>
                        <div>{translate("Total")}: <span className="font-mono">{detail.latency?.total || 0} ms</span></div>
                      </div>
                    </td>
                    <td className="p-4 text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleViewDetail(detail)}
                      >
                        Detail
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && details.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        )}
      </Card>

      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        title="Request Details"
        width="lg"
      >
        {selectedDetail && (
          <div className="space-y-6">
            <div className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div>
                <span className="text-text-muted">ID:</span>{" "}
                <span className="break-all font-mono text-text-main">{selectedDetail.id}</span>
              </div>
              <div>
                <span className="text-text-muted">Timestamp:</span>{" "}
                <span className="text-text-main">{new Date(selectedDetail.timestamp).toLocaleString()}</span>
              </div>
              <div>
                 <span className="text-text-muted">Provider:</span>{" "}
                 <span className="text-text-main font-medium">{getProviderName(selectedDetail.provider, providerNameCache)}</span>
               </div>
              <div>
                <span className="text-text-muted">Model:</span>{" "}
                <span className="text-text-main font-mono">{selectedDetail.model}</span>
              </div>
              <div>
                <span className="text-text-muted">Status:</span>{" "}
                <span className={cn(
                  "font-medium",
                  selectedDetail.status === "success" ? "text-green-600" : "text-red-600"
                )}>
                  {selectedDetail.status === "success" ? translate("Success") : translate("Failed")}
                </span>
              </div>
              <div>
                <span className="text-text-muted">Latency:</span>{" "}
                <span className="text-text-main font-mono">
                  TTFT {selectedDetail.latency?.ttft || 0} ms / {translate("Total")} {selectedDetail.latency?.total || 0} ms
                </span>
              </div>
              <div>
                <span className="text-text-muted">Input Tokens:</span>{" "}
                <span className="text-text-main font-mono">
                  {getInputTokens(selectedDetail.tokens).toLocaleString()}
                </span>
              </div>
              {getCachedTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-text-muted">Cached Tokens:</span>{" "}
                  <span className="text-text-main font-mono">
                    {getCachedTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              {getCacheCreationTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-text-muted">Cache Creation:</span>{" "}
                  <span className="text-text-main font-mono">
                    {getCacheCreationTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              <div>
                <span className="text-text-muted">Output Tokens:</span>{" "}
                <span className="text-text-main font-mono">
                  {getOutputTokens(selectedDetail.tokens).toLocaleString()}
                </span>
              </div>
            </div>

            {selectedDetail.status === "error" && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-red-600 dark:text-red-400">
                <div className="flex items-center gap-2 mb-2 font-semibold text-sm">
                  <span className="material-symbols-outlined text-[20px]">error</span>
                  <span>Request Failed {selectedDetail.response?.status ? `(${selectedDetail.response.status})` : ""}</span>
                </div>
                <div className="rounded border border-red-500/15 bg-black/5 dark:bg-black/20 p-3 font-mono text-xs break-all leading-relaxed">
                  {selectedDetail.response?.error || selectedDetail.error || "Unknown error occurred"}
                </div>
              </div>
            )}

            {selectedDetail.pxpipe && (
              <div className="rounded-lg border border-black/5 dark:border-white/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-[18px] text-text-muted">image</span>
                  <span className="font-semibold text-sm text-text-main">PXPIPE</span>
                  <span className={cn(
                    "text-xs px-2 py-0.5 rounded",
                    selectedDetail.pxpipe.applied
                      ? "bg-green-500/15 text-green-600"
                      : "bg-amber-500/15 text-amber-600"
                  )}>
                    {selectedDetail.pxpipe.applied ? "Activated" : "Skipped"}
                  </span>
                </div>
                {selectedDetail.pxpipe.applied ? (
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div>
                      <span className="text-text-muted block text-xs">Original (est.)</span>
                      <span className="font-mono">{(selectedDetail.pxpipe.tokensBeforeEst || 0).toLocaleString()} tokens</span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Compressed (est.)</span>
                      <span className="font-mono">{(selectedDetail.pxpipe.tokensAfterEst || 0).toLocaleString()} tokens</span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Saved</span>
                      <span className="font-mono text-green-600">{selectedDetail.pxpipe.savedPct || 0}%</span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Images</span>
                      <span className="font-mono">{selectedDetail.pxpipe.imageCount || 0} ({selectedDetail.pxpipe.durationMs || 0}ms)</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">
                    Reason: <span className="font-mono">{selectedDetail.pxpipe.reason}</span>
                    {selectedDetail.pxpipe.detail ? ` — ${selectedDetail.pxpipe.detail}` : ""}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-4">
              <CollapsibleSection title="1. Client Request (Input)" defaultOpen={true} icon="input">
                <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
                  {JSON.stringify(selectedDetail.request, null, 2)}
                </pre>
              </CollapsibleSection>

              {selectedDetail.providerRequest && (
                <CollapsibleSection title="2. Provider Request (Translated)" icon="translate">
                  <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
                    {JSON.stringify(selectedDetail.providerRequest, null, 2)}
                  </pre>
                </CollapsibleSection>
              )}

              {selectedDetail.providerResponse && (
                <CollapsibleSection
                  title={`3. Provider Response (Raw)${selectedDetail.status === "error" ? " [Error Details]" : ""}`}
                  defaultOpen={selectedDetail.status === "error"}
                  icon="data_object"
                >
                  <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
                    {typeof selectedDetail.providerResponse === 'object'
                      ? JSON.stringify(selectedDetail.providerResponse, null, 2)
                      : selectedDetail.providerResponse
                    }
                  </pre>
                </CollapsibleSection>
              )}
              
              <CollapsibleSection title="4. Client Response (Final)" defaultOpen={true} icon="output">
                {selectedDetail.status === "error" ? (
                  <div>
                    <h4 className="font-semibold text-red-500 mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide">
                      <span className="material-symbols-outlined text-[16px]">warning</span>
                      Error Response
                    </h4>
                    <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-red-500/20 bg-red-500/5 p-3 font-mono text-xs text-red-600 dark:text-red-400 sm:p-4">
                      {JSON.stringify(selectedDetail.response, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <>
                    {selectedDetail.response?.thinking && (
                      <div className="mb-4">
                        <h4 className="font-semibold text-text-main mb-2 flex items-center gap-2 text-xs uppercase tracking-wide opacity-70">
                          <span className="material-symbols-outlined text-[16px]">psychology</span>
                          Thinking Process
                        </h4>
                        <pre className="max-h-[200px] max-w-full overflow-auto rounded-lg border border-amber-200 bg-amber-50 p-3 font-mono text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 sm:p-4">
                          {selectedDetail.response.thinking}
                        </pre>
                      </div>
                    )}
                    
                    <h4 className="font-semibold text-text-main mb-2 text-xs uppercase tracking-wide opacity-70">
                      Content
                    </h4>
                    <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
                      {selectedDetail.response?.content || (selectedDetail.response?.redacted ? translate("[Redacted]") : translate("[No content]"))}
                    </pre>
                  </>
                )}
              </CollapsibleSection>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
