"use client";

// 可观测性设置：是否记录请求详情、以及异常时是否打印完整请求/响应。
// 原先在面板的 /dashboard/profile（Observability 卡片），现搬进壳层设置面板。
//
// 与「存储」段配合阅读：打开记录会产生本地明细，保留策略在 Storage 段配置。
import { useEffect, useState } from "react";
import {
  Group,
  Notice,
  Row,
  SectionBody,
  SectionHeader,
  Switch,
} from "./parts";

/**
 * 可观测性设置段
 *
 * @return {JSX.Element} 记录开关
 * @author wei
 * @since 2026-09-29
 */
export default function ObservabilitySettings() {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState({
    enableObservability: false,
    verboseErrorLog: false,
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        setSettings({
          enableObservability: data?.enableObservability === true,
          verboseErrorLog: data?.verboseErrorLog === true,
        });
      })
      .catch((err) => {
        console.error("Failed to load observability settings:", err);
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 写失败此前只进 console，界面上看不出来——开关会显示成「已打开」而服务端没改。
  const update = async (patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setFailed(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) setFailed(true);
    } catch (err) {
      console.error("Failed to update observability settings:", err);
      setFailed(true);
    }
  };

  return (
    <>
      <SectionHeader
        title="Observability"
        description="What the gateway records locally for inspection"
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
              checked={settings.enableObservability}
              disabled={loading}
              onChange={(v) => update({ enableObservability: v })}
            />
          </Row>
          <Row
            label="Print Full Error Logs"
            hint="Include the full request and upstream response body in the console log when an error occurs"
          >
            <Switch
              name="verboseErrorLog"
              label="Print Full Error Logs"
              checked={settings.verboseErrorLog}
              disabled={loading}
              onChange={(v) => update({ verboseErrorLog: v })}
            />
          </Row>
        </Group>

        {failed ? (
          <Notice tone="error">Failed to update observability settings</Notice>
        ) : null}
      </SectionBody>
    </>
  );
}
