/**
 * 使用统计图表工具模块
 * 提供模型名称智能分行与格式化辅助方法
 *
 * @author wei
 * @since 2026-10-16
 */

/**
 * 对长模型名称进行智能分行，防止超出 Y 轴宽度被裁切
 *
 * @param {string} text 原始模型名称
 * @param {number} [maxCharsPerLine=12] 单行最大字符数
 * @return {string[]} 分行后的字符串数组（最多 2 行）
 */
export function wrapModelName(text, maxCharsPerLine = 12) {
  if (!text || typeof text !== "string") return [""];
  if (text.length <= maxCharsPerLine) return [text];

  // 寻找接近中间或在合适范围内的分隔符（-、/、_、.、空格）
  const delimiters = ["-", "/", "_", ".", " "];
  let bestSplit = -1;
  let minDiffFromHalf = Infinity;
  const half = text.length / 2;

  for (let i = 3; i < text.length - 2; i++) {
    if (delimiters.includes(text[i])) {
      const len1 = i + 1;
      const len2 = text.length - (i + 1);
      if (len1 <= maxCharsPerLine + 3 && len2 <= maxCharsPerLine + 3) {
        const diff = Math.abs(i - half);
        if (diff < minDiffFromHalf) {
          minDiffFromHalf = diff;
          bestSplit = i + 1;
        }
      }
    }
  }

  // 若无合适分隔符，则在 maxCharsPerLine 处直接断开
  if (bestSplit === -1) {
    bestSplit = Math.min(maxCharsPerLine, Math.ceil(text.length / 2));
  }

  const line1 = text.slice(0, bestSplit);
  let line2 = text.slice(bestSplit);
  // 若第二行仍然超长（超过 15 字符），截断加省略号
  if (line2.length > 15) {
    line2 = line2.slice(0, 14) + "…";
  }

  return [line1, line2];
}
