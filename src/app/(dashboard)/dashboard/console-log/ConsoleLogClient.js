"use client";

import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { Card, Button, Input } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { translate } from "@/i18n/runtime";
import { parseLogLine, matchesFilters, LOG_LEVELS } from "@/lib/consoleLogParser";

// 终端风格日志视图（自维护特性，ADR 0003）：虚拟滚动 + 级别过滤 + 搜索 +
// 暂停 + 智能自动滚动 + 连接状态灯 + 行数统计 + 复制/清空。
// 行为对齐参考实现 llm-retry-proxy 的 logs 页面。

const ROW_H = 18; // px，行高固定（whitespace-pre 不换行），虚拟滚动的前提
const OVERSCAN = 30;
const BOTTOM_THRESHOLD = 40;
const LEVEL_COLORS = { ERROR: "text-red-400", WARN: "text-yellow-400", INFO: "text-blue-400", DEBUG: "text-purple-400", LOG: "text-green-400" };
const LEVEL_CHIP = {
  ERROR: "border-red-500/60 text-red-400",
  WARN: "border-yellow-500/60 text-yellow-400",
  INFO: "border-blue-500/60 text-blue-400",
  DEBUG: "border-purple-500/60 text-purple-400",
  LOG: "border-green-500/60 text-green-400",
};
// 旧 logger 的级别 emoji：行内已用级别标签展示级别，这些图标不再重复渲染
const LEVEL_EMOJIS = new Set(["❌", "💥", "⚠", "ℹ", "🔍", "⨯", "✗", "✘", "✖", "×"]);
// 日志 TAG（[CHAT]/[COMBO]/[RETRY]…）的彩色标签配色：按名称哈希取色，稳定可读
const TAG_COLORS = ["#f87171", "#fbbf24", "#34d399", "#60a5fa", "#a78bfa", "#f472b6", "#2dd4bf", "#f97316", "#a3e635", "#22d3ee"];
function tagColor(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}

