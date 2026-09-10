"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { translate } from "@/i18n/runtime";
import { parseLogLine, matchesFilters, LOG_LEVELS } from "@/lib/consoleLogParser";
import { buildOffsets, visibleRange } from "@/lib/consoleLogVirtual";

// 终端风格日志视图（自维护特性，ADR 0003）：整块深色面板 + 双行工具条 +
// 变高虚拟滚动（行自动换行，ResizeObserver 实测行高 + 前缀和偏移 + 二分定位，
// 视口上方行高变化时滚动锚定）+ 级别过滤 + 搜索 + 暂停 + 智能自动滚动 + 复制/清空。
// 面板内颜色一律用固定色值（内联 style），不用 Tailwind 调色板类：
// 构建期扫描会静默漏掉本文件（历史 bug：唯一使用处的 text-gray-200 未生成，
// 浅色模式黑底黑字）。布局类取自通用池，丢失也只是排版退化。

const EST_H = 26; // 未测量行的估值高度（单行）；换行行由 ResizeObserver 实测修正
const PAD_Y = 8; // 日志区上下内边距
const OVERSCAN_PX = 600; // 视口上下过扫描
const BOTTOM_THRESHOLD = 40;
// 级别配色（固定色值）：LOG 用中性灰，避免与 INFO 撞色
const LEVEL_COLORS = { ERROR: "#f87171", WARN: "#fbbf24", INFO: "#4ade80", DEBUG: "#c084fc", LOG: "#94a3b8" };
// 旧 logger 的级别 emoji：行内已用级别徽章展示级别，这些图标不再重复渲染
const LEVEL_EMOJIS = new Set(["❌", "💥", "⚠", "ℹ", "🔍", "⨯", "✗", "✘", "✖", "×"]);
// 会话关联色点（🟢🔵🟣…）已由级别徽章/标签承担信息，不再显示
const SESSION_DOTS = new Set(["🟢", "🔵", "🟣", "🟡", "🟠", "🔴", "⚪", "🟤"]);
// 日志 TAG（[CHAT]/[COMBO]/[RETRY]…）降噪展示：小色点 + 灰字，不再占徽章位
const TAG_COLORS = ["#f87171", "#fbbf24", "#34d399", "#60a5fa", "#a78bfa", "#f472b6", "#2dd4bf", "#f97316", "#a3e635", "#22d3ee"];
function tagColor(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}
const fmt = (n) => n.toLocaleString("en-US");

