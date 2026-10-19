/**
 * 使用统计图表工具模块
 * 提供模型名称智能分行与格式化辅助方法
 *
 * @author wei
 * @since 2026-10-16
 */

/**
 * 检查指定索引位置是否为合法换行分隔符
 * 排除数字之间的小数点（如 3.0、v4.1），避免破坏版本号和浮点数语义
 *
 * @param {string} text 文本字符串
 * @param {number} index 当前字符索引
 * @return {boolean} 是否为合法分隔符
 */
function isValidBreakPoint(text, index) {
  const char = text[index];
  if (char === "-" || char === "/" || char === "_" || char === " ") {
    return true;
  }
  if (char === ".") {
    const prev = text[index - 1];
    const next = text[index + 1];
    const prevIsDigit = prev >= "0" && prev <= "9";
    const nextIsDigit = next >= "0" && next <= "9";
    if (!prevIsDigit || !nextIsDigit) {
      return true;
    }
  }
  return false;
}

/**
 * 对长模型名称进行贪心自动换行（撑满第一行才换行，且杜绝在版本号小数点处折断）
 *
 * @param {string} text 原始模型名称
 * @param {number} [maxCharsPerLine=14] 单行最大字符数
 * @return {string[]} 分行后的字符串数组（最多 2 行）
 */
export function wrapModelName(text, maxCharsPerLine = 14) {
  if (!text || typeof text !== "string") return [""];
  if (text.length <= maxCharsPerLine) return [text];

  // 贪心策略：从 maxCharsPerLine 位置倒序寻找最靠右的合法断行分隔符（撑满第一行才换行）
  let bestSplit = -1;
  const searchLimit = Math.min(text.length - 1, maxCharsPerLine);

  for (let i = searchLimit; i >= 3; i--) {
    if (isValidBreakPoint(text, i)) {
      bestSplit = i + 1;
      break;
    }
  }

  // 若在可用长度范围内未找到任何合法分隔符，则直接在 maxCharsPerLine 处硬切断
  if (bestSplit === -1) {
    bestSplit = maxCharsPerLine;
  }

  const line1 = text.slice(0, bestSplit);
  let line2 = text.slice(bestSplit);
  // 若第二行仍然超长（超过 16 字符），截断加省略号
  if (line2.length > 16) {
    line2 = line2.slice(0, 15) + "…";
  }

  return [line1, line2];
}
