/**
 * 版本号解析与比较工具模块
 * 提供符合语义化版本（SemVer）的版本号拆解与大小比较能力
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

/**
 * 解析语义化版本字符串
 * 自动剥离前导 'v' 字符，提取主版本号、次版本号与修订号
 *
 * @param {string} versionStr 待解析的版本字符串，例如 "v0.3.2" 或 "1.2.0"
 * @return {{ major: number, minor: number, patch: number } | null} 解析成功返回版本结构体，格式非法返回 null
 */
function parseVersion(versionStr) {
  if (!versionStr || typeof versionStr !== "string") {
    return null;
  }
  // 去除首尾空白与前导 v
  const clean = versionStr.trim().replace(/^v/i, "");
  // 提取数字版本号部分（忽略先行版本与构建元数据）
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * 比较两个版本号的大小
 * 遵循 SemVer 规则依次比对主版本、次版本和修订号
 *
 * @param {string} v1 第一个版本号
 * @param {string} v2 第二个版本号
 * @return {number} 若 v1 > v2 返回 1；若 v1 < v2 返回 -1；若相等返回 0；若存在不可解析版本返回 0
 */
function compareVersions(v1, v2) {
  const p1 = parseVersion(v1);
  const p2 = parseVersion(v2);
  if (!p1 || !p2) {
    return 0;
  }
  if (p1.major !== p2.major) {
    return p1.major > p2.major ? 1 : -1;
  }
  if (p1.minor !== p2.minor) {
    return p1.minor > p2.minor ? 1 : -1;
  }
  if (p1.patch !== p2.patch) {
    return p1.patch > p2.patch ? 1 : -1;
  }
  return 0;
}

/**
 * 判断目标版本是否大于当前版本（即是否存在可用新版本）
 *
 * @param {string} current 当前应用版本号
 * @param {string} latest 远端最新版本号
 * @return {boolean} 存在更高版本返回 true，否则返回 false
 */
function hasNewVersion(current, latest) {
  // 开发版（如 dev、local）不提示自动更新
  if (!current || current === "dev" || current === "local") {
    return false;
  }
  return compareVersions(latest, current) > 0;
}

module.exports = {
  parseVersion,
  compareVersions,
  hasNewVersion,
};
