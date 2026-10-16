import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const REPO_ROOT = new URL("../../", import.meta.url);
const MODAL_PATH = new URL("src/shared/components/ShellSettingsModal.js", REPO_ROOT);
const BUILD_SERVER_PATH = new URL("tools/build-server.mjs", REPO_ROOT);

describe("设置面板高度统一与滚动复位契约测试", () => {
  const modalSource = readFileSync(MODAL_PATH, "utf8");
  const buildServerSource = readFileSync(BUILD_SERVER_PATH, "utf8");

  it("设置面板容器高度统一固定为 560px 且具备视口安全兜底", () => {
    // 确认已配置统一固定高度类名
    expect(modalSource).toContain("flex h-[560px] max-h-[80vh]");

    // 确认已彻底清理旧的动态内容自适应高度类名
    expect(modalSource).not.toContain("min-h-[380px]");
    expect(modalSource).not.toContain("max-h-[min(560px,72vh)]");
  });

  it("右侧内容面板已绑定 ref 并在切换分段时自动复位滚动条至顶部", () => {
    // 确认已绑定 contentPanelRef 引用
    expect(modalSource).toContain("ref={contentPanelRef}");

    // 确认存在监听 active 变化并将 scrollTop 置为 0 的重置逻辑
    expect(modalSource).toMatch(/contentPanelRef\.current\.scrollTop\s*=\s*0/);
  });

  it("构建脚本 CSS_MARKERS 守卫已同步维护新高度类名", () => {
    // 确认构建守卫列表中包含统一固定高度类名
    expect(buildServerSource).toContain('"h-[560px]"');
    // 确认已移除不再生成的旧类名守卫
    expect(buildServerSource).not.toContain('"min-h-[380px]"');
  });
});
