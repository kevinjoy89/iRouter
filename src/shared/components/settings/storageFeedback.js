// 存储面板的状态文案判定（纯函数，便于直接测）
//
// 抽出来的原因：这里曾经出过两个用户可见的 bug——
// 1. 打开面板就把状态文件里**上一次**运行的结果当成「刚刚发生了什么」显示（绿色「没有需要清理的内容」）；
// 2. 点击后因清理改为后台执行，按钮一闪而过、最终结果没机会显示。
// 判定逻辑与渲染分离后，这些分支都能被单测覆盖。

/**
 * 字节数转可读体积
 *
 * @param {number} bytes 字节数
 * @return {string} 例如 "10.31 GB"
 * @author wei
 * @since 2026-09-29
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 决定存储面板该显示什么
 *
 * @param {object|null} maintenance 服务端状态文件里的维护状态（含历史结果）
 * @param {object|null} result 本次点击产生的结果；未点击过传 null
 * @return {{kind: "idle"|"running"|"result"|"failed", deleted?: number, reclaimed?: number, error?: string, offlineHint: boolean}}
 *   - idle：什么都不显示（**历史结果不算结果**）
 *   - running：清理中，显示进度
 *   - result：本次清理完成，显示删除条数/回收空间
 *   - failed：本次清理失败
 *   offlineHint：老库需要「退出后压缩」的提示（与上面几种互不冲突）
 * @author wei
 * @since 2026-09-29
 */
export function describeStorageFeedback(maintenance, result) {
  const offlineHint = maintenance?.needsOfflineCompaction === true;

  if (maintenance?.running === true) {
    return { kind: "running", deleted: maintenance.deleted ?? 0, offlineHint: false };
  }
  if (!result) {
    // 关键：没有本次点击的结果时一律 idle。状态文件里的 finishedAt/deleted 是历史值，
    // 打开面板就把它渲染出来会让人以为刚刚发生了清理。
    return { kind: "idle", offlineHint };
  }
  if (result.error) {
    return { kind: "failed", error: String(result.error), offlineHint };
  }
  return {
    kind: "result",
    deleted: result.deleted ?? 0,
    reclaimed: result.reclaimed ?? 0,
    offlineHint,
  };
}

/**
 * 把判定结果翻成一句话（数字与单位用 translate 片段拼，保证可本地化）
 *
 * @param {object} feedback describeStorageFeedback 的返回值
 * @param {(text: string) => string} translate 翻译函数
 * @return {string} 展示文案；kind 为 idle 时返回空串
 * @author wei
 * @since 2026-09-29
 */
export function formatStorageFeedback(feedback, translate) {
  if (!feedback || feedback.kind === "idle") return "";
  if (feedback.kind === "running") {
    return `${translate("Cleaning in the background")} · ${feedback.deleted} ${translate("removed")}`;
  }
  if (feedback.kind === "failed") {
    return `${translate("Cleanup failed")}: ${feedback.error}`;
  }
  if (feedback.deleted > 0) {
    const reclaimed = feedback.reclaimed > 0
      ? ` · ${translate("reclaimed")} ${formatBytes(feedback.reclaimed)}`
      : "";
    return `${translate("Removed")} ${feedback.deleted} ${translate("expired entries")}${reclaimed}`;
  }
  return translate("No entries older than the retention window");
}
