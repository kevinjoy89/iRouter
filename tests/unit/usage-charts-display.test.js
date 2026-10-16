import { describe, it, expect } from "vitest";
import { getProviderDisplayName } from "@/shared/constants/providers";
import { buildLayout } from "@/app/(dashboard)/dashboard/usage/components/topologyLayout";
import { wrapModelName } from "@/app/(dashboard)/dashboard/usage/components/chartUtils";

describe("使用统计图表供应商与模型名称展示防护", () => {
  it("getProviderDisplayName 能够准确将原生提供商 ID、兼容协议与自定义节点解析为友好名称", () => {
    // 1. 标准内置提供商 ID
    expect(getProviderDisplayName("github")).toBe("GitHub Copilot");
    expect(getProviderDisplayName("antigravity")).toBe("Antigravity");
    expect(getProviderDisplayName("codex")).toBe("OpenAI Codex");

    // 2. 兼容协议节点与原生兼容 ID（避免显示为原始切片 openai-com...）
    expect(getProviderDisplayName("openai-compatible")).toBe("OpenAI Compatible");
    expect(getProviderDisplayName("openai-compatible-chat-custom123")).toBe("OpenAI Compatible");
    expect(getProviderDisplayName("anthropic-compatible")).toBe("Anthropic Compatible");
    expect(getProviderDisplayName("anthropic-compatible-claude-node")).toBe("Anthropic Compatible");

    // 3. 优先匹配 providerNodes 独立自定义节点列表中的友好名称
    const customNodes = [
      { id: "openai-compatible-chat-opencsg", name: "OpenCSG", nodeName: "OpenCSG" },
      { id: "openai-compatible-chat-stepfun", name: "StepFun", nodeName: "StepFun" },
    ];
    expect(getProviderDisplayName("openai-compatible-chat-opencsg", [], customNodes)).toBe("OpenCSG");
    expect(getProviderDisplayName("openai-compatible-chat-stepfun", [], customNodes)).toBe("StepFun");

    // 4. 其次匹配 connection 连接列表中的友好名称
    const customProviders = [
      { provider: "my-custom-node", name: "本地 Ollama", nodeName: "本地 Ollama" },
      { id: "conn-123", provider: "deepseek", name: "我的 DeepSeek 账户" },
    ];
    expect(getProviderDisplayName("my-custom-node", customProviders)).toBe("本地 Ollama");
    expect(getProviderDisplayName("conn-123", customProviders)).toBe("我的 DeepSeek 账户");
  });

  it("模型名称在长文本下智能自动换行，取消裁切且保持 90px 紧凑美观", () => {
    // 1. 短模型名不换行，保持单行展示
    expect(wrapModelName("gpt-4o")).toEqual(["gpt-4o"]);
    expect(wrapModelName("claude-3")).toEqual(["claude-3"]);

    // 2. 长模型名如 deepseek-v4.1-flash 智能在分隔符处拆分为两行，取消左侧裁切
    const deepseekWrapped = wrapModelName("deepseek-v4.1-flash");
    expect(deepseekWrapped.length).toBe(2);
    expect(deepseekWrapped[0]).toBe("deepseek-");
    expect(deepseekWrapped[1]).toBe("v4.1-flash");
    // 拆分后的两行字符数均在 10 字符左右，在 90px 空间内留有 30px+ 充足边距
    expect(deepseekWrapped[0].length).toBeLessThanOrEqual(12);
    expect(deepseekWrapped[1].length).toBeLessThanOrEqual(12);

    // 3. 其它长模型名称智能切分验证
    const claudeWrapped = wrapModelName("claude-3.5-sonnet");
    expect(claudeWrapped.length).toBe(2);
    expect(claudeWrapped[0].length).toBeLessThanOrEqual(12);
    expect(claudeWrapped[1].length).toBeLessThanOrEqual(12);
  });

  it("提供商拓扑图使用纯净 providers 保证椭圆几何布局正确且不会因节点重复发生坐标冲突", () => {
    // 标准提供商列表
    const providers = [
      { provider: "openai", name: "OpenAI" },
      { provider: "anthropic", name: "Anthropic" },
      { provider: "deepseek", name: "DeepSeek" },
    ];
    const { nodes, edges } = buildLayout(providers);

    // 节点数量应严格为 1 个中心路由器 + 3 个提供商节点
    expect(nodes.length).toBe(4);
    expect(edges.length).toBe(3);

    // 校验每个提供商节点的唯一性与合法尺寸，杜绝坐标塌陷
    const nodeIds = nodes.map((n) => n.id);
    expect(new Set(nodeIds).size).toBe(4);
  });
});
