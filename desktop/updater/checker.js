/**
 * 远端版本更新检测与 Releases 查询模块
 * 负责从 GitHub Releases API 查询最新正式版并完成限流缓存与资产匹配
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

const https = require("node:https");
const { compareVersions, hasNewVersion } = require("./version");
const { selectAsset } = require("./asset");

const GITHUB_REPO = "kevinjoy89/iRouter";
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`;
const DEFAULT_RELEASE_PAGE = `https://github.com/${GITHUB_REPO}/releases`;
// 自动检查的静默限流缓存时长：4 小时
const CACHE_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * 默认的 HTTPS JSON 请求包装器
 *
 * @param {string} url 请求目标 URL
 * @param {object} headers 自定义请求头
 * @param {number} [timeoutMs=15000] 请求超时毫秒数
 * @return {Promise<any>} 解析后的 JSON 对象
 * @throws {Error} 网络异常或 HTTP 状态非 200 时抛出错误
 */
function defaultFetchJson(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {
          "User-Agent": "iRouter-Desktop",
          Accept: "application/vnd.github.v3+json",
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        // 重定向跟随（301/302）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          defaultFetchJson(res.headers.location, headers, timeoutMs)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub API HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${e.message}`));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Update check timed out"));
    });
    req.on("error", (err) => reject(err));
  });
}

/**
 * 检查应用版本更新
 *
 * @param {object} options 检查参数
 * @param {string} options.currentVersion 当前本地产品版本号
 * @param {string} options.platform 操作系统标识（darwin, win32, linux）
 * @param {string} options.arch 架构标识（arm64, x64）
 * @param {string} [options.installSource] 安装形态标识
 * @param {boolean} [options.force=false] 是否为用户手动触发（强制绕过限流缓存与忽略版本）
 * @param {object} [options.settings={}] 壳层设置对象（包含 lastCheckAt、ignoredVersion 等）
 * @param {Function} [options.fetchFn] 可注入的网络请求函数（供单元测试使用）
 * @return {Promise<object>} 更新检查结果对象
 */
async function checkForUpdates({
  currentVersion,
  platform,
  arch,
  installSource,
  force = false,
  settings = {},
  fetchFn = defaultFetchJson,
}) {
  const result = {
    current: currentVersion,
    latest: currentVersion,
    updateAvailable: false,
    releaseName: "",
    releaseNotes: "",
    releaseURL: DEFAULT_RELEASE_PAGE,
    assetName: "",
    downloadURL: "",
    assetSize: 0,
    checksumsURL: "",
    cached: false,
    error: null,
  };

  // 源码或开发构建在静默检查时不打扰
  if ((!currentVersion || currentVersion === "dev" || currentVersion === "local") && !force) {
    return result;
  }

  // 非强制检查时，检查是否命中 4 小时静默限流缓存
  if (!force && settings.lastCheckAt && settings.lastCheckResult) {
    const lastTime = new Date(settings.lastCheckAt).getTime();
    if (Date.now() - lastTime < CACHE_INTERVAL_MS) {
      return {
        ...settings.lastCheckResult,
        cached: true,
      };
    }
  }

  try {
    const releases = await fetchFn(RELEASES_API_URL, {
      "User-Agent": `iRouter-Desktop/${currentVersion}`,
    });

    if (!Array.isArray(releases) || releases.length === 0) {
      return result;
    }

    // 过滤 draft 和 prerelease，取第一个正式发布版本
    const latestRelease = releases.find((r) => r && !r.draft && !r.prerelease);
    if (!latestRelease) {
      return result;
    }

    const latestVersion = (latestRelease.tag_name || "").replace(/^v/i, "");
    result.latest = latestVersion;
    result.releaseName = latestRelease.name || latestRelease.tag_name;
    result.releaseNotes = latestRelease.body || "";
    result.releaseURL = latestRelease.html_url || DEFAULT_RELEASE_PAGE;

    // 匹配对应平台的二进制产物
    const matchedAsset = selectAsset(
      latestRelease.assets || [],
      latestVersion,
      platform,
      arch,
      installSource,
    );
    if (matchedAsset) {
      result.assetName = matchedAsset.name;
      result.downloadURL = matchedAsset.browser_download_url;
      result.assetSize = matchedAsset.size || 0;
    }

    // 寻找 release 中附带的 checksums.txt 资产
    const checksumsAsset = (latestRelease.assets || []).find(
      (a) => a && a.name === "checksums.txt",
    );
    if (checksumsAsset) {
      result.checksumsURL = checksumsAsset.browser_download_url;
    }

    // 判断是否存在更新
    const isNew = hasNewVersion(currentVersion, latestVersion);
    // 用户忽略该版本时，非强制检查静默跳过更新提示
    if (isNew && !force && settings.ignoredVersion === latestVersion) {
      result.updateAvailable = false;
    } else {
      result.updateAvailable = isNew;
    }

    return result;
  } catch (err) {
    result.error = err.message || "Failed to check for updates";
    return result;
  }
}

module.exports = {
  GITHUB_REPO,
  RELEASES_API_URL,
  DEFAULT_RELEASE_PAGE,
  CACHE_INTERVAL_MS,
  checkForUpdates,
};
