/**
 * 拓扑图布局几何计算模块
 * 负责计算拓扑节点的椭圆环形分布坐标、显式尺寸与连接边配置
 *
 * @author wei
 * @since 2026-09-16
 */

export const TOPOLOGY_CONSTANTS = {
  NODE_WIDTH: 180,
  NODE_HEIGHT: 30,
  ROUTER_WIDTH: 120,
  ROUTER_HEIGHT: 44,
  NODE_GAP: 24,
  DEFAULT_MIN_RX: 320,
  DEFAULT_MIN_RY: 200,
  ELLIPSE_RATIO: 0.55,
  MIN_CONTAINER_SIZE: 50,
};

/**
 * 根据提供商列表及调用状态计算拓扑图节点与连线数据
 *
 * @author wei
 * @since 2026-09-16
 * @param {Array<Object>} providers 提供商列表
 * @param {Set<string>} activeSet 活跃提供商集合
 * @param {Set<string>} lastSet 上次活跃提供商集合
 * @param {Set<string>} errorSet 异常提供商集合
 * @param {Object} [options] 可选参数
 * @param {Function} [options.getProviderConfig] 获取提供商配置方法
 * @param {Function} [options.getProviderImageUrl] 获取提供商图标方法
 * @return {{nodes: Array<Object>, edges: Array<Object>}} 拓扑图节点与边数组
 */
export function buildLayout(
  providers = [],
  activeSet = new Set(),
  lastSet = new Set(),
  errorSet = new Set(),
  options = {}
) {
  const {
    NODE_WIDTH: nodeW,
    NODE_HEIGHT: nodeH,
    ROUTER_WIDTH: routerW,
    ROUTER_HEIGHT: routerH,
    NODE_GAP: nodeGap,
    DEFAULT_MIN_RX: minRxBase,
    DEFAULT_MIN_RY: minRyBase,
    ELLIPSE_RATIO: ratio,
  } = TOPOLOGY_CONSTANTS;

  const count = providers.length;
  const resolveConfig = options.getProviderConfig || ((id) => ({ color: "#6b7280", name: id }));
  const resolveImageUrl = options.getProviderImageUrl || (() => "");

  // 空提供商列表时居中展示路由器核心节点
  if (count === 0) {
    return {
      nodes: [
        {
          id: "router",
          type: "router",
          position: { x: -routerW / 2, y: -routerH / 2 },
          width: routerW,
          height: routerH,
          initialWidth: routerW,
          initialHeight: routerH,
          data: { activeCount: 0 },
          draggable: false,
        },
      ],
      edges: [],
    };
  }

  // 根据节点数量与间距动态计算椭圆长短半轴
  const minRx = ((nodeW + nodeGap) * count) / (2 * Math.PI);
  const rx = Math.max(minRxBase, minRx);
  const ry = Math.max(minRyBase, rx * ratio);

  const nodes = [];
  const edges = [];

  // 添加中心路由器节点
  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    width: routerW,
    height: routerH,
    initialWidth: routerW,
    initialHeight: routerH,
    data: { activeCount: activeSet.size },
    draggable: false,
  });

  /**
   * 计算连线样式
   *
   * @param {boolean} active 是否活跃
   * @param {boolean} last 是否上次活跃
   * @param {boolean} error 是否异常
   * @return {Object} 连线 SVG 样式
   */
  const getEdgeStyle = (active, last, error) => {
    if (error) return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
    if (active) return { stroke: "#22d3ee", strokeWidth: 3.5, opacity: 1 };
    if (last) return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.7 };
    return { stroke: "var(--color-border)", strokeWidth: 1, opacity: 0.3 };
  };

  providers.forEach((p, i) => {
    const config = resolveConfig(p.provider);
    const active = activeSet.has(p.provider?.toLowerCase());
    const last = !active && lastSet.has(p.provider?.toLowerCase());
    const error = !active && errorSet.has(p.provider?.toLowerCase());
    const nodeId = `provider-${p.provider}`;
    const data = {
      label: (config.name !== p.provider ? config.name : null) || p.nodeName || p.name || p.provider,
      color: config.color || "#6b7280",
      imageUrl: resolveImageUrl(p.provider),
      textIcon: config.textIcon || (p.provider || "?").slice(0, 2).toUpperCase(),
      active,
    };

    // 沿椭圆均匀分布，从顶部正中（-π/2）按顺时针排列
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const cx = rx * Math.cos(angle);
    const cy = ry * Math.sin(angle);

    // 根据节点所在方向选择路由器节点最佳连接锚点
    let sourceHandle;
    let targetHandle;
    if (Math.abs(angle + Math.PI / 2) < Math.PI / 4 || Math.abs(angle - (3 * Math.PI) / 2) < Math.PI / 4) {
      sourceHandle = "top";
      targetHandle = "bottom";
    } else if (Math.abs(angle - Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "bottom";
      targetHandle = "top";
    } else if (cx > 0) {
      sourceHandle = "right";
      targetHandle = "left";
    } else {
      sourceHandle = "left";
      targetHandle = "right";
    }

    nodes.push({
      id: nodeId,
      type: "provider",
      position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
      width: nodeW,
      height: nodeH,
      initialWidth: nodeW,
      initialHeight: nodeH,
      data,
      draggable: false,
    });

    edges.push({
      id: `e-${nodeId}`,
      type: "topology",
      source: "router",
      sourceHandle,
      target: nodeId,
      targetHandle,
      animated: false,
      data: { active },
      style: getEdgeStyle(active, last, error),
    });
  });

  return { nodes, edges };
}
