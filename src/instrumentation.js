export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // 请求详情保留策略：本地库曾因缺省无上限增长到 10GB（见
    // docs/packaged-runtime-footprint.zh-CN.md），这里挂上周期性裁剪。
    // 构建/预渲染阶段跳过，避免构建过程去打开用户数据目录（与 bootstrap.js 同一考量）。
    const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
      || process.env.NEXT_PHASE === "phase-export"
      || process.env.NEXT_PHASE === "phase-static";
    if (!isBuildPhase) {
      const { startRequestDetailsRetention } = await import("@/lib/db/repos/requestDetailsRepo.js");
      startRequestDetailsRetention();
    }
  }
}
