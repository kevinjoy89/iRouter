"use client";

// 网络设置：出站代理。原先在面板的 /dashboard/profile（Network 卡片），
// 现随其余网关设置一起搬进壳层设置面板，逻辑不变、仅换承载位置与排版。
//
// 状态与请求都收在这个组件里：面板本体不再需要关心代理表单的生命周期。
import { useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import { translate } from "@/i18n/runtime";
import {
  Field,
  Group,
  Notice,
  Row,
  SectionBody,
  SectionHeader,
  Switch,
} from "./parts";

/**
 * 网络设置段
 *
 * @return {JSX.Element} 出站代理设置
 * @author wei
 * @since 2026-09-29
 */
export default function NetworkSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState({ outboundProxyUrl: "", outboundNoProxy: "" });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });

  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        setEnabled(data?.outboundProxyEnabled === true);
        setForm({
          outboundProxyUrl: data?.outboundProxyUrl || "",
          outboundNoProxy: data?.outboundNoProxy || "",
        });
      })
      .catch((err) => console.error("Failed to load network settings:", err))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleEnabled = async (next) => {
    setSaving(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outboundProxyEnabled: next }),
      });
      const data = await res.json();
      if (res.ok) {
        setEnabled(data?.outboundProxyEnabled === true);
        setStatus({
          type: "success",
          message: translate(next ? "Proxy enabled" : "Proxy disabled"),
        });
      } else {
        setStatus({
          type: "error",
          message: data.error || translate("Failed to update proxy settings"),
        });
      }
    } catch {
      setStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setSaving(false);
    }
  };

  const apply = async (e) => {
    e.preventDefault();
    if (!enabled) return;
    setSaving(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundProxyUrl: form.outboundProxyUrl,
          outboundNoProxy: form.outboundNoProxy,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus({
          type: "success",
          message: translate("Proxy settings applied"),
        });
      } else {
        setStatus({
          type: "error",
          message: data.error || translate("Failed to update proxy settings"),
        });
      }
    } catch {
      setStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const proxyUrl = (form.outboundProxyUrl || "").trim();
    if (!proxyUrl) {
      setStatus({
        type: "error",
        message: translate("Please enter a Proxy URL to test"),
      });
      return;
    }
    setTesting(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setStatus({
          type: "success",
          // 动态部分（状态码/耗时）由 translate 只译固定片段
          message: `${translate("Proxy test OK")} · ${data.status} · ${data.elapsedMs}ms`,
        });
      } else {
        setStatus({
          type: "error",
          message: data?.error || translate("Proxy test failed"),
        });
      }
    } catch {
      setStatus({ type: "error", message: translate("An error occurred") });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="Network"
        description="How the gateway reaches provider endpoints"
      />
      <SectionBody>
        <Group>
          <Row
            label="Outbound Proxy"
            hint="Enable proxy for OAuth + provider outbound requests"
          >
            <Switch
              name="outboundProxy"
              label="Outbound Proxy"
              checked={enabled}
              disabled={loading || saving}
              onChange={toggleEnabled}
            />
          </Row>
        </Group>

        {enabled ? (
          <form onSubmit={apply} className="space-y-4">
            <Group>
              <Field
                label="Proxy URL"
                hint="Leave empty to inherit existing env proxy (if any)"
              >
                <Input
                  placeholder="http://127.0.0.1:7897"
                  value={form.outboundProxyUrl}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      outboundProxyUrl: e.target.value,
                    }))
                  }
                  disabled={loading || saving}
                />
              </Field>
              <Field
                label="No Proxy"
                hint="Comma-separated hostnames/domains to bypass the proxy"
              >
                <Input
                  placeholder="localhost,127.0.0.1"
                  value={form.outboundNoProxy}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      outboundNoProxy: e.target.value,
                    }))
                  }
                  disabled={loading || saving}
                />
              </Field>
            </Group>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={testing}
                onClick={test}
              >
                Test proxy URL
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={saving}>
                Apply
              </Button>
            </div>
          </form>
        ) : null}

        {status.message ? (
          <Notice tone={status.type === "error" ? "error" : "success"}>
            {status.message}
          </Notice>
        ) : null}
      </SectionBody>
    </>
  );
}
