"use client";

// 存储设置：本地库里「请求详情」的体积与滚动保留天数。
//
// 设计约束（来自实际使用反馈）：
// - **不提供「删除全部」**：那是一键抹掉全部诊断信息的破坏性操作，没有合理的日常用途。
//   需要腾空间时把保留天数调小再点一次「Save & clean now」即可，语义更清楚。
// - **一步完成**：用户只需要设天数 + 点一次按钮，删除与磁盘空间回收都在服务端完成，
//   界面不出现「压缩/VACUUM」这类需要用户理解的概念。
// - **清理在后台跑，界面不能被卡住**：服务端把活交给独立子进程，点击后立即返回；
//   这里轮询进度并显示「正在后台清理 · N 条已删除」。
// - **只报告本次操作的结果**：状态文件里留着上一次运行的历史结果，打开面板时把它当成
//   「刚刚发生了什么」显示出来是错的（用户实测反馈：一打开就看到绿色「没有需要清理的内容」，
//   完全不知道指的是什么）。历史结果一律不显示，只有这一次点击触发的结果才常驻展示。
//
// 排版：四个读数改成瓦片。它们此前与开关同列同款（标题+数值），
// 而「数据库 486.6 MB」是**读数**不是**设置**，混在一起看不出区别。
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
} from "./parts";

const POLL_INTERVAL_MS = 1500;

/**
 * 存储设置段
 *
 * @return {JSX.Element} 存储读数与保留策略
 * @author wei
 * @since 2026-09-29
 */
export default function StorageSettings() {
  const [storage, setStorage] = useState(null);
  const [retention, setRetention] = useState(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [tick, setTick] = useState(0);
  // 只有「本次点击触发的清理」才展示最终结果，历史结果不展示
  const userTriggered = useRef(false);

  const maintenance = storage?.maintenance;
  const feedback = describeStorageFeedback(maintenance, result);
  const running = feedback.kind === "running";
  const feedbackText = formatStorageFeedback(feedback, translate);

  // 初次加载 + 清理进行中轮询。清理在子进程里跑，这里只读状态。
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
    setTick((t) => t + 1); // 重新拉状态：清理中则开始轮询，已结束则取本次结果
  };

  return (
    <>
      <SectionHeader
        title="Data Storage"
        description="Where the gateway keeps its data, how big it grows, and how to move the configuration in and out."
      />
      <SectionBody>
        {/* 数据位置放第一位（用户要求）：先回答「东西在哪」，再谈体积与保留策略 */}
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
            {/* 左右结构：标签在左、天数与按钮在右，同一行不换行（用户要求）。
                不用 flex-wrap——宽度不够时宁可挤压左侧说明，也不要把按钮甩到下一行。 */}
            <div className="flex items-center gap-2">
              {/* 原生 input 而非公共 Input：这里的宽度/高度要与 sm 按钮对齐，
                  而 Input 自带的 py-2.5 与本仓只拼接不去重的 cn() 会打架。 */}
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

        {/* 配置导出/导入：与数据位置、保留策略同属「网关在本地留下什么」，
            合并成一页，导航里不再单列入口。 */}
        <ConfigFileCard />
      </SectionBody>
    </>
  );
}
