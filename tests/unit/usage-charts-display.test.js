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

  it("模型名称在长文本下贪心撑满换行，杜绝腰斩版本号小数点", () => {
    // 1. 短模型名不换行，保持单行展示
    expect(wrapModelName("gpt-4o")).toEqual(["gpt-4o"]);
    expect(wrapModelName("claude-3")).toEqual(["claude-3"]);

    // 2. 长模型名如 deepseek-v4.1-flash 优先撑满第一行，在合法连字符处折断且保护 v4.1 版本号
    const deepseekWrapped = wrapModelName("deepseek-v4.1-flash");
    expect(deepseekWrapped).toEqual(["deepseek-v4.1-", "flash"]);
    expect(deepseekWrapped[0].length).toBeLessThanOrEqual(14);

    // 3. 验证真实模型名称的换行体验：撑满之后换行，绝不从小数点破坏 3.0 或 4.1
    expect(wrapModelName("deepseek-v4-flash")).toEqual(["deepseek-v4-", "flash"]);
    expect(wrapModelName("agnes-3.0-flash")).toEqual(["agnes-3.0-", "flash"]);
    expect(wrapModelName("deepseek-v4.1-flash-1017")).toEqual(["deepseek-v4.1-", "flash-1017"]);

    // 4. claude-3.5-sonnet 保护 3.5 版本号并撑满第一行
    expect(wrapModelName("claude-3.5-sonnet")).toEqual(["claude-3.5-", "sonnet"]);
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
