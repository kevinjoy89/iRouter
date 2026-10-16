"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import useProviderStore from "@/store/providerStore";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getModelsByProviderId } from "@/shared/constants/models";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { useSpeedtestI18n } from "../i18n";
import type { BatchSpeedtestItem, SpeedtestProtocol } from "../types";

/**
 * 表单组件属性接口
 *
 * @author iRouter
 * @since 2026-10-16
 */
export interface SpeedtestConfigFormProps {
  onStartBatch: (items: BatchSpeedtestItem[]) => void;
  isRunning?: boolean;
  onAbort?: () => void;
  initialModel?: string;
  initialProvider?: string;
}

/**
 * 连接资产展示结构
 */
interface ConnectionOption {
  id: string;
  provider: string;
  prefix: string;
  vendorName: string;
  keyName: string;
  fullDisplayName: string;
  authType: string;
  isActive: boolean;
  customModels?: string[];
  providerSpecificData?: {
    prefix?: string;
    nodeName?: string;
    baseUrl?: string;
    apiKey?: string;
  };
}

/**
 * 模型选项结构
 */
interface ModelOption {
  id: string;
  name: string;
}

/**
 * 解析并获取连接对应的标准路由模型前缀（如 agnes, sensenova, ocsg, deepseek 等）
 *
 * @param c 连接对象
 * @param nodes 节点列表
 * @return 规范化的模型前缀
 * @author iRouter
 * @since 2026-10-16
 */
