"use client";

import { useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import { cn } from "@/shared/utils/cn";
import { Group, SectionBody, SectionHeader } from "./parts";

/**
 * 外部生态集成设置分段组件
 * 负责管理与同步外部第三方生态服务、模型目录与元数据基准
 *
 * @return {JSX.Element} 外部集成设置界面
 * @author wei
 * @since 2026-10-16
 */
export default function IntegrationsSettings() {
  const [meta, setMeta] = useState({
    source: "models.dev",
    lastUpdated: null,
    modelCount: 0,
  });
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/pricing")
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        setMeta({
          source: data?.source || "models.dev",
          lastUpdated: data?.lastUpdated || null,
          modelCount: data?.modelCount || 0,
        });
      })
      .catch((err) => {
        console.error("Failed to fetch integration metadata:", err);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setStatus(null);
    try {
      const res = await fetch("/api/pricing", { method: "POST" });
      const result = await res.json();
      if (result.success !== false) {
        setMeta({
          source: "models.dev",
          lastUpdated: result.lastUpdated || new Date().toISOString(),
          modelCount: result.modelCount || meta.modelCount,
        });
        setStatus({ type: "success", message: "Pricing synchronized with models.dev" });
      } else {
        setStatus({ type: "error", message: result.error || "Sync failed" });
      }
    } catch (e) {
      console.error("Failed to sync models.dev:", e);
      setStatus({ type: "error", message: "Network error during sync" });
    } finally {
      setSyncing(false);
      setTimeout(() => setStatus(null), 4000);
    }
  };

  return (
    <>
      <SectionHeader
        title="Integrations"
        description="Connect and synchronize external ecosystem services, metadata, and models"
      />
      <SectionBody>
        <Group>
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 min-w-0">
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 shrink-0 mt-0.5">
                <span className="material-symbols-outlined text-[20px]">payments</span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-text-main">models.dev</span>
                  <a
                    href="https://models.dev"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:underline"
                  >
                    <span>models.dev</span>
                    <span className="material-symbols-outlined text-[13px]">open_in_new</span>
                  </a>
                </div>
                <p className="mt-1 text-[12px] leading-[1.5] text-text-muted">
                  Open-source AI model directory and real-time pricing registry. Synchronizes model capabilities, context limits, and token pricing rates for usage cost estimation.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
                  {meta.modelCount > 0 ? (
                    <span className="font-medium text-text-main">
                      {meta.modelCount} models tracked
                    </span>
                  ) : null}
                  <span className="opacity-60">•</span>
                  <span>Auto-syncs every 24 hours</span>
                  {meta.lastUpdated ? (
                    <>
                      <span className="opacity-60">•</span>
                      <span>Updated {new Date(meta.lastUpdated).toLocaleDateString()}</span>
                    </>
                  ) : null}
                </div>
                {status ? (
                  <p className={cn("mt-1.5 text-[11px] font-medium", status.type === "error" ? "text-red-500" : "text-emerald-500")}>
                    {status.message}
                  </p>
                ) : null}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
              className="shrink-0 self-start sm:self-center"
            >
              {syncing ? (
                <span className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                  <span>Syncing...</span>
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[14px]">sync</span>
                  <span>Sync Now</span>
                </span>
              )}
            </Button>
          </div>
        </Group>
      </SectionBody>
    </>
  );
}
