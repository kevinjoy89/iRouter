import type { SpeedtestConfig, SpeedtestProgress, SpeedtestResult } from "./types";

/**
 * 模型测速通信客户端抽象（自动适配 Tauri IPC 与 Web SSE 降级通道）
 *
 * @author iRouter
 * @since 2026-10-16
 */

/**
 * 判定当前运行时环境是否为 Tauri 桌面壳层
 *
 * @return {boolean} 是否处于 Tauri 桌面端
 */
export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

const activeAbortControllers = new Map<string, AbortController>();

/**
 * 启动流式测速任务
 *
 * @param config 测速配置参数
 * @param onProgress 实时进度回调处理函数
 * @return 终态评测结果对象
 */
export async function runSpeedtest(
  config: SpeedtestConfig,
  onProgress?: (progress: SpeedtestProgress) => void
): Promise<SpeedtestResult> {
  const sessionId = config.sessionId || crypto.randomUUID();
  const normalizedConfig: SpeedtestConfig = { ...config, sessionId };

  if (isTauriEnvironment()) {
    // 桌面端运行环境：走 Tauri 原生 IPC 与 Event 高频总线
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<SpeedtestProgress>("speedtest:progress", (event) => {
        if (event.payload?.sessionId === sessionId) {
          onProgress?.(event.payload);
        }
      });

      const result = await invoke<SpeedtestResult>("speedtest_run", { config: normalizedConfig });
      return result;
    } finally {
      if (unlisten) {
        unlisten();
      }
    }
  }

  // 纯 Web 环境：通过网关 SSE 路由降级运行
  const controller = new AbortController();
  activeAbortControllers.set(sessionId, controller);

  try {
    const response = await fetch("/api/speedtest/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizedConfig),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`测速请求失败 (${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error("上游响应体为空");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: SpeedtestResult | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;

        try {
          const progress: SpeedtestProgress = JSON.parse(dataStr);
          onProgress?.(progress);
          if (progress.step === "completed" && progress.result) {
            finalResult = progress.result;
          }
        } catch {
          // 忽略非格式化数据行
        }
      }
    }

    if (finalResult) {
      return finalResult;
    }
    throw new Error("测速流异常终止，未获取到完整评测结果");
  } finally {
    activeAbortControllers.delete(sessionId);
  }
}

/**
 * 主动中止指定会话的流式测速任务
 *
 * @param sessionId 待中止的测速会话标识符
 * @return 是否成功发出中止信号
 */
export async function abortSpeedtest(sessionId: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("speedtest_abort", { sessionId });
  }

  const controller = activeAbortControllers.get(sessionId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(sessionId);
    return true;
  }
  return false;
}