function resolveProviderPrefix(
  c: {
    provider?: string;
    providerSpecificData?: { prefix?: string; nodeName?: string };
  },
  nodes: Array<{ id?: string; name?: string; prefix?: string; data?: { prefix?: string } | string }> = []
): string {
  // 1. 优先从连接的 providerSpecificData.prefix 读取（用户在兼容提供商中填写的路由前缀，如 agnes）
  if (c.providerSpecificData?.prefix && typeof c.providerSpecificData.prefix === "string") {
    const p = c.providerSpecificData.prefix.trim().toLowerCase();
    if (p) return p;
  }

  const pId = c.provider || "openai";

  // 2. 从关联的 providerNodes 中查找对应节点的 prefix
  const matchedNode = nodes.find((n) => n.id === pId);
  if (matchedNode) {
    if (matchedNode.prefix && typeof matchedNode.prefix === "string") {
      const p = matchedNode.prefix.trim().toLowerCase();
      if (p) return p;
    }
    try {
      const nodeData = (typeof matchedNode.data === "string"
        ? JSON.parse(matchedNode.data || "{}")
        : matchedNode.data) as { prefix?: string } | undefined;
      if (nodeData?.prefix && typeof nodeData.prefix === "string") {
        const p = nodeData.prefix.trim().toLowerCase();
        if (p) return p;
      }
    } catch {
      // 忽略 JSON 解析异常
    }
  }

  // 3. 检查是否为标准内置供应商（AI_PROVIDERS）
  if (AI_PROVIDERS[pId as keyof typeof AI_PROVIDERS]) {
    return pId.toLowerCase();
  }

  // 4. 若为兼容提供商 UUID（形如 openai-compatible-chat-...），取节点名称转换为小写 slug
  if (pId.startsWith("openai-compatible") || pId.startsWith("anthropic-compatible")) {
    const rawName = matchedNode?.name || c.providerSpecificData?.nodeName || "";
    if (rawName) {
      const slug = rawName.replace(/ai$/i, "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (slug) return slug;
    }
  }

  return pId.toLowerCase();
}

/**
 * 解析并生成标准的“供应商名称 · Key名称”
 *
 * @param c 连接对象
 * @param nodes 节点列表
 * @return 供应商名称和 Key 名称
 * @author iRouter
 * @since 2026-10-16
 */
function resolveVendorAndKeyName(
  c: {
    provider?: string;
    name?: string;
    providerSpecificData?: { nodeName?: string };
  },
  nodes: Array<{ id?: string; name?: string }> = []
) {
  const pId = c.provider || "openai";
  const keyName = c.name || "Default Key";

  // 1. 优先从 providerNodes 自定义节点中查找（例如 OpenCode Go 等）
  const matchedNode = nodes.find((n) => n.id === pId);
  if (matchedNode?.name) {
    return { vendorName: matchedNode.name, keyName };
  }

  // 2. 检查连接自带的节点名称
  if (c.providerSpecificData?.nodeName) {
    return { vendorName: c.providerSpecificData.nodeName, keyName };
  }

  // 3. 从标准内置供应商表中查找（例如 OpenCSG, DeepSeek, OpenAI 等）
  const std = AI_PROVIDERS[pId as keyof typeof AI_PROVIDERS];
  if (std?.name) {
    return { vendorName: std.name, keyName };
  }

  // 4. 处理常见前缀与回退格式化
  let clean = pId
    .replace(/^openai-compatible-/, "")
    .replace(/^anthropic-compatible-/, "")
    .replace(/-/g, " ");
  clean = clean.charAt(0).toUpperCase() + clean.slice(1);

  return { vendorName: clean, keyName };
}

/**
 * 专业基准评测配置控制台组件 (TSX)
 *
 * @author iRouter
 * @since 2026-10-16
 */
export default function SpeedtestConfigForm({
  onStartBatch,
  isRunning = false,
  onAbort,
  initialModel,
  initialProvider,
}: SpeedtestConfigFormProps) {
  const { t } = useSpeedtestI18n();

  const { providers, fetchProviders } = useProviderStore() as unknown as {
    providers: Array<{
      _id?: string;
      id?: string;
      name?: string;
      provider?: string;
      authType?: string;
      isActive?: boolean;
      customModels?: string[];
      baseUrl?: string;
      providerSpecificData?: { nodeName?: string; baseUrl?: string; apiKey?: string };
    }>;
    fetchProviders: () => Promise<void>;
  };

  const [providerNodes, setProviderNodes] = useState<Array<{ id: string; name: string }>>([]);
  const [mode, setMode] = useState<"stored" | "custom">("stored");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>(initialModel || "");
  const [compareGateway, setCompareGateway] = useState<boolean>(true);
  const [isResolvingTarget, setIsResolvingTarget] = useState<boolean>(false);
  const [loadingModels, setLoadingModels] = useState<boolean>(false);
  const [providerModels, setProviderModels] = useState<ModelOption[]>([]);

  // 供应商下拉与模型下拉浮层状态
  const [isProviderDropdownOpen, setIsProviderDropdownOpen] = useState<boolean>(false);
  const [providerSearch, setProviderSearch] = useState<string>("");
  const providerDropdownRef = useRef<HTMLDivElement>(null);

  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState<boolean>(false);
  const [modelSearch, setModelSearch] = useState<string>("");
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // 协议选择下拉状态（全宽，支持未来持续扩充更多协议）
  const [isProtocolDropdownOpen, setIsProtocolDropdownOpen] = useState<boolean>(false);
  const protocolDropdownRef = useRef<HTMLDivElement>(null);

  // 自定义端点参数（URL 与模型标识均不预填任何内容）
  const [customTargetUrl, setCustomTargetUrl] = useState<string>("");
  const [customProtocol, setCustomProtocol] = useState<SpeedtestProtocol>("openai");
  const [customApiKey, setCustomApiKey] = useState<string>("");
  const [customModel, setCustomModel] = useState<string>("");
  const [showApiKey, setShowApiKey] = useState<boolean>(false);

  // 场景与参数微调
  const [selectedPresetId, setSelectedPresetId] = useState<string>("throughput-1500");
  const [activePrompt, setActivePrompt] = useState<string>(
    "请详细阐述现代分布式微服务架构中，CAP 定理的实际权衡与主流最终一致性实现方案（如 Saga 模式、TCC 事务及本地消息表），并深入分析在高并发跨机房部署场景下的高可用容灾设计原则。要求结构严谨、包含详细技术选型对比，篇幅约 1500 字"
  );
  const [maxTokens, setMaxTokens] = useState<number>(2048);
  const [temperature, setTemperature] = useState<number>(0.7);

  // 待测对比队列
  const [batchItems, setBatchItems] = useState<BatchSpeedtestItem[]>([]);

  // 获取 providers 与 provider-nodes
  useEffect(() => {
    fetchProviders();
    fetch("/api/provider-nodes")
      .then((res) => (res.ok ? res.json() : { nodes: [] }))
      .then((data) => setProviderNodes(data.nodes || []))
      .catch(() => {});
  }, [fetchProviders]);

  // 点击外部收起浮层
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (providerDropdownRef.current && !providerDropdownRef.current.contains(e.target as Node)) {
        setIsProviderDropdownOpen(false);
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setIsModelDropdownOpen(false);
      }
      if (protocolDropdownRef.current && !protocolDropdownRef.current.contains(e.target as Node)) {
        setIsProtocolDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 格式化全量连接列表，统一显示为 "供应商名称 · Key名称"
  const connectionOptions: ConnectionOption[] = useMemo(() => {
    if (!providers || !Array.isArray(providers)) return [];
    return providers.map((p) => {
      const connId = p.id || p._id || "";
      const pId = p.provider || "openai";
      const { vendorName, keyName } = resolveVendorAndKeyName(p, providerNodes);
      const prefix = resolveProviderPrefix(p, providerNodes);
      return {
        id: connId,
        provider: pId,
        prefix,
        vendorName,
        keyName,
        fullDisplayName: `${vendorName} · ${keyName}`,
        authType: p.authType || "API Key",
        isActive: p.isActive !== false,
        customModels: p.customModels || [],
        providerSpecificData: p.providerSpecificData,
      };
    });
  }, [providers, providerNodes]);

  // 默认初始选中项
  useEffect(() => {
    if (connectionOptions.length > 0 && !selectedConnectionId) {
      const match = initialProvider
        ? connectionOptions.find(
            (c) =>
              c.provider === initialProvider ||
              c.vendorName === initialProvider ||
              c.fullDisplayName.includes(initialProvider)
          )
        : connectionOptions[0];
      const target = match || connectionOptions[0];
      setSelectedConnectionId(target.id);
    }
  }, [connectionOptions, initialProvider, selectedConnectionId]);

  // 当前激活选中的连接
  const activeConnection = useMemo(() => {
    return connectionOptions.find((c) => c.id === selectedConnectionId) || connectionOptions[0] || null;
  }, [connectionOptions, selectedConnectionId]);

  // 选中供应商后拉取并聚合该供应商的模型列表
  useEffect(() => {
    if (!activeConnection) {
      setProviderModels([]);
      return;
    }

    let isCancelled = false;
    setLoadingModels(true);

    const fallbackModels: ModelOption[] = [];
    const stdModels = getModelsByProviderId(activeConnection.provider) || [];
    stdModels.forEach((m: { id: string; name?: string }) => {
      fallbackModels.push({ id: m.id, name: m.name || m.id });
    });

    if (activeConnection.customModels && activeConnection.customModels.length > 0) {
      activeConnection.customModels.forEach((cm) => {
        if (!fallbackModels.some((m) => m.id === cm)) {
          fallbackModels.push({ id: cm, name: cm });
        }
      });
    }

    // 从后台 API 拉取该连接专属的 live 模型列表
    fetch(`/api/providers/${encodeURIComponent(activeConnection.id)}/models`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isCancelled) return;
        if (data && Array.isArray(data.models) && data.models.length > 0) {
          const fetched: ModelOption[] = data.models.map((m: string | { id: string; name?: string }) => {
            if (typeof m === "string") return { id: m, name: m };
            return { id: m.id, name: m.name || m.id };
          });
          setProviderModels(fetched);
          if (!selectedModel || !fetched.some((m) => m.id === selectedModel)) {
            setSelectedModel(fetched[0].id);
          }
        } else {
          setProviderModels(fallbackModels);
          if (!selectedModel || !fallbackModels.some((m) => m.id === selectedModel)) {
            if (fallbackModels.length > 0) {
              setSelectedModel(fallbackModels[0].id);
            }
          }
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setProviderModels(fallbackModels);
          if (!selectedModel || !fallbackModels.some((m) => m.id === selectedModel)) {
            if (fallbackModels.length > 0) {
              setSelectedModel(fallbackModels[0].id);
            }
          }
        }
      })
      .finally(() => {
        if (!isCancelled) setLoadingModels(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [activeConnection]);

  /**
   * 切换基准场景预设
   *
   * @param presetId 预设标识
   */
  const handleSelectPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    if (presetId === "ttft-probe") {
      setActivePrompt("请以最简洁的语言输出一段 50 字以内的问候语并汇报当前系统时间");
      setMaxTokens(64);
      setTemperature(0.1);
    } else if (presetId === "throughput-1500") {
      setActivePrompt(
        "请详细阐述现代分布式微服务架构中，CAP 定理的实际权衡与主流最终一致性实现方案（如 Saga 模式、TCC 事务及本地消息表），并深入分析在高并发跨机房部署场景下的高可用容灾设计原则。要求结构严谨、包含详细技术选型对比，篇幅约 1500 字"
      );
      setMaxTokens(2048);
      setTemperature(0.7);
    } else if (presetId === "code-gen") {
      setActivePrompt(
        "请使用 TypeScript 实现一个工业级支持重试机制、指数退避策略与并发上限限制的异步并发任务执行池 TaskPool 类，包含完整参数校验、事件监听机制以及完备的 Vitest 单元测试用例代码"
      );
      setMaxTokens(1500);
      setTemperature(0.2);
    } else {
      setMaxTokens(1024);
      setTemperature(0.7);
    }
  };

  /**
   * 获取指定连接的安全直连配置
   *
   * @param connId 连接标识
   * @return 直连配置对象
   */
  const fetchTargetConfig = async (connId: string) => {
    try {
      const res = await fetch(`/api/speedtest?action=target-config&connectionId=${encodeURIComponent(connId)}`);
      if (!res.ok) throw new Error("获取直连配置失败");
      return await res.json();
    } catch {
      return null;
    }
  };

  /**
   * 构造当前配置生成的条目（支持直连或直连+代理对比）
   *
   * @return 待测条目数组
   */
  const buildCurrentItems = async (): Promise<BatchSpeedtestItem[]> => {
    if (mode === "stored") {
      if (!activeConnection || !selectedModel) return [];

      setIsResolvingTarget(true);
      const targetConfig = await fetchTargetConfig(activeConnection.id);
      setIsResolvingTarget(false);

      const targetUrl = targetConfig?.targetUrl || "https://api.openai.com/v1/chat/completions";
      const protocol: SpeedtestProtocol = (targetConfig?.protocol as SpeedtestProtocol) || "openai";
      const apiKey = targetConfig?.apiKey || "";
      const prefix = activeConnection.prefix || resolveProviderPrefix(activeConnection, providerNodes);
      const rawModel = selectedModel;
      const fullModel = rawModel.includes("/")
        ? rawModel
        : `${prefix}/${rawModel}`;

      // 条目 1：上游直连专线
      const directItem: BatchSpeedtestItem = {
        id: crypto.randomUUID(),
        label: `${fullModel}[${t("directTag")}]`,
        model: fullModel,
        rawModel,
        provider: prefix,
        targetUrl,
        protocol,
        apiKey,
        prompt: activePrompt,
        maxTokens,
        temperature,
        isGateway: false,
        customHeaders: targetConfig?.customHeaders || {},
      };

      if (!compareGateway) {
        return [directItem];
      }

      // 条目 2：经 iRouter 本地代理网关流水线
      const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:20128";
      const gatewayItem: BatchSpeedtestItem = {
        id: crypto.randomUUID(),
        label: `${fullModel}[${t("gatewayTag")}]`,
        model: fullModel,
        rawModel: fullModel,
        provider: prefix,
        targetUrl: `${origin}/v1/chat/completions`,
        protocol: "openai",
        apiKey: targetConfig?.gatewayApiKey || apiKey,
        prompt: activePrompt,
        maxTokens,
        temperature,
        isGateway: true,
        customHeaders: {
          "x-connection-id": activeConnection.id,
        },
      };

      return [directItem, gatewayItem];
    } else {
      if (!customTargetUrl || !customModel) return [];
      const item: BatchSpeedtestItem = {
        id: crypto.randomUUID(),
        label: `${customModel}[${t("directTag")}]`,
        model: customModel,
        provider: "Custom",
        targetUrl: customTargetUrl,
        protocol: customProtocol,
        apiKey: customApiKey,
        prompt: activePrompt,
        maxTokens,
        temperature,
        isGateway: false,
      };
      return [item];
    }
  };

  /**
   * 一键立即执行当前配置
   */
  const handleRunImmediate = async () => {
    const items = await buildCurrentItems();
    if (items.length > 0) {
      onStartBatch(items);
    }
  };

  /**
   * 加入待测对比队列
   */
  const handleAddToBatch = async () => {
    const items = await buildCurrentItems();
    if (items.length > 0) {
      setBatchItems((prev) => [...prev, ...items].slice(0, 6));
    }
  };

  /**
   * 执行对比队列全量评测
   */
  const handleRunBatch = () => {
    if (batchItems.length > 0) {
      onStartBatch(batchItems);
    }
  };

  // 过滤后的供应商选项
  const filteredConnections = connectionOptions.filter((c) => {
    const q = providerSearch.toLowerCase().trim();
    if (!q) return true;
    return (
      c.fullDisplayName.toLowerCase().includes(q) ||
      c.vendorName.toLowerCase().includes(q) ||
      c.keyName.toLowerCase().includes(q)
    );
  });

  // 过滤后的模型列表
  const filteredModels = providerModels.filter((m) => {
    const q = modelSearch.toLowerCase().trim();
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
  });

  // 协议配置定义（支持未来持续扩充更多协议，绝不将 Responses 翻译为响应）
  const PROTOCOL_OPTIONS: Array<{
    value: SpeedtestProtocol;
    name: string;
    path: string;
    label: string;
    desc: string;
    placeholderUrl: string;
  }> = [
    {
      value: "openai",
      name: "OpenAI",
      path: "/chat/completions",
      label: "OpenAI (/chat/completions)",
      desc: "标准 Chat Completions 流式协议，兼容绝大多数大模型服务商与网关",
      placeholderUrl: "https://api.openai.com/v1/chat/completions",
    },
    {
      value: "anthropic",
      name: "Anthropic",
      path: "/v1/messages",
      label: "Anthropic (/v1/messages)",
      desc: "Claude 原生 Messages 流式协议，采用 SSE event/data 规范",
      placeholderUrl: "https://api.anthropic.com/v1/messages",
    },
    {
      value: "responses",
      name: "OpenAI Responses",
      path: "/v1/responses",
      label: "OpenAI Responses (/v1/responses)",
      desc: "OpenAI 新一代 Responses 流式接口规范",
      placeholderUrl: "https://api.openai.com/v1/responses",
    },
  ];

  // 当前激活的协议配置项
  const currentProtocolOpt =
    PROTOCOL_OPTIONS.find((p) => p.value === customProtocol) || PROTOCOL_OPTIONS[0];

  /**
   * 切换协议（仅更新协议类型，严禁自动预填/篡改用户 URL）
   *
   * @param nextProto 目标协议类型
   */
  const handleSelectProtocol = (nextProto: SpeedtestProtocol) => {
    setCustomProtocol(nextProto);
    setIsProtocolDropdownOpen(false);
  };

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-5 rounded-2xl bg-surface border border-border shadow-[var(--shadow-warm)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.5)] transition-colors">
      {/* 头部：自适应全宽流式交互控制台头部 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border">
        {/* 左侧：标题与控制台说明 */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-8 rounded-lg bg-primary/10 text-primary border border-primary/20 shrink-0">
            <span className="material-symbols-outlined text-lg">speed</span>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-sm font-bold tracking-tight text-text-main uppercase whitespace-nowrap">
              {t("consoleTitle")}
            </h2>
            <span className="text-[11px] text-text-muted font-sans hidden sm:inline">
              {t("consoleSubtitle")}
            </span>
          </div>
        </div>

        {/* 右侧：紧凑模式切换胶囊 */}
        <div className="inline-flex p-1 rounded-xl bg-surface-2 border border-border text-xs shrink-0 self-start sm:self-auto">
          <button
            type="button"
            className={`py-1.5 px-3.5 rounded-lg font-medium transition-all text-center whitespace-nowrap ${
              mode === "stored"
                ? "bg-surface text-primary font-semibold shadow-sm"
                : "text-text-muted hover:text-text-main"
            }`}
            onClick={() => setMode("stored")}
          >
            {t("modeStored")}
          </button>
          <button
            type="button"
            className={`py-1.5 px-3.5 rounded-lg font-medium transition-all text-center whitespace-nowrap ${
              mode === "custom"
                ? "bg-surface text-primary font-semibold shadow-sm"
                : "text-text-muted hover:text-text-main"
            }`}
            onClick={() => setMode("custom")}
          >
            {t("modeCustom")}
          </button>
        </div>
      </div>

      {/* 模式一：已存供应商资产联动（双列全宽自适应排版） */}
      {mode === "stored" ? (
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* 供应商选择卡片：精准紧贴定位（零错位） */}
            <div className="flex flex-col gap-1.5" ref={providerDropdownRef}>
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium tracking-wider text-text-muted uppercase">
                {t("selectProvider")}
              </label>
              <span className="text-[10px] text-text-muted font-mono">
                {connectionOptions.length} {t("availableCredentials")}
              </span>
            </div>

            <div className="relative w-full">
              {/* 触发器主卡片（固定 min-h-[58px] 保证与右侧模型卡片等高对称） */}
              <div
                className={`flex items-center justify-between p-2.5 sm:p-3 rounded-xl bg-surface-2 border transition-all cursor-pointer select-none hover:border-primary/50 w-full min-h-[58px] ${
                  isProviderDropdownOpen ? "border-primary ring-2 ring-primary/20" : "border-border"
                }`}
                onClick={() => setIsProviderDropdownOpen(!isProviderDropdownOpen)}
              >
                {activeConnection ? (
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex items-center justify-center size-8 rounded-lg bg-surface border border-border p-1 shrink-0">
                      <ProviderIcon
                        src=""
                        alt={activeConnection.vendorName}
                        fallbackColor=""
                        providerId={activeConnection.provider}
                        size={22}
                      />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs sm:text-sm font-semibold text-text-main truncate">
                        {activeConnection.fullDisplayName}
                      </span>
                      <span className="text-[10px] text-text-muted font-mono">
                        {activeConnection.authType}
                      </span>
                    </div>
                  </div>
                ) : (
                  <span className="text-xs text-text-muted">{t("noMatchingProviders")}</span>
                )}

                <span
                  className={`material-symbols-outlined text-text-muted text-lg transition-transform duration-200 shrink-0 ${
                    isProviderDropdownOpen ? "rotate-180 text-primary" : ""
                  }`}
                >
                  expand_more
                </span>
              </div>

              {/* 供应商下拉浮层：严格与触发器对齐（left-0 right-0 top-full mt-1.5 w-full） */}
              {isProviderDropdownOpen && (
                <div className="absolute z-50 left-0 right-0 top-full mt-1.5 w-full p-2 rounded-xl bg-surface border border-border shadow-2xl backdrop-blur-2xl flex flex-col gap-1.5">
                  <input
                    type="text"
                    className="w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-main placeholder-text-muted focus:outline-none focus:border-primary"
                    placeholder={t("searchProviderPlaceholder")}
                    value={providerSearch}
                    onChange={(e) => setProviderSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />

                  <div className="max-h-56 overflow-y-auto divide-y divide-border/50">
                    {filteredConnections.length > 0 ? (
                      filteredConnections.map((c) => (
                        <div
                          key={c.id}
                          className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors ${
                            c.id === selectedConnectionId
                              ? "bg-primary/10 text-primary font-medium"
                              : "hover:bg-surface-2 text-text-main"
                          }`}
                          onClick={() => {
                            setSelectedConnectionId(c.id);
                            setIsProviderDropdownOpen(false);
                          }}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="size-6 rounded bg-surface-2 p-0.5 shrink-0 flex items-center justify-center">
                              <ProviderIcon
                                src=""
                                alt={c.vendorName}
                                fallbackColor=""
                                providerId={c.provider}
                                size={16}
                              />
                            </div>
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs truncate">{c.fullDisplayName}</span>
                              <span className="text-[10px] text-text-muted font-mono">{c.authType}</span>
                            </div>
                          </div>
                          {c.id === selectedConnectionId && (
                            <span className="material-symbols-outlined text-primary text-base shrink-0">check</span>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="py-4 text-center text-xs text-text-muted">
                        {t("noMatchingProviders")}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 模型选择：精准紧贴定位（零错位） */}
          <div className="flex flex-col gap-1.5" ref={modelDropdownRef}>
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium tracking-wider text-text-muted uppercase">
                {t("selectModel")}
              </label>
              <span className="text-[10px] text-text-muted font-mono">
                {loadingModels ? t("loadingModels") : `${providerModels.length} ${t("modelsCount")}`}
              </span>
            </div>

            <div className="relative w-full">
              {/* 定制高颜值模型选择触发器（与供应商选择卡片 100% 结构等高、双行排版与视觉对称） */}
              <div
                className={`flex items-center justify-between p-2.5 sm:p-3 rounded-xl bg-surface-2 border transition-all cursor-pointer select-none hover:border-primary/50 w-full min-h-[58px] ${
                  isModelDropdownOpen ? "border-primary ring-2 ring-primary/20" : "border-border"
                }`}
                onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex items-center justify-center size-8 rounded-lg bg-surface border border-border p-1 shrink-0 text-primary">
                    <span className="material-symbols-outlined text-lg">smart_toy</span>
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span
                      className="text-xs sm:text-sm font-semibold font-mono text-text-main truncate"
                      title={
                        selectedModel
                          ? selectedModel.includes("/")
                            ? selectedModel
                            : `${activeConnection?.prefix || "model"}/${selectedModel}`
                          : ""
                      }
                    >
                      {selectedModel
                        ? selectedModel.includes("/")
                          ? selectedModel
                          : `${activeConnection?.prefix || "model"}/${selectedModel}`
                        : loadingModels
                        ? t("loadingModels")
                        : t("noMatchingModels")}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono truncate">
                      {selectedModel
                        ? `${activeConnection?.vendorName || "目标供应商"} · 参测模型`
                        : loadingModels
                        ? "正在拉取..."
                        : "暂无可用模型"}
                    </span>
                  </div>
                </div>

                <span
                  className={`material-symbols-outlined text-text-muted text-lg transition-transform duration-200 shrink-0 ${
                    isModelDropdownOpen ? "rotate-180 text-primary" : ""
                  }`}
                >
                  expand_more
                </span>
              </div>

              {/* 定制高颜值模型下拉浮层：严格与触发器对齐（left-0 right-0 top-full mt-1.5 w-full） */}
              {isModelDropdownOpen && (
                <div className="absolute z-50 left-0 right-0 top-full mt-1.5 w-full p-2 rounded-xl bg-surface border border-border shadow-2xl backdrop-blur-2xl flex flex-col gap-1.5">
                  <input
                    type="text"
                    className="w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-main placeholder-text-muted focus:outline-none focus:border-primary font-mono"
                    placeholder={t("searchModelPlaceholder")}
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />

                  <div className="max-h-56 overflow-y-auto divide-y divide-border/50">
                    {filteredModels.length > 0 ? (
                      filteredModels.map((m) => {
                        const fullOptionModel = m.id.includes("/")
                          ? m.id
                          : `${activeConnection?.prefix || "model"}/${m.id}`;
                        return (
                          <div
                            key={m.id}
                            className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors ${
                              m.id === selectedModel
                                ? "bg-primary/10 text-primary font-semibold"
                                : "hover:bg-surface-2 text-text-main"
                            }`}
                            onClick={() => {
                              setSelectedModel(m.id);
                              setIsModelDropdownOpen(false);
                            }}
                          >
                            <div className="flex flex-col min-w-0 font-mono">
                              <span className="text-xs truncate">{fullOptionModel}</span>
                              {m.name && m.name !== m.id && (
                                <span className="text-[10px] text-text-muted truncate">{m.name}</span>
                              )}
                            </div>
                            {m.id === selectedModel && (
                              <span className="material-symbols-outlined text-primary text-base shrink-0">check</span>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <div className="py-4 text-center text-xs text-text-muted">
                        {t("noMatchingModels")}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 直连 vs 本地代理网关损耗开关 */}
          <div
            className={`flex items-start gap-2.5 p-3 rounded-xl border transition-all cursor-pointer select-none ${
              compareGateway
                ? "bg-primary/5 border-primary/30"
                : "bg-surface-2/60 border-border hover:border-border-subtle"
            }`}
            onClick={() => setCompareGateway(!compareGateway)}
          >
            <div className="pt-0.5 shrink-0">
              <input
                type="checkbox"
                id="compare-gateway-check"
                className="size-4 rounded border-border text-primary focus:ring-0 bg-surface cursor-pointer"
                checked={compareGateway}
                onChange={(e) => setCompareGateway(e.target.checked)}
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-text-main flex items-center gap-1.5 flex-wrap">
                {t("compareGateway")}
                <span className="text-[9px] px-1.5 py-0.2 rounded bg-primary/10 text-primary font-mono">
                  {t("compareGatewayBadge")}
                </span>
              </span>
              <p className="text-[11px] text-text-muted leading-relaxed">
                {t("compareGatewayDesc")}
              </p>
            </div>
          </div>
        </div>
      ) : (
        /* 模式二：自定义端点（双行双列标准对称排版，高度基线100%对齐） */
        <div className="flex flex-col gap-3.5">
          {/* 第一行：传输协议 与 目标端点 URL */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* 1. 传输协议：标准 h-11 等高选择器 */}
            <div className="flex flex-col gap-1.5" ref={protocolDropdownRef}>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                  {t("protocol")}
                </label>
                <span className="text-[10px] text-text-muted font-mono">
                  {PROTOCOL_OPTIONS.length} 个协议支持
                </span>
              </div>

              <div className="relative w-full">
                {/* 下拉触发卡片：统一 h-11 高度 */}
                <div
                  className={`flex items-center justify-between px-3 h-11 rounded-xl bg-surface-2 border transition-all cursor-pointer select-none hover:border-primary/50 w-full ${
                    isProtocolDropdownOpen ? "border-primary ring-2 ring-primary/20" : "border-border"
                  }`}
                  onClick={() => setIsProtocolDropdownOpen(!isProtocolDropdownOpen)}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex items-center justify-center size-7 rounded-lg bg-surface border border-border shrink-0 text-primary">
                      <span className="material-symbols-outlined text-base">sync_alt</span>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs sm:text-sm font-semibold text-text-main truncate">
                        {currentProtocolOpt.name}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-surface border border-border text-primary font-mono font-medium shrink-0">
                        {currentProtocolOpt.path}
                      </span>
                    </div>
                  </div>

                  <span
                    className={`material-symbols-outlined text-text-muted text-lg transition-transform duration-200 shrink-0 ${
                      isProtocolDropdownOpen ? "rotate-180 text-primary" : ""
                    }`}
                  >
                    expand_more
                  </span>
                </div>

                {/* 下拉浮层：全宽，支持纵向滚动 */}
                {isProtocolDropdownOpen && (
                  <div className="absolute z-50 left-0 right-0 top-full mt-1.5 w-full p-1.5 rounded-xl bg-surface border border-border shadow-2xl backdrop-blur-2xl flex flex-col gap-1 max-h-64 overflow-y-auto">
                    {PROTOCOL_OPTIONS.map((opt) => (
                      <div
                        key={opt.value}
                        className={`flex items-center justify-between p-2.5 rounded-lg cursor-pointer transition-colors ${
                          customProtocol === opt.value
                            ? "bg-primary/10 text-primary font-medium"
                            : "hover:bg-surface-2 text-text-main"
                        }`}
                        onClick={() => handleSelectProtocol(opt.value)}
                      >
                        <div className="flex flex-col min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold">{opt.name}</span>
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-surface-2 text-text-muted font-mono border border-border">
                              {opt.path}
                            </span>
                          </div>
                          <span className="text-[10px] text-text-muted truncate mt-0.5">
                            {opt.desc}
                          </span>
                        </div>
                        {customProtocol === opt.value && (
                          <span className="material-symbols-outlined text-primary text-base shrink-0 ml-2">check</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 2. 目标端点 URL：统一 h-11 高度，与协议选择器绝对对齐 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                  {t("targetUrl")}
                </label>
                <span className="text-[10px] text-amber-500/80 font-mono">
                  {t("required")}
                </span>
              </div>
              <div className="relative flex items-center">
                <span className="absolute left-3 material-symbols-outlined text-text-muted text-base pointer-events-none">
                  link
                </span>
                <input
                  type="text"
                  className="w-full h-11 pl-9 pr-8 bg-surface-2 border border-border rounded-xl text-xs text-text-main font-mono focus:outline-none focus:border-primary placeholder:text-text-muted/60 transition-colors"
                  placeholder={`如 ${currentProtocolOpt.placeholderUrl}`}
                  value={customTargetUrl}
                  onChange={(e) => setCustomTargetUrl(e.target.value)}
                />
                {customTargetUrl && (
                  <button
                    type="button"
                    className="absolute right-2 p-1 text-text-muted hover:text-text-main rounded-full"
                    onClick={() => setCustomTargetUrl("")}
                    title={t("clear")}
                  >
                    <span className="material-symbols-outlined text-sm">close</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 第二行：模型标识 与 API Key（统一 h-11 等高） */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* 3. 模型标识 (MODEL)：统一 h-11 高度 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                  {t("modelId")}
                </label>
                <span className="text-[10px] text-amber-500/80 font-mono">
                  {t("required")}
                </span>
              </div>
              <div className="relative flex items-center">
                <span className="absolute left-3 material-symbols-outlined text-text-muted text-base pointer-events-none">
                  smart_toy
                </span>
                <input
                  type="text"
                  className="w-full h-11 pl-9 pr-8 bg-surface-2 border border-border rounded-xl text-xs text-text-main font-mono focus:outline-none focus:border-primary placeholder:text-text-muted/60 transition-colors"
                  placeholder="如 gpt-4o, claude-3-5-sonnet, deepseek-chat"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                />
                {customModel && (
                  <button
                    type="button"
                    className="absolute right-2 p-1 text-text-muted hover:text-text-main rounded-full"
                    onClick={() => setCustomModel("")}
                    title={t("clear")}
                  >
                    <span className="material-symbols-outlined text-sm">close</span>
                  </button>
                )}
              </div>
            </div>

            {/* 4. API Key 输入框：统一 h-11 高度 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                  {t("apiKey")}
                </label>
                <span className="text-[10px] text-emerald-500/80 font-mono">
                  {t("memoryOnly")}
                </span>
              </div>
              <div className="relative flex items-center">
                <span className="absolute left-3 material-symbols-outlined text-text-muted text-base pointer-events-none">
                  key
                </span>
                <input
                  type={showApiKey ? "text" : "password"}
                  className="w-full h-11 pl-9 pr-16 bg-surface-2 border border-border rounded-xl text-xs text-text-main font-mono focus:outline-none focus:border-primary transition-colors"
                  placeholder="sk-..."
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                />
                <div className="absolute right-2 flex items-center gap-1">
                  {customApiKey && (
                    <button
                      type="button"
                      className="p-1 text-text-muted hover:text-text-main rounded-full"
                      onClick={() => setCustomApiKey("")}
                      title={t("clear")}
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="p-1 text-text-muted hover:text-text-main rounded transition-colors"
                    onClick={() => setShowApiKey(!showApiKey)}
                    title={showApiKey ? t("hideApiKey") : t("showApiKey")}
                  >
                    <span className="material-symbols-outlined text-sm">
                      {showApiKey ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 基准评测场景预设 */}
      <div className="flex flex-col gap-2.5 pt-2 border-t border-border">
        <label className="text-[11px] font-medium tracking-wider text-text-muted uppercase">
          {t("benchmarkPreset")}
        </label>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {/* 首包探针 */}
          <div
            className={`flex flex-col gap-0.5 p-2 rounded-xl border transition-all cursor-pointer select-none ${
              selectedPresetId === "ttft-probe"
                ? "bg-primary/10 border-primary text-primary"
                : "bg-surface-2/60 border-border hover:border-border-subtle text-text-muted hover:text-text-main"
            }`}
            onClick={() => handleSelectPreset("ttft-probe")}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">bolt</span>
                <span className="text-xs font-semibold">{t("presetTtft")}</span>
              </div>
              <span className="text-[9px] px-1 rounded bg-surface border border-border font-mono">
                TTFT
              </span>
            </div>
            <p className="text-[10px] text-text-muted line-clamp-1">{t("presetTtftDesc")}</p>
          </div>

          {/* 长文吞吐压测 */}
          <div
            className={`flex flex-col gap-0.5 p-2 rounded-xl border transition-all cursor-pointer select-none ${
              selectedPresetId === "throughput-1500"
                ? "bg-primary/10 border-primary text-primary"
                : "bg-surface-2/60 border-border hover:border-border-subtle text-text-muted hover:text-text-main"
            }`}
            onClick={() => handleSelectPreset("throughput-1500")}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">article</span>
                <span className="text-xs font-semibold">{t("presetThroughput")}</span>
              </div>
              <span className="text-[9px] px-1 rounded bg-surface border border-border font-mono">
                1500w
              </span>
            </div>
            <p className="text-[10px] text-text-muted line-clamp-1">{t("presetThroughputDesc")}</p>
          </div>

          {/* 代码生成基准 */}
          <div
            className={`flex flex-col gap-0.5 p-2 rounded-xl border transition-all cursor-pointer select-none ${
              selectedPresetId === "code-gen"
                ? "bg-primary/10 border-primary text-primary"
                : "bg-surface-2/60 border-border hover:border-border-subtle text-text-muted hover:text-text-main"
            }`}
            onClick={() => handleSelectPreset("code-gen")}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">code_blocks</span>
                <span className="text-xs font-semibold">{t("presetCodeGen")}</span>
              </div>
              <span className="text-[9px] px-1 rounded bg-surface border border-border font-mono">
                Logic
              </span>
            </div>
            <p className="text-[10px] text-text-muted line-clamp-1">{t("presetCodeGenDesc")}</p>
          </div>

          {/* 自定义载荷 */}
          <div
            className={`flex flex-col gap-0.5 p-2 rounded-xl border transition-all cursor-pointer select-none ${
              selectedPresetId === "custom"
                ? "bg-primary/10 border-primary text-primary"
                : "bg-surface-2/60 border-border hover:border-border-subtle text-text-muted hover:text-text-main"
            }`}
            onClick={() => handleSelectPreset("custom")}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">tune</span>
                <span className="text-xs font-semibold">{t("presetCustom")}</span>
              </div>
              <span className="text-[9px] px-1 rounded bg-surface border border-border font-mono">
                Custom
              </span>
            </div>
            <p className="text-[10px] text-text-muted line-clamp-1">{t("presetCustomDesc")}</p>
          </div>
        </div>

        {/* 提示词输入框与参数滑块全宽横向联动（仅自定义载荷时展示） */}
        {selectedPresetId === "custom" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 pt-1 animate-in fade-in duration-200">
            {/* 左侧 8 列：提示词输入框 */}
            <div className="lg:col-span-8 flex flex-col gap-1">
              <textarea
                rows={3}
                className="w-full h-full min-h-[76px] px-3 py-2 bg-surface-2 border border-border rounded-xl text-xs text-text-main placeholder-text-muted focus:outline-none focus:border-primary resize-none font-mono"
                placeholder={t("promptPlaceholder")}
                value={activePrompt}
                onChange={(e) => setActivePrompt(e.target.value)}
              />
            </div>

            {/* 右侧 4 列：参数微调滑块 */}
            <div className="lg:col-span-4 flex flex-col justify-between gap-2 p-2.5 rounded-xl bg-surface-2/60 border border-border">
              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[11px] font-mono">
                  <span className="text-text-muted">{t("maxTokens")}</span>
                  <span className="text-primary font-semibold">{maxTokens}</span>
                </div>
                <input
                  type="range"
                  min={16}
                  max={4096}
                  step={16}
                  className="accent-primary h-1 rounded cursor-pointer"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[11px] font-mono">
                  <span className="text-text-muted">{t("temperature")}</span>
                  <span className="text-primary font-semibold">{temperature.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  className="accent-primary h-1 rounded cursor-pointer"
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 待测对比队列卡片 */}
      {batchItems.length > 0 && (
        <div className="flex flex-col gap-2 p-3 rounded-xl bg-surface-2 border border-border">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-text-main flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary animate-pulse" />
              {t("batchQueue")} ({batchItems.length} / 6)
            </span>
            <button
              type="button"
              className="text-[11px] text-red-500 hover:underline"
              onClick={() => setBatchItems([])}
            >
              {t("clearQueue")}
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {batchItems.map((item, idx) => (
              <div
                key={item.id}
                className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-surface border border-border text-xs font-mono"
              >
                <div className="flex items-center gap-2 truncate">
                  <span className="text-text-muted font-bold">{idx + 1}.</span>
                  <span className="text-text-main truncate">{item.label}</span>
                </div>
                <button
                  type="button"
                  className="text-text-muted hover:text-red-500 p-0.5 shrink-0"
                  onClick={() => setBatchItems((prev) => prev.filter((b) => b.id !== item.id))}
                >
                  <span className="material-symbols-outlined text-sm">close</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 底部主操作按钮 */}
      <div className="flex items-center gap-3 pt-1">
        {isRunning ? (
          <button
            type="button"
            className="w-full py-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 font-semibold text-xs tracking-wide transition-all hover:bg-red-500/20 flex items-center justify-center gap-2"
            onClick={onAbort}
          >
            <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
            {t("btnAbort")}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={isResolvingTarget || (mode === "stored" ? loadingModels || !selectedModel : !customModel || !customTargetUrl.trim())}
              className="flex-1 py-2.5 px-5 rounded-xl bg-primary hover:bg-primary/90 text-white font-semibold text-xs tracking-wide transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
              onClick={batchItems.length > 0 ? handleRunBatch : handleRunImmediate}
            >
              <span className="material-symbols-outlined text-base">play_arrow</span>
              {batchItems.length > 0
                ? `${t("btnStartBatch")} (${batchItems.length})`
                : t("btnStartImmediate")}
            </button>

            <button
              type="button"
              disabled={isResolvingTarget || batchItems.length >= 6 || (mode === "stored" ? !selectedModel : !customModel || !customTargetUrl.trim())}
              className="py-2.5 px-4 rounded-xl bg-surface-2 border border-border text-text-main font-medium text-xs transition-colors hover:bg-surface disabled:opacity-50 flex items-center gap-1.5 shrink-0"
              onClick={handleAddToBatch}
              title={t("btnAddQueue")}
            >
              <span className="material-symbols-outlined text-base">queue</span>
              {t("btnAddQueue")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
