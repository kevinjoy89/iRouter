"use client";

// 数据与日志设置：请求日志记录、保留周期、本地数据库存储与配置备份
// 方案 A 架构：整合原「可观测性」与「数据存储」分段，提供统一的数据生命周期视图
import { useEffect, useRef, useState } from "react";
import Button from "@/shared/components/Button";
import { translate } from "@/i18n/runtime";
import { ConfigFileCard, DataLocationCard } from "./GatewayDataCards";
import {
  describeStorageFeedback,
  formatBytes,
  formatStorageFeedback,
} from "./storageFeedback";
import {
  Group,
  Notice,
  Row,
  SectionBody,
  SectionHeader,
  StatGrid,
  StatTile,
  Switch,
} from "./parts";

const POLL_INTERVAL_MS = 1500;

/**
 * 数据与日志设置段组件
 *
 * @return {JSX.Element} 数据与日志设置界面
 * @author wei
 * @since 2026-10-09
 */
export default function DataLogsSettings() {
  // 可观测性相关状态
  const [obsLoading, setObsLoading] = useState(true);
  const [obsSettings, setObsSettings] = useState({
    enableObservability: false,
    verboseErrorLog: false,
  });
  const [obsFailed, setObsFailed] = useState(false);

  // 存储相关状态
  const [storage, setStorage] = useState(null);
  const [retention, setRetention] = useState(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [tick, setTick] = useState(0);
  const userTriggered = useRef(false);

  // 加载可观测性配置
  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        setObsSettings({
          enableObservability: data?.enableObservability === true,
          verboseErrorLog: data?.verboseErrorLog === true,
        });
      })
      .catch((err) => {
        console.error("Failed to load observability settings:", err);
        if (alive) setObsFailed(true);
      })
      .finally(() => {
        if (alive) setObsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const updateObservability = async (patch) => {
    setObsSettings((prev) => ({ ...prev, ...patch }));
    setObsFailed(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) setObsFailed(true);
    } catch (err) {
      console.error("Failed to update observability settings:", err);
      setObsFailed(true);
    }
  };

  const maintenance = storage?.maintenance;
  const feedback = describeStorageFeedback(maintenance, result);
  const running = feedback.kind === "running";
  const feedbackText = formatStorageFeedback(feedback, translate);

  // 存储数据加载与轮询
  useEffect(() => {
    let alive = true;
    let timer = null;

    const load = async () => {
      try {
        const res = await fetch("/api/usage/storage");
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        setStorage(data);
        setRetention((prev) =>
          prev === null ? String(data.retentionDays ?? 7) : prev,
        );

        const m = data.maintenance;
        if (m?.running) {
          timer = setTimeout(load, POLL_INTERVAL_MS);
          return;
        }
        if (userTriggered.current) {
          userTriggered.current = false;
          setResult({
            deleted: m?.deleted ?? 0,
            reclaimed: m?.reclaimed ?? 0,
            days: m?.days ?? null,
            error: m?.error ?? null,
          });
        }
      } catch (err) {
        console.error("Failed to load storage stats:", err);
      }
    };

    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  const saveAndClean = async () => {
    const days = parseInt(retention, 10);
    if (!Number.isInteger(days) || days < 0) return;
    setSaving(true);
    setResult(null);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observabilityRetentionDays: days }),
      });
      const res = await fetch("/api/usage/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply", days }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.storage) setStorage(data.storage);
        userTriggered.current = data.started === true || data.alreadyRunning === true;
      }
    } catch (err) {
      console.error("Retention cleanup failed:", err);
    }
    setSaving(false);
    setTick((t) => t + 1);
  };

  return (
    <>
      <SectionHeader
        title="Data & Logs"
        description="Request logging, data retention, database storage, and configuration backup."
      />
      <SectionBody>
        <Group>
          <Row
            label="Enable Observability"
            hint="Record request details for inspection in the logs view"
          >
            <Switch
              name="enableObservability"
              label="Enable Observability"
              checked={obsSettings.enableObservability}
              disabled={obsLoading}
              onChange={(v) => updateObservability({ enableObservability: v })}
            />
          </Row>
          <Row
            label="Print Full Error Logs"
            hint="Include the full request and upstream response body in the console log when an error occurs"
          >
            <Switch
              name="verboseErrorLog"
              label="Print Full Error Logs"
              checked={obsSettings.verboseErrorLog}
              disabled={obsLoading}
              onChange={(v) => updateObservability({ verboseErrorLog: v })}
            />
          </Row>
        </Group>

        {obsFailed ? (
          <Notice tone="error">
            Failed to save observability settings. Check network connection and retry.
          </Notice>
        ) : null}

        <DataLocationCard />

        <StatGrid>
          <StatTile
            icon="database"
            label="Database file"
            value={storage ? formatBytes(storage.dbBytes) : "—"}
            hint="Main file + write-ahead log"
          />
          <StatTile
            icon="list_alt"
            label="Request details"
            value={storage ? storage.rows.toLocaleString() : "—"}
            hint="Rows currently stored"
          />
          <StatTile
            icon="history"
            label="Oldest entry"
            value={storage?.oldest ? String(storage.oldest).slice(0, 10) : "—"}
            hint="Anything older than the retention window is removed"
          />
          <StatTile
            icon="straighten"
            label="Max field size"
            value={storage ? `${storage.maxJsonSizeKb} KB` : "—"}
            hint="Hard cap per stored field, keeps single rows small"
          />
        </StatGrid>

        <Group>
          <Row
            label="Keep details for (days)"
            hint="Rolling cleanup runs at startup and every 6 hours, in the background. Set 0 to keep everything."
          >
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={3650}
                value={retention ?? "7"}
                onChange={(e) => setRetention(e.target.value)}
                disabled={saving || running}
                className="h-8 w-24 rounded-[9px] border border-border bg-surface-2 px-3 text-center text-[13px] text-text-main tabular-nums focus:ring-2 focus:ring-brand-500/30 focus:outline-none disabled:opacity-50"
              />
              <Button
                variant="primary"
                size="sm"
                loading={saving}
                disabled={running}
                onClick={saveAndClean}
              >
                Save & clean now
              </Button>
            </div>
          </Row>
        </Group>

        {feedbackText ? (
          <Notice
            tone={
              feedback.kind === "failed"
                ? "error"
                : feedback.kind === "result" && feedback.deleted > 0
                  ? "success"
                  : "info"
            }
          >
            {feedbackText}
          </Notice>
        ) : null}

        {running ? (
          <p className="px-1 text-[12px] leading-[1.5] text-text-muted">
            You can keep using the app — cleanup runs in batches and does not block the gateway.
          </p>
        ) : null}

        {!running && feedback.offlineHint ? (
          <p className="px-1 text-[12px] leading-[1.5] text-text-muted">
            This database predates incremental reclaim, so its file can only shrink while the app is
            closed. Quit iRouter and reopen it to reclaim the freed space.
          </p>
        ) : null}

        <ConfigFileCard />
      </SectionBody>
    </>
  );
}
