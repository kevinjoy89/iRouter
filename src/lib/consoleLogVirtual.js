// 变高虚拟滚动的纯计算部分：行高不定（自动换行），用「测量高度缺失时取估值」
// 的前缀和 + 二分查找定位可视区间。供 ConsoleLogClient 使用，独立成纯函数便于单测。

// starts[i] = 第 i 行顶部相对内容顶部的偏移；starts[n] = 总内容高。
export function buildOffsets(items, heightOf) {
  const starts = new Float64Array(items.length + 1);
  for (let i = 0; i < items.length; i++) {
    starts[i + 1] = starts[i] + heightOf(items[i]);
  }
  return starts;
}

// 最大 i 使得 starts[i] <= y（返回值可为 n，即内容末尾）。二分，O(log n)。
export function indexAtOffset(starts, y) {
  let lo = 0;
  let hi = starts.length - 1;
  if (y < 0) y = 0;
  if (y > starts[hi]) y = starts[hi];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// 可视区间 [start, end)（含上下各 overscanPx 的过扫描），y 为相对内容顶部（已扣内边距）。
export function visibleRange(starts, y, viewportH, overscanPx) {
  const n = starts.length - 1;
  if (n === 0) return { start: 0, end: 0 };
  // 首行钳到 n-1：滚动位置越过末行起点时仍至少渲染末行
  const start = Math.min(indexAtOffset(starts, y - overscanPx), n - 1);
  const endRaw = indexAtOffset(starts, y + viewportH + overscanPx);
  // end 指向的行起点恰好越过视口底时仍要包含它（部分可见行）
  const end = Math.min(n, endRaw + 1);
  return { start, end };
}
