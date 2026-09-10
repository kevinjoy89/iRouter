import { describe, expect, it } from "vitest";
import { buildOffsets, indexAtOffset, visibleRange } from "../../src/lib/consoleLogVirtual.js";

const items = [0, 1, 2, 3, 4];
const heights = [26, 58, 26, 90, 26]; // 行 1、3 为换行多行
const starts = buildOffsets(items, (i) => heights[i]);
// starts: [0, 26, 84, 110, 200, 226]

describe("buildOffsets", () => {
  it("prefix sums include total at index n", () => {
    expect(Array.from(starts)).toEqual([0, 26, 84, 110, 200, 226]);
    expect(buildOffsets([], () => 1)).toEqual(new Float64Array([0]));
  });
});

describe("indexAtOffset", () => {
  it("finds row containing offset", () => {
    expect(indexAtOffset(starts, 0)).toBe(0);
    expect(indexAtOffset(starts, 25.9)).toBe(0);
    expect(indexAtOffset(starts, 26)).toBe(1);
    expect(indexAtOffset(starts, 109.5)).toBe(2);
    expect(indexAtOffset(starts, 500)).toBe(5); // 越界钳到内容末尾（= n，语义：末行之后）
    expect(indexAtOffset(starts, -5)).toBe(0);
  });
});

describe("visibleRange", () => {
  it("covers viewport plus overscan", () => {
    // 视口 y=90 高 200，overscan 50 → 需要覆盖 [40, 340]
    const { start, end } = visibleRange(starts, 90, 200, 50);
    expect(start).toBe(1); // 行 1 起点 26 ≤ 40
    expect(end).toBe(5);   // 末行（唯一能盖住 340 的）
  });

  it("clamps to bounds", () => {
    expect(visibleRange(starts, 0, 80, 10)).toEqual({ start: 0, end: 3 });
    const top = visibleRange(starts, 226, 80, 10);
    expect(top.end).toBe(5);
  });
});