// 深色面板内的小按钮（图标 + 文案）；hover 反馈用内联事件，避免依赖工具类
function DarkButton({ icon, onClick, title, style, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.1)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
      className="inline-flex items-center gap-1 rounded-md"
      style={{ border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#c9cdd4", fontSize: 12, padding: "4px 10px", ...style }}
    >
      {icon ? <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{icon}</span> : null}
      {children}
    </button>
  );
}

// 级别过滤：checkbox 风格（方框勾选 + 彩色文字），未选中整组降透明度
function LevelFilter({ lv, color, active, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={lv}
      className="inline-flex items-center gap-1.5"
      style={{ opacity: active ? 1 : 0.35, transition: "opacity .15s" }}
    >
      <span
        className="inline-flex items-center justify-center"
        style={{ width: 13, height: 13, borderRadius: 3, border: `1px solid ${color}`, background: active ? color : "transparent", color: "#0d0f12", fontSize: 10, fontWeight: 800, lineHeight: 1 }}
      >
        {active ? "✓" : ""}
      </span>
      <span style={{ color, fontSize: 12, fontWeight: 700 }}>{lv}</span>
    </button>
  );
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
  const [total, setTotal] = useState(0); // 已接收（缓冲区行数）；渲染节拍：rAF 内只在变化时 setState
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pausedCount, setPausedCount] = useState(0);
  const [levels, setLevels] = useState(null); // null = 全部
  const [query, setQuery] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [tick, setTick] = useState(0); // 滚动/行高测量触发的重绘节拍
  const [copied, setCopied] = useState(false); // 复制全部后的短暂反馈
  const logRef = useRef(null);
  const logsRef = useRef([]); // 全量缓冲：{ seq, line }；seq 单调递增，作行高测量键
  const pausedRef = useRef(false);
  const pausedCountRef = useRef(0);
  const stickBottomRef = useRef(true);
  const parseCache = useRef(new Map());
  const heightsRef = useRef(new Map()); // seq -> 实测行高（未测行用 EST_H）
  const scrollTopRef = useRef(0);
  const firstVisibleSeqRef = useRef(null); // 滚动锚定：视口首行 seq
  const seqRef = useRef(0);
  const tickRafRef = useRef(0);
  const roRef = useRef(null);
  const copiedTimerRef = useRef(0);
  const seqByElRef = useRef(new WeakMap()); // 行 DOM -> seq

  const scheduleTick = useCallback(() => {
    if (tickRafRef.current) return;
    tickRafRef.current = requestAnimationFrame(() => {
      tickRafRef.current = 0;
      setTotal(logsRef.current.length);
      setTick((t) => t + 1);
    });
  }, []);

  const bump = useCallback(() => {
    // 暂停时不刷新视图，新行进缓冲；恢复后一次性补齐
    if (pausedRef.current) return;
    scheduleTick();
  }, [scheduleTick]);

  // SSE 订阅（连接状态 + init/line/lines/clear）
  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    const cap = CONSOLE_LOG_CONFIG.maxLines;
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const push = (line) => {
        const item = { seq: ++seqRef.current, line };
        logsRef.current.push(item);
        return item;
      };
      if (msg.type === "init") {
        logsRef.current = [];
        parseCache.current.clear();
        heightsRef.current.clear();
        for (const line of msg.logs.slice(-cap)) push(line);
      } else if (msg.type === "line") {
        push(msg.line);
        if (logsRef.current.length > cap) {
          const removed = logsRef.current.splice(0, logsRef.current.length - cap);
          for (const it of removed) heightsRef.current.delete(it.seq);
        }
      } else if (msg.type === "lines") {
        for (const line of msg.lines) push(line);
        if (logsRef.current.length > cap) {
          const removed = logsRef.current.splice(0, logsRef.current.length - cap);
          for (const it of removed) heightsRef.current.delete(it.seq);
        }
      } else if (msg.type === "clear") {
        logsRef.current = [];
        parseCache.current.clear();
        heightsRef.current.clear();
      }
      if (pausedRef.current) { pausedCountRef.current += 1; setPausedCount(pausedCountRef.current); return; }
      bump();
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [bump]);

  // 行高实测：换行行高度不定，渲染后由 ResizeObserver 回填，并做滚动锚定
  useEffect(() => {
    roRef.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const en of entries) {
        const seq = seqByElRef.current.get(en.target);
        if (seq == null) continue;
        const h = en.target.offsetHeight;
        const old = heightsRef.current.get(seq) ?? EST_H;
        if (h && Math.abs(h - old) > 0.5) {
          heightsRef.current.set(seq, h);
          // 锚定：视口上方的行高变化直接补偿 scrollTop，避免滚动位置跳动
          const fvs = firstVisibleSeqRef.current;
          if (fvs != null && seq < fvs && logRef.current) logRef.current.scrollTop += h - old;
          changed = true;
        }
      }
      if (changed) scheduleTick();
    });
    return () => roRef.current?.disconnect();
  }, [scheduleTick]);

  // 过滤后的条目（解析结果按行字符串缓存，行上限内复用）
  const filtered = (() => {
    const out = [];
    for (const item of logsRef.current) {
      let entry = parseCache.current.get(item.line);
      if (!entry) {
        entry = parseLogLine(item.line);
        if (parseCache.current.size > CONSOLE_LOG_CONFIG.maxLines * 2) parseCache.current.clear();
        parseCache.current.set(item.line, entry);
      }
      if (matchesFilters(entry, { levels, query })) out.push({ seq: item.seq, entry });
    }
    return out;
  })();

  // 变高虚拟滚动：前缀和偏移 + 二分定位可视区间（含过扫描）
  const heightOf = (it) => heightsRef.current.get(it.seq) ?? EST_H;
  const starts = buildOffsets(filtered, heightOf);
  const totalH = starts[filtered.length] + 2 * PAD_Y;
  const viewH = (typeof window !== "undefined" && logRef.current?.clientHeight) || 600;
  const { start, end } = visibleRange(starts, scrollTopRef.current, viewH, OVERSCAN_PX);
  firstVisibleSeqRef.current = filtered[start]?.seq ?? null;
  const rows = filtered.slice(start, end);

  // 智能自动滚动：贴底才跟随（每次提交后校正，流式追加与行高实测都保持贴底）
  useEffect(() => {
    const el = logRef.current;
    if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    stickBottomRef.current = bottom;
    setAtBottom(bottom);
    scheduleTick();
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
    const ok = await copyText(filtered.map((it) => it.entry.raw).join("\n"));
    if (!ok) {
      console.error("Failed to copy logs");
      return;
    }
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  const toggleLevel = (lv) => {
    setLevels((prev) => {
      const next = new Set(prev ?? LOG_LEVELS);
      if (next.has(lv)) next.delete(lv);
      else next.add(lv);
      return next;
    });
  };

  const statusColor = connected ? "#4ade80" : "#fbbf24";
  const statusText = !connected ? "重连中" : paused ? "已暂停" : "LIVE";
  void tick;

  // React 19：ref 回调返回清理函数，卸载时解除观察（RO 对 target 持强引用）
  const rowRef = (seq) => (el) => {
    if (!el) return;
    seqByElRef.current.set(el, seq);
    roRef.current?.observe(el);
    return () => roRef.current?.unobserve(el);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div
        className="relative flex flex-1 flex-col min-h-0 rounded-lg overflow-hidden"
        style={{ background: "#0d0f12", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        {/* 工具行：状态灯 / 暂停·复制·清空 / 级别过滤 / 搜索 */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <span className="flex items-center gap-1.5 mr-2" title={connected ? "SSE connected" : "reconnecting"}>
            <span className={`size-2 rounded-full ${connected ? "" : "animate-pulse"}`} style={{ background: statusColor }} />
            <span style={{ color: statusColor, fontSize: 12 }}>
              {connected ? translate("Connected") : translate("Connecting…")}
            </span>
          </span>
          <DarkButton icon={paused ? "play_arrow" : "pause"} onClick={togglePause}>
            {paused ? translate("Resume") : translate("Pause")}
            {paused && pausedCount > 0 ? <span style={{ color: "#E56A4A" }}>+{pausedCount}</span> : null}
          </DarkButton>
          <DarkButton
            icon={copied ? "check" : "content_copy"}
            onClick={copyAll}
            title={copied ? translate("Copied") : translate("Copy All")}
            style={copied ? { color: "#4ade80", borderColor: "rgba(74,222,128,0.45)" } : undefined}
          >
            {copied ? translate("Copied") : translate("Copy All")}
          </DarkButton>
          <ClearButton />
          <span className="flex-1" />
          {LOG_LEVELS.map((lv) => (
            <LevelFilter
              key={lv}
              lv={lv}
              color={LEVEL_COLORS[lv]}
              active={!levels || levels.has(lv)}
              onToggle={() => toggleLevel(lv)}
            />
          ))}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={translate("Search logs…")}
            className="h-7 w-52 px-2.5 rounded-md outline-none"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e5e7eb", fontSize: 12 }}
          />
        </div>

        {/* 状态行：日志流 / 已接收 / 可见 / LIVE */}
        <div className="flex items-center gap-4 px-4 py-1.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <span style={{ color: "#c9cdd4", fontSize: 12, fontWeight: 600 }}>{translate("Log Stream")}</span>
          <span style={{ color: "#8b8f98", fontSize: 11 }}>
            {translate("Received")} <span style={{ color: "#c9cdd4", fontVariantNumeric: "tabular-nums" }}>{fmt(total)}</span>
          </span>
          <span style={{ color: "#8b8f98", fontSize: 11 }}>
            {translate("Visible")} <span style={{ color: "#c9cdd4", fontVariantNumeric: "tabular-nums" }}>{fmt(filtered.length)}</span>
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: statusColor }} />
            <span style={{ color: statusColor, fontSize: 11, letterSpacing: "0.08em" }}>{statusText}</span>
          </span>
        </div>

        {/* 终端区：变高虚拟滚动（绝对定位行 + 实测高度前缀和） */}
        <div ref={logRef} onScroll={onScroll} data-irouter-log className="flex-1 min-h-0 overflow-auto font-mono text-xs">
          <div className="relative" style={{ height: totalH }}>
            {filtered.length === 0 ? (
              <div className="absolute" style={{ top: PAD_Y, left: 16, color: "#8b8f98" }}>{translate("No console logs yet.")}</div>
            ) : (
              rows.map((it, i) => {
                const e = it.entry;
                const color = LEVEL_COLORS[e.level] || LEVEL_COLORS.LOG;
                const showIcon = e.icon && !LEVEL_EMOJIS.has(e.icon) && !SESSION_DOTS.has(e.icon);
                return (
                  <div
                    key={it.seq}
                    ref={rowRef(it.seq)}
                    className="flex items-start select-text"
                    style={{ position: "absolute", top: PAD_Y + starts[start + i], left: 16, right: 16, padding: "1px 0" }}
                  >
                    {e.time ? <span style={{ color: "#8b8f98", flexShrink: 0, marginTop: 1 }}>{e.time}</span> : null}
                    <span
                      className="inline-flex items-center justify-center rounded"
                      style={{ color, background: `${color}26`, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", padding: "1px 7px", margin: "1px 10px 0 8px", flexShrink: 0 }}
                    >
                      {e.level}
                    </span>
                    {showIcon ? <span style={{ color: "#9aa0ab", marginRight: 8 }}>{e.icon}</span> : null}
                    {e.tag ? (
                      <span className="inline-flex items-center gap-1.5" style={{ marginRight: 8, flexShrink: 0, marginTop: 1 }}>
                        <span style={{ width: 5, height: 5, borderRadius: 999, background: tagColor(e.tag), display: "inline-block" }} />
                        <span style={{ color: "#9aa0ab" }}>{e.tag}</span>
                      </span>
                    ) : null}
                    <span style={{ color: "#e5e7eb", flex: 1, minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{e.text}</span>
                  </div>
                );
              })
            )}
          </div>
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
    <DarkButton icon="delete" onClick={handleClear}>
      {translate("Clear")}
    </DarkButton>
  );
}
