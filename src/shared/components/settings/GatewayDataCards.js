"use client";

// 网关数据卡片：数据位置 + 配置导出/导入。
//
// 原先内联在 ShellSettingsModal 里，面板分栏后独立成文件；存储与网关数据合并为
// 一段后，这里只输出**卡片**（不带 SectionHeader/SectionBody），由 StorageSettings
// 的 SectionBody 统一给间距——一页里必须共用一套留白，否则接缝处的间距会和卡片
// 之间对不齐。
//
// 两张卡拆成两个组件是有意的：「数据位置」要放在这一页的**第一位**（用户要求），
// 而「配置文件」在最后；原先它们同属一个组件、只能整体挪。拆开后各自只取自己需要
// 的数据——数据位置只要路径，配置文件要登录态与密码再确认，两边的请求也分开了。
//
// 契约不变（ADR 0006）：
// - 桌面专属：模态框由壳层唤起，浏览器形态打不开，故这一段不会出现在浏览器里；
// - 密码**就地输入**，不嵌套第二个 Modal（Escape 与滚动锁都会打架）；
// - 未登录时禁用：该接口在 ALWAYS_PROTECTED，无 JWT 一律 401；
// - 路径由网关回报，不硬编码——桌面版默认 ~/.irouter，上游默认 ~/.9router。
import { useEffect, useRef, useState } from "react";
import Button from "@/shared/components/Button";
import { translate } from "@/i18n/runtime";
import { Field, Group, Notice, Row } from "./parts";

// 家目录前缀缩成 ~：完整路径会撑爆这一行
function shortenHome(p) {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/**
 * 数据位置卡片：网关把数据放在哪个 SQLite 文件里
 *
 * @return {JSX.Element} 单行卡片
 * @author wei
 * @since 2026-09-30
 */
export function DataLocationCard() {
  const [dbPath, setDbPath] = useState("");

  useEffect(() => {
    let alive = true;
    // 路径由网关回报：桌面版默认 ~/.irouter，上游默认 ~/.9router，DATA_DIR 还可覆盖。
    // 未登录时该请求 401，路径留空。
    fetch("/api/settings/database/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setDbPath(d?.path || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Group>
      <Row
        label="Data Location"
        hint="The SQLite file that holds your data"
      >
        <span
          className="max-w-[340px] truncate font-mono text-[12px] text-text-muted"
          title={dbPath || undefined}
        >
          {dbPath ? shortenHome(dbPath) : "—"}
        </span>
      </Row>
    </Group>
  );
}

/**
 * 配置文件卡片：配置的导出与导入（含密码再确认）
 *
 * @return {JSX.Element} 配置文件卡片
 * @author wei
 * @since 2026-09-29
 */
export function ConfigFileCard() {
  const [authed, setAuthed] = useState(null);
  const [pending, setPending] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });
  const fileRef = useRef(null);
  const pickedFileRef = useRef(null);
  // 导出是否"已完成、正等壳层回报落盘路径"。用 ref 而不是 state：它是事件配对的标志位，
  // 不需要触发重渲染（路径到了才 setStatus）。
  const awaitingSavedPathRef = useRef(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setAuthed(d?.authenticated === true);
      })
      .catch(() => {
        if (alive) setAuthed(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 导出是**静默**落到系统下载目录的：面板本来只知道"发出去了"。
  // 壳层在下载完成时发 `shell:download-saved { path }`（路径只有它知道——面板既不知道
  // 系统下载目录，也不知道重名去重后的 "name (1).json" 后缀），这里补在成功提示下面。
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.irouterShell : null;
    if (!api?.onDownloadSaved) return undefined;
    return api.onDownloadSaved((payload) => {
      // 只认"刚做过导出"的那一次：避免把将来的其它下载也贴到这张卡上
      if (!awaitingSavedPathRef.current) return;
      awaitingSavedPathRef.current = false;
      const savedPath = payload?.path;
      if (!savedPath) return;
      // 函数式更新：事件到达时可能晚于下面的 setStatus，不要覆盖 message
      setStatus((prev) => (prev.type === "success" ? { ...prev, path: savedPath } : prev));
    });
  }, []);

  const reset = () => {
    setPending("");
    setPassword("");
    pickedFileRef.current = null;
  };

  const startExport = () => {
    setStatus({ type: "", message: "" });
    setPassword("");
    setPending("export");
  };

  const onFilePicked = (event) => {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    pickedFileRef.current = file;
    setStatus({ type: "", message: "" });
    setPassword("");
    setPending("import");
  };

  const confirm = async () => {
    if (!password || busy) return;
    setBusy(true);
    setStatus({ type: "", message: "" });
    try {
      if (pending === "export") {
        const res = await fetch("/api/settings/database", {
          headers: { "x-9r-password": password },
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(translate(data.error || "Failed to export database"));
        }
        const blob = new Blob([JSON.stringify(await res.json(), null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `irouter-config-${new Date().toISOString().replace(/[.:]/g, "-")}.json`;
        // 先置标志再 click：下载事件走 IPC 回来，可能早于下面的 setStatus 落地
        awaitingSavedPathRef.current = true;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setStatus({ type: "success", message: "Configuration exported" });
        reset();
      } else {
        const file = pickedFileRef.current;
        if (!file) {
          reset();
          return;
        }
        const payload = JSON.parse(await file.text());
        const res = await fetch("/api/settings/database", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(translate(data.error || "Failed to import database"));
        }
        setStatus({ type: "success", message: "Configuration imported" });
        reset();
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: err.message || translate("Invalid backup file"),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group>
        <Field
          label="Configuration file"
          hint="Export or import settings, providers and keys. Usage and request logs are not included."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon="download"
              onClick={startExport}
              disabled={!authed || busy}
            >
              Export Configuration
            </Button>
            <Button
              variant="outline"
              size="sm"
              icon="upload"
              onClick={() => fileRef.current?.click()}
              disabled={!authed || busy}
            >
              Import Configuration
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={onFilePicked}
            />
          </div>
        </Field>

        {/* 敏感操作再确认：密码行就地展开，不弹第二个模态框 */}
        {pending ? (
          <div className="flex items-center gap-2 px-4 py-3">
            <input
              type="password"
              autoFocus
              value={password}
              placeholder="Password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              className="h-9 min-w-0 flex-1 rounded-[10px] border border-border bg-surface-2 px-3 text-[13px] text-text-main placeholder:text-text-muted/70 focus:ring-2 focus:ring-brand-500/30 focus:outline-none"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={confirm}
              disabled={!password}
              loading={busy}
            >
              Confirm
            </Button>
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : null}
      </Group>

      {authed === false ? (
        <Notice tone="info">Sign in to manage backups.</Notice>
      ) : null}

      {status.message ? (
        <Notice tone={status.type === "error" ? "error" : "success"}>
          {status.message}
          {status.path ? (
            // 完整路径（不缩成 ~）：用户要的是"文件到底在哪"，而这一行用 break-all 换行，
            // 不会撑破布局。title 再给一份，方便悬停复制。
            <div
              className="mt-1 font-mono text-[12px] leading-relaxed break-all opacity-80"
              title={status.path}
            >
              {status.path}
            </div>
          ) : null}
        </Notice>
      ) : null}
    </>
  );
}