// 复制文本：优先异步剪贴板 API，失败回退 execCommand（Electron 窗口内某些
// 场景 Cmd+C 会被系统/菜单吞掉，显式按钮不依赖快捷键）
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 走 execCommand 回退 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]); // 全量缓冲（上限 CONSOLE_LOG_CONFIG.maxLines）
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pausedCount, setPausedCount] = useState(0);
  const [levels, setLevels] = useState(null); // null = 全部
  const [query, setQuery] = useState("");
  const [range, setRange] = useState({ start: 0, end: 60 });
  const [atBottom, setAtBottom] = useState(true);
  const [total, setTotal] = useState(0); // 渲染节拍：rAF 内只在变化时 setTotal
  const logRef = useRef(null);
  const logsRef = useRef([]); // 真实缓冲，避免每条消息 setState
  const pausedRef = useRef(false);
  const pausedCountRef = useRef(0);
  const stickBottomRef = useRef(true);
  const versionRef = useRef(0);
  const rafRef = useRef(0);
  const parseCache = useRef(new Map());

  const scheduleRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setTotal(logsRef.current.length);
    });
  }, []);

  const bump = useCallback(() => {
    // 暂停时不刷新视图，新行进缓冲；恢复后一次性补齐
    if (pausedRef.current) return;
    scheduleRender();
  }, [scheduleRender]);

  // SSE 订阅（连接状态 + init/line/lines/clear）
  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    const cap = CONSOLE_LOG_CONFIG.maxLines;
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "init") {
        logsRef.current = msg.logs.slice(-cap);
      } else if (msg.type === "line") {
        logsRef.current.push(msg.line);
        if (logsRef.current.length > cap) logsRef.current.splice(0, logsRef.current.length - cap);
      } else if (msg.type === "lines") {
        logsRef.current.push(...msg.lines);
        if (logsRef.current.length > cap) logsRef.current.splice(0, logsRef.current.length - cap);
      } else if (msg.type === "clear") {
        logsRef.current = [];
        parseCache.current.clear();
      }
      if (pausedRef.current) { pausedCountRef.current += 1; setPausedCount(pausedCountRef.current); return; }
      bump();
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [bump]);

  // 过滤后的条目（解析结果按行字符串缓存，行上限内复用）
  const filtered = (() => {
    void total;
    const out = [];
    for (const line of logsRef.current) {
      let entry = parseCache.current.get(line);
      if (!entry) {
        entry = parseLogLine(line);
        if (parseCache.current.size > CONSOLE_LOG_CONFIG.maxLines * 2) parseCache.current.clear();
        parseCache.current.set(line, entry);
      }
      if (matchesFilters(entry, { levels, query })) out.push(entry);
    }
    return out;
  })();

  // 智能自动滚动：贴底才跟随
  useEffect(() => {
    const el = logRef.current;
    if (!el || !stickBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered.length, range]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    stickBottomRef.current = bottom;
    setAtBottom(bottom);
    const start = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN);
    const count = Math.ceil(el.clientHeight / ROW_H) + OVERSCAN * 2;
    setRange((prev) => (prev.start === start && prev.end === start + count ? prev : { start, end: start + count }));
  };

  const togglePause = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next) {
      pausedCountRef.current = 0;
      setPausedCount(0);
      bump();
    }
  };

  const scrollToBottom = () => {
    const el = logRef.current;
    if (!el) return;
    stickBottomRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  };

  const copyAll = async () => {
    const ok = await copyText(filtered.map((e) => e.raw).join("\n"));
    if (!ok) console.error("Failed to copy logs");
  };
  const [rowCopiedRaw, setRowCopiedRaw] = useState("");
  const copyRow = (raw) => {
    copyText(raw).then((ok) => {
      if (ok) {
        setRowCopiedRaw(raw);
        setTimeout(() => setRowCopiedRaw((prev) => (prev === raw ? "" : prev)), 900);
      }
    });
  };

  const toggleLevel = (lv) => {
    setLevels((prev) => {
      const next = new Set(prev ?? LOG_LEVELS);
      if (next.has(lv)) next.delete(lv);
      else next.add(lv);
      return next;
    });
  };

  const chip = (lv) => {
    const active = !levels || levels.has(lv);
    return (
      <button
        key={lv}
        onClick={() => toggleLevel(lv)}
        className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition-colors ${
          active ? LEVEL_CHIP[lv] : "border-border text-text-muted opacity-50"
        }`}
      >
        {lv}
      </button>
    );
  };

  const pad = (n) => String(n).padStart(5, " ");
  const slice = filtered.slice(range.start, range.end);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Card className="flex flex-1 flex-col min-h-0">
        {/* 工具栏：状态灯 / 搜索 / 级别过滤 / 行数 / 暂停 / 复制 / 清空 */}
        <div className="flex flex-wrap items-center gap-2 shrink-0 mb-2">
          <span className="flex items-center gap-1.5 mr-1" title={connected ? "SSE connected" : "reconnecting"}>
            <span className={`size-2 rounded-full ${connected ? "bg-green-500" : "bg-amber-500 animate-pulse"}`} />
            <span className={`text-[11px] ${connected ? "text-green-500" : "text-amber-500"}`}>
              {connected ? translate("Connected") : translate("Connecting…")}
            </span>
          </span>
          <div className="w-44 shrink-0">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={translate("Search logs…")}
              inputClassName="h-7 py-0 px-2 text-xs"
            />
          </div>
          {LOG_LEVELS.map(chip)}
          <span className="text-[11px] text-text-muted font-mono ml-auto">
            {pad(filtered.length)} / {pad(logsRef.current.length)} {translate("lines")}
          </span>
          <Button size="sm" variant="outline" icon={paused ? "play_arrow" : "pause"} onClick={togglePause}>
            {paused ? translate("Resume") : translate("Pause")}
            {paused && pausedCount > 0 && <span className="ml-1 text-primary">+{pausedCount}</span>}
          </Button>
          <Button size="sm" variant="outline" icon="content_copy" onClick={copyAll}>
            {translate("Copy All")}
          </Button>
          <ClearButton />
        </div>

        {/* 终端区（虚拟滚动，行高固定 + 横向滚动；高度 = 窗口剩余空间，内部滚动） */}
        <div className="relative flex-1 min-h-0">
          <div
            ref={logRef}
            onScroll={onScroll}
            data-irouter-log
            className="h-full bg-black rounded-lg px-4 py-2 text-xs font-mono overflow-auto"
          >
            {filtered.length === 0 ? (
              <span className="text-gray-500">{translate("No console logs yet.")}</span>
            ) : (
              <>
                <div style={{ height: range.start * ROW_H }} />
                {slice.map((e, i) => {
                  const idx = range.start + i;
                  const parts = [
                    e.time ? { k: "t", cls: "text-gray-500", v: e.time } : null,
                    { k: "l", cls: `${LEVEL_COLORS[e.level]} font-semibold`, v: e.level },
                    e.icon && !LEVEL_EMOJIS.has(e.icon) ? { k: "i", cls: "text-gray-400", v: e.icon } : null,
                    e.tag ? { k: "g", chip: true, v: e.tag, color: tagColor(e.tag) } : null,
                  ].filter(Boolean);
                  return (
                    <div
                      key={idx}
                      style={{ height: ROW_H }}
                      className="group/row relative whitespace-pre overflow-hidden select-text"
                    >
                      {parts.map((p, pi) => (
                        <Fragment key={p.k}>
                          {pi > 0 ? " " : ""}
                          {p.chip ? (
                            <span
                              className="inline-flex items-center rounded border px-1 font-semibold"
                              style={{ color: p.color, borderColor: `${p.color}66`, background: `${p.color}1a` }}
                            >
                              {p.v}
                            </span>
                          ) : (
                            <span className={p.cls}>{p.v}</span>
                          )}
                        </Fragment>
                      ))}
                      {" "}
                      <span className="text-gray-200">{e.text}</span>
                      <button
                        onClick={() => copyRow(e.raw)}
                        title="Copy this line"
                        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 p-0.5 rounded text-gray-400 hover:text-white transition-opacity"
                      >
                        <span className="material-symbols-outlined text-[13px]">
                          {rowCopiedRaw === e.raw ? "check" : "content_copy"}
                        </span>
                      </button>
                    </div>
                  );
                })}
                <div style={{ height: Math.max(0, filtered.length - range.end) * ROW_H }} />
              </>
            )}
          </div>
          {!atBottom && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-4 right-6 flex items-center justify-center size-8 rounded-full bg-primary text-white shadow-lg hover:opacity-90"
              title="Back to bottom"
            >
              <span className="material-symbols-outlined text-[18px]">keyboard_double_arrow_down</span>
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}

function ClearButton() {
  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };
  return (
    <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
      {translate("Clear")}
    </Button>
  );
}