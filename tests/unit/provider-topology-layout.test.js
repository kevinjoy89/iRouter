import test from "node:test";
import assert from "node:assert/strict";
import {
  TOPOLOGY_CONSTANTS,
  buildLayout,
} from "../../src/app/(dashboard)/dashboard/usage/components/topologyLayout.js";

/**
 * 测试提供商拓扑图布局几何计算与视口防塌陷边界保护逻辑
 *
 * @author wei
 * @since 2026-09-16
 */
test("提供商列表为空时的保底布局与显式尺寸验证", () => {
  const { nodes, edges } = buildLayout([]);

  assert.equal(nodes.length, 1, "空列表应仅包含一个中心路由器节点");
  assert.equal(edges.length, 0, "空列表时不应产生任何连线");

  const routerNode = nodes[0];
  assert.equal(routerNode.id, "router");
  assert.equal(routerNode.type, "router");

  // 验证中心对齐坐标，防止原点落在左上角导致流放
  assert.equal(
    routerNode.position.x,
    -TOPOLOGY_CONSTANTS.ROUTER_WIDTH / 2,
    "路由器 X 轴坐标应居中偏置"
  );
  assert.equal(
    routerNode.position.y,
    -TOPOLOGY_CONSTANTS.ROUTER_HEIGHT / 2,
    "路由器 Y 轴坐标应居中偏置"
  );

  // 必须具备显式尺寸以防止 ReactFlow fitView 视口塌陷为 NaN
  assert.equal(routerNode.width, TOPOLOGY_CONSTANTS.ROUTER_WIDTH);
  assert.equal(routerNode.height, TOPOLOGY_CONSTANTS.ROUTER_HEIGHT);
  assert.equal(routerNode.initialWidth, TOPOLOGY_CONSTANTS.ROUTER_WIDTH);
  assert.equal(routerNode.initialHeight, TOPOLOGY_CONSTANTS.ROUTER_HEIGHT);
});

test("多提供商环形分布与几何尺寸完整性验证", () => {
  const mockProviders = [
    { provider: "openai", name: "OpenAI" },
    { provider: "anthropic", name: "Claude" },
    { provider: "gemini", name: "Google Gemini" },
    { provider: "deepseek", name: "DeepSeek" },
  ];

  const activeSet = new Set(["openai"]);
  const lastSet = new Set(["anthropic"]);
  const errorSet = new Set(["gemini"]);

  const { nodes, edges } = buildLayout(
    mockProviders,
    activeSet,
    lastSet,
    errorSet
  );

  assert.equal(
    nodes.length,
    5,
    "应生成 1 个中心路由器节点与 4 个提供商节点"
  );
  assert.equal(edges.length, 4, "应生成 4 条连接边");

  // 验证所有节点均具有有效的显式几何尺寸且无 NaN 坐标
  for (const node of nodes) {
    assert.ok(node.width > 0, "节点宽度必须大于 0");
    assert.ok(node.height > 0, "节点高度必须大于 0");
    assert.ok(node.initialWidth > 0, "节点初始宽度必须大于 0");
    assert.ok(node.initialHeight > 0, "节点初始高度必须大于 0");
    assert.equal(Number.isNaN(node.position.x), false, "X 坐标不得为 NaN");
    assert.equal(Number.isNaN(node.position.y), false, "Y 坐标不得为 NaN");
  }

  // 验证状态样式映射
  const openaiEdge = edges.find((e) => e.id === "e-provider-openai");
  assert.ok(openaiEdge, "应存在 openai 连线");
  assert.equal(openaiEdge.data.active, true, "活跃连线数据标记应为 active");
  assert.equal(openaiEdge.style.stroke, "#22d3ee", "活跃连线应为高亮青色");

  const claudeEdge = edges.find((e) => e.id === "e-provider-anthropic");
  assert.ok(claudeEdge, "应存在 anthropic 连线");
  assert.equal(claudeEdge.style.stroke, "#f59e0b", "上次活跃连线应为琥珀色");

  const geminiEdge = edges.find((e) => e.id === "e-provider-gemini");
  assert.ok(geminiEdge, "应存在 gemini 连线");
  assert.equal(geminiEdge.style.stroke, "#ef4444", "异常连线应为红色");
});

test("容器尺寸有效性判定防御机制验证", () => {
  /**
   * 判定容器尺寸是否达到执行视口自适应的安全阈值
   *
   * @param {number} width 容器实时宽度
   * @param {number} height 容器实时高度
   * @return {boolean} 是否允许触发 fitView
   */
  const canFitViewSafely = (width, height) => {
    const min = TOPOLOGY_CONSTANTS.MIN_CONTAINER_SIZE;
    return width > min && height > min;
  };

  assert.equal(
    canFitViewSafely(0, 0),
    false,
    "零尺寸容器绝对禁止调用 fitView 以免视口塌陷"
  );
  assert.equal(
    canFitViewSafely(40, 300),
    false,
    "宽度低于安全阈值时应拦截 fitView"
  );
  assert.equal(
    canFitViewSafely(600, 30),
    false,
    "高度低于安全阈值时应拦截 fitView"
  );
  assert.equal(
    canFitViewSafely(600, 400),
    true,
    "正常尺寸容器应安全允许执行 fitView"
  );
});

test("视口自适应初始化状态守卫逻辑验证", () => {
  /**
   * 模拟视口居中调度器判断
   *
   * @param {boolean} nodesInitialized 节点 DOM 尺寸是否已完成测量
   * @param {boolean} hasFitted 是否已完成初次居中
   * @return {{shouldFitInitial: boolean, shouldRefitUpdate: boolean}} 居中执行决策
   */
  const evaluateFitDecision = (nodesInitialized, hasFitted) => {
    return {
      shouldFitInitial: nodesInitialized && !hasFitted,
      shouldRefitUpdate: nodesInitialized && hasFitted,
    };
  };

  // 场景 1：节点尚未完成 DOM 测量，禁止执行初次 fitView
  const res1 = evaluateFitDecision(false, false);
  assert.equal(res1.shouldFitInitial, false, "节点未初始化完成时禁止居中");
  assert.equal(res1.shouldRefitUpdate, false, "节点未初始化完成时禁止更新居中");

  // 场景 2：节点刚刚完成 DOM 测量，允许执行首次 fitView
  const res2 = evaluateFitDecision(true, false);
  assert.equal(res2.shouldFitInitial, true, "节点尺寸就绪后立即触发初次居中");

  // 场景 3：已完成初次居中，后续仅按需重新平滑居中
  const res3 = evaluateFitDecision(true, true);
  assert.equal(res3.shouldFitInitial, false, "已初次居中后不再重复执行初次居中");
  assert.equal(res3.shouldRefitUpdate, true, "已初次居中且节点就绪时允许平滑重适应");
});
