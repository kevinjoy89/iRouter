"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import {
  ReactFlow,
  Handle,
  Position,
  Controls,
  BaseEdge,
  getBezierPath,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { buildLayout } from "./topologyLayout";

// Force-stop FE animation if a provider stays active longer than this
const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;

// Kame + electric particles along active edges
const KAME_PARTICLE_COUNT = 6;
const SPARK_COUNT = 5;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getProviderImageUrl(providerId) {
  return getProviderIconSrc(providerId);
}

// Custom provider node - rectangle with image + name
function ProviderNode({ data }) {
  const { label, color, imageUrl, textIcon, active } = data;
  const [imgError, setImgError] = useState(false);
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border-2 transition-all duration-300 bg-bg"
      style={{
        borderColor: active ? color : "var(--color-border)",
        boxShadow: active ? `0 0 16px ${color}40` : "none",
        minWidth: "150px",
      }}
    >
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      {/* Provider icon */}
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}15` }}
      >
        {imageUrl && !imgError ? (
          <img
            src={imageUrl}
            alt={label}
            className="w-6 h-6 rounded-sm object-contain"
            loading="lazy"
            decoding="async"
            onError={() => {
              const m = imageUrl?.match(/^\/providers\/([^/]+)\.png$/i);
              if (m) markProviderIconMissing(m[1]);
              setImgError(true);
            }}
          />
        ) : (
          <span className="text-sm font-bold" style={{ color }}>{textIcon}</span>
        )}
      </div>

      {/* Provider name */}
      <span
        className="text-base font-medium truncate"
        style={{ color: active ? color : "var(--color-text)" }}
      >
        {label}
      </span>

      {/* Active indicator */}
      {active && (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: color }} />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
        </span>
      )}
    </div>
  );
}

ProviderNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// 中心 iRouter 核心节点卡片
function RouterNode({ data }) {
  const powering = (data.activeCount || 0) > 0;
  return (
    <div
      className={`relative z-[1] flex items-center justify-center px-5 py-3 rounded-xl border-2 min-w-[130px] ${
        powering
          ? "topology-router-core border-yellow-300 bg-gradient-to-br from-primary/30 via-yellow-400/20 to-cyan-400/25"
          : "border-primary bg-primary/5 shadow-md"
      }`}
    >
      <Handle type="source" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <img
        src="/logo.png"
        alt="iRouter"
        className={`w-6 h-6 mr-2 object-contain ${powering ? "topology-router-icon" : ""}`}
        loading="lazy"
        decoding="async"
      />
      <span className={`text-sm font-bold ${powering ? "topology-router-label text-yellow-300" : "text-primary"}`}>
        iRouter
      </span>
      {data.activeCount > 0 && (
        <span className="ml-2 px-1.5 py-0.5 rounded-full bg-yellow-400 text-black text-xs font-bold topology-router-badge">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

RouterNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// Active: electric kame beam (multi-layer stroke + sparks). Idle/last/error: solid BaseEdge.
function TopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const active = !!data?.active;
  const stroke = style.stroke || "var(--color-border)";
  const filterId = `topo-electric-${id}`;

  if (!active) {
    return <BaseEdge id={id} path={edgePath} style={{ ...style, stroke }} />;
  }

  return (
    <g className="topology-edge-electric">
      <defs>
        <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="2" result="noise">
            <animate attributeName="baseFrequency" values="0.8;1.4;0.8" dur="0.25s" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      {/* Outer electric halo */}
      <path
        d={edgePath}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={10}
        strokeOpacity={0.35}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-halo"
      />
      {/* Mid plasma */}
      <path
        d={edgePath}
        fill="none"
        stroke="#4ade80"
        strokeWidth={5}
        strokeOpacity={0.85}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-plasma"
      />
      {/* Hot white core */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: "#f8fafc", strokeWidth: 2.2, opacity: 1 }}
        className="topology-edge-kame"
      />
      {/* Energy orbs */}
      {Array.from({ length: KAME_PARTICLE_COUNT }, (_, i) => (
        <circle
          key={`${id}-p-${i}`}
          r={i % 2 === 0 ? 4 : 2.5}
          fill={i % 3 === 0 ? "#fde047" : i % 3 === 1 ? "#67e8f9" : "#fff"}
          opacity={0.95}
          style={{ filter: "drop-shadow(0 0 4px #22d3ee)" }}
        >
          <animateMotion
            dur={`${0.4 + i * 0.08}s`}
            repeatCount="indefinite"
            path={edgePath}
            begin={`${i * 0.09}s`}
          />
        </circle>
      ))}
      {/* Electric sparks (short-lived blink along path) */}
      {Array.from({ length: SPARK_COUNT }, (_, i) => (
        <circle
          key={`${id}-s-${i}`}
          r={1.8}
          fill="#e0f2fe"
          opacity={0}
        >
          <animate
            attributeName="opacity"
            values="0;1;0;0;1;0"
            dur={`${0.35 + (i % 3) * 0.1}s`}
            begin={`${i * 0.07}s`}
            repeatCount="indefinite"
          />
          <animateMotion
            dur={`${0.28 + i * 0.05}s`}
            repeatCount="indefinite"
            path={edgePath}
            begin={`${i * 0.11}s`}
          />
        </circle>
      ))}
    </g>
  );
}

TopologyEdge.propTypes = {
  id: PropTypes.string,
  sourceX: PropTypes.number,
  sourceY: PropTypes.number,
  targetX: PropTypes.number,
  targetY: PropTypes.number,
  sourcePosition: PropTypes.string,
  targetPosition: PropTypes.string,
  style: PropTypes.object,
  data: PropTypes.object,
};

const nodeTypes = { provider: ProviderNode, router: RouterNode };
const edgeTypes = { topology: TopologyEdge };




/**
 * 拓扑图视口自适应控制器
 * 专职负责在 ReactFlow 上下文内进行精准、防抖的视口自适应居中（fitView）
 * 通过监听 nodesInitialized 确保所有节点尺寸测量完成后才执行计算，避免视口异常空白
 *
 * @author wei
 * @since 2026-09-16
 * @param {Object} props 组件入参
 * @param {Object} props.fitOpts fitView 配置项
 * @param {string} props.layoutDependency 触发重新居中的依赖项
 * @return {null} 逻辑控制器无 UI 渲染
 */
function TopologyViewController({ fitOpts, layoutDependency }) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const hasFittedRef = useRef(false);

  // 节点尺寸首次测量就绪时，立即安全执行 fitView
  useEffect(() => {
    if (nodesInitialized && !hasFittedRef.current) {
      hasFittedRef.current = true;
      fitView(fitOpts);
    }
  }, [nodesInitialized, fitView, fitOpts]);

  // 当布局依赖变动（如提供商列表变化）且节点已就绪时，平滑重新居中
  useEffect(() => {
    if (nodesInitialized && hasFittedRef.current) {
      const timer = setTimeout(() => {
        fitView(fitOpts);
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [layoutDependency, nodesInitialized, fitView, fitOpts]);

  return null;
}

TopologyViewController.propTypes = {
  fitOpts: PropTypes.object.isRequired,
  layoutDependency: PropTypes.string.isRequired,
};

/**
 * 拓扑图渲染主体组件
 *
 * @author wei
 * @since 2026-09-16
 * @param {Object} props 组件入参
 * @return {JSX.Element} 拓扑图 DOM
 */
function ProviderTopologyInner({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
}) {
  // Serialize to stable string keys so useMemo only re-runs when values actually change
  const activeKey = useMemo(
    () =>
      activeRequests
        .map((r) => r.provider?.toLowerCase())
        .filter(Boolean)
        .sort()
        .join(","),
    [activeRequests]
  );
  const lastKey = lastProvider?.toLowerCase() || "";
  const errorKey = errorProvider?.toLowerCase() || "";

  const rawActiveSet = useMemo(
    () => new Set(activeKey ? activeKey.split(",") : []),
    [activeKey]
  );
  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set(errorKey ? [errorKey] : []), [errorKey]);

  // 跟踪并维护每个活跃提供商首次出现时间，超时后自动在动效中剔除
  const firstSeenRef = useRef({});
  const [activeSet, setActiveSet] = useState(() => new Set(rawActiveSet));

  useEffect(() => {
    const seen = firstSeenRef.current;
    const now = Date.now();
    for (const p of rawActiveSet) {
      if (!seen[p]) seen[p] = now;
    }
    for (const p of Object.keys(seen)) {
      if (!rawActiveSet.has(p)) delete seen[p];
    }

    const updateActive = () => {
      const currentNow = Date.now();
      const filtered = new Set();
      for (const p of rawActiveSet) {
        const ts = seen[p];
        if (!ts || currentNow - ts < FE_ACTIVE_TIMEOUT_MS) {
          filtered.add(p);
        }
      }
      setActiveSet(filtered);
    };

    updateActive();

    if (rawActiveSet.size === 0) return;
    const id = setInterval(updateActive, FE_ACTIVE_TICK_MS);
    return () => clearInterval(id);
  }, [rawActiveSet]);

  const layoutOptions = useMemo(
    () => ({
      getProviderConfig,
      getProviderImageUrl,
    }),
    []
  );

  const { nodes, edges } = useMemo(
    () => buildLayout(providers, activeSet, lastSet, errorSet, layoutOptions),
    [providers, activeSet, lastSet, errorSet, layoutOptions]
  );

  // Stable key — only remount when provider list changes
  const providersKey = useMemo(
    () => providers.map((p) => p.provider).sort().join(","),
    [providers]
  );

  const rfInstance = useRef(null);
  const containerRef = useRef(null);
  const fitOpts = useMemo(() => ({ padding: 0.2, duration: 200 }), []);

  const onInit = useCallback((instance) => {
    rfInstance.current = instance;
  }, []);

  // 监听容器尺寸变动，在尺寸真实有效时自适应居中
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      // 增加尺寸有效性防御性检查，避免隐藏或零尺寸时错误计算
      if (
        entry &&
        entry.contentRect.width > 50 &&
        entry.contentRect.height > 50
      ) {
        if (rfInstance.current) {
          rfInstance.current.fitView(fitOpts);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitOpts]);

  return (
    <div
      ref={containerRef}
      className="h-[320px] w-full min-w-0 rounded-lg border border-border bg-surface-2/30 sm:h-[480px]"
    >
      {providers.length === 0 ? (
        <div className="h-full flex items-center justify-center text-text-muted text-sm">
          No providers connected
        </div>
      ) : (
        <ReactFlow
          key={providersKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultViewport={{ x: 260, y: 220, zoom: 0.75 }}
          fitView
          fitViewOptions={fitOpts}
          minZoom={0.1}
          maxZoom={2}
          onInit={onInit}
          proOptions={{ hideAttribution: true }}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Controls
            showInteractive={false}
            className="react-flow-controls-custom"
          />
          <TopologyViewController
            fitOpts={fitOpts}
            layoutDependency={providersKey}
          />
        </ReactFlow>
      )}
    </div>
  );
}

ProviderTopologyInner.propTypes = {
  providers: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      provider: PropTypes.string,
      name: PropTypes.string,
    })
  ),
  activeRequests: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string,
      model: PropTypes.string,
      account: PropTypes.string,
    })
  ),
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
};

/**
 * 提供商调用拓扑动效组件
 *
 * @author wei
 * @since 2026-09-16
 * @param {Object} props 组件入参
 * @return {JSX.Element} 带有 ReactFlowProvider 上下文的拓扑图组件
 */
export default function ProviderTopology(props) {
  return (
    <ReactFlowProvider>
      <ProviderTopologyInner {...props} />
    </ReactFlowProvider>
  );
}

ProviderTopology.propTypes = ProviderTopologyInner.propTypes;
