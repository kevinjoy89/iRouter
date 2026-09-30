// 存储面板状态判定的单测
//
// 覆盖用户实测反馈的两个问题：
// 1. 一打开设置面板就显示绿色「没有需要清理的内容」——把状态文件里的**历史结果**当成了本次结果；
// 2. 点「Save & clean now」后按钮一闪而过，看不到任何结果（清理改为后台执行后返回只要 ~10ms）。
import { describe, it, expect } from "vitest";
import {
  describeStorageFeedback,
  formatStorageFeedback,
  formatBytes,
} from "@/shared/components/settings/storageFeedback.js";

// 状态文件里留下的「上一次运行」结果
const HISTORICAL = {
  running: false,
  phase: "done",
  days: 3,
  deleted: 0,
  reclaimed: 2363261056,
  finishedAt: 1790693484627,
  error: null,
  needsOfflineCompaction: false,
};

const translate = (s) => s; // 单测里只校验结构，不做真实翻译

describe("存储面板状态判定", () => {
  it("打开面板时不显示任何历史结果（这就是那条绿色「没有需要清理的内容」的根因）", () => {
    const feedback = describeStorageFeedback(HISTORICAL, null);
    expect(feedback.kind).toBe("idle");
    expect(formatStorageFeedback(feedback, translate)).toBe("");
  });

  it("清理进行中：显示进度，不做其他判定", () => {
    const feedback = describeStorageFeedback({ ...HISTORICAL, running: true, deleted: 42 }, null);
    expect(feedback.kind).toBe("running");
    expect(feedback.deleted).toBe(42);
    expect(formatStorageFeedback(feedback, translate)).toBe("Cleaning in the background · 42 removed");
  });

  it("本次点击删除了记录：显示条数与回收空间", () => {
    const feedback = describeStorageFeedback(
      { ...HISTORICAL, deleted: 903, reclaimed: 12345678 },
      { deleted: 903, reclaimed: 12345678 }
    );
    expect(feedback.kind).toBe("result");
    const text = formatStorageFeedback(feedback, translate);
    expect(text).toContain("903");
    expect(text).toContain("reclaimed");
    expect(text).toContain("11.8 MB");
  });

  it("本次点击没有超期记录：给出自解释文案，而不是「没有需要清理的内容」", () => {
    const feedback = describeStorageFeedback(HISTORICAL, { deleted: 0, reclaimed: 0 });
    expect(feedback.kind).toBe("result");
    expect(formatStorageFeedback(feedback, translate)).toBe(
      "No entries older than the retention window"
    );
  });

  it("本次点击失败：显示失败原因", () => {
    const feedback = describeStorageFeedback(HISTORICAL, { deleted: 0, error: "disk I/O error" });
    expect(feedback.kind).toBe("failed");
    expect(formatStorageFeedback(feedback, translate)).toContain("disk I/O error");
  });

  it("老库提示与结果文案互不冲突", () => {
    const legacy = { ...HISTORICAL, needsOfflineCompaction: true };
    expect(describeStorageFeedback(legacy, null)).toMatchObject({ kind: "idle", offlineHint: true });
    expect(describeStorageFeedback(legacy, { deleted: 5, reclaimed: 1024 })).toMatchObject({
      kind: "result",
      offlineHint: true,
    });
  });

  it("状态文件缺失/损坏时按 idle 处理，不抛异常", () => {
    expect(describeStorageFeedback(null, null).kind).toBe("idle");
    expect(describeStorageFeedback(undefined, undefined).kind).toBe("idle");
    expect(describeStorageFeedback({}, {}).kind).toBe("result");
  });

  it("体积格式化", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(752852992)).toBe("718.0 MB");
  });
});
