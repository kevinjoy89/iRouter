/**
 * 发布产物匹配与安装来源解析模块
 * 根据操作系统平台、CPU 架构与安装形态匹配 GitHub Release 中的对应 Asset
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

/**
 * 根据平台、架构与安装源生成预期的产物文件名
 *
 * @param {string} version 版本号（如 "0.3.2" 或 "v0.3.2"）
 * @param {string} platform 操作系统平台标识（如 "darwin", "win32", "linux"）
 * @param {string} arch CPU 架构（如 "arm64", "x64"）
 * @param {string} [installSource] 安装来源标识（如 "installer", "portable", "deb", "tarball", "dmg"）
 * @return {string} 预期的资产文件名，若无匹配规则返回空字符串
 */
function getExpectedAssetName(version, platform, arch, installSource) {
  const cleanVersion = String(version || "").trim().replace(/^v/i, "");
  if (!cleanVersion) {
    return "";
  }
  const normalizedArch = arch === "x64" ? "amd64" : arch;

  if (platform === "darwin") {
    // macOS 产物：iRouter-<v>-macos-<arch>.dmg
    return `iRouter-${cleanVersion}-macos-${arch === "arm64" ? "arm64" : "amd64"}.dmg`;
  }

  if (platform === "win32") {
    // Windows 产物分安装版与绿色便携版
    if (installSource === "portable") {
      return `iRouter-${cleanVersion}-windows-amd64-portable.zip`;
    }
    return `iRouter-${cleanVersion}-windows-amd64-installer.exe`;
  }

  if (platform === "linux") {
    // Linux 产物分 deb 包与 tar.gz 归档包
    if (installSource === "tarball" || installSource === "tar.gz") {
      return `iRouter-${cleanVersion}-linux-amd64.tar.gz`;
    }
    return `iRouter-${cleanVersion}-linux-amd64.deb`;
  }

  return "";
}

/**
 * 在 Release 的 Assets 列表中挑选与当前运行环境匹配的产物
 *
 * @param {Array<object>} assets GitHub Release 的 assets 列表
 * @param {string} version 目标版本号
 * @param {string} platform 操作系统平台
 * @param {string} arch CPU 架构
 * @param {string} [installSource] 安装来源标识
 * @return {object | null} 匹配到的 asset 对象，未匹配到返回 null
 */
function selectAsset(assets, version, platform, arch, installSource) {
  if (!Array.isArray(assets) || assets.length === 0) {
    return null;
  }
  const expectedName = getExpectedAssetName(version, platform, arch, installSource);
  if (!expectedName) {
    return null;
  }
  // 精确匹配文件名
  const matched = assets.find((a) => a && a.name === expectedName);
  if (matched) {
    return matched;
  }
  // 容错备选：针对 Linux/Windows 尝试对等形态备选
  if (platform === "linux") {
    const fallbackName = installSource === "tarball"
      ? getExpectedAssetName(version, platform, arch, "deb")
      : getExpectedAssetName(version, platform, arch, "tarball");
    const fallback = assets.find((a) => a && a.name === fallbackName);
    if (fallback) {
      return fallback;
    }
  }
  return null;
}

module.exports = {
  getExpectedAssetName,
  selectAsset,
};
