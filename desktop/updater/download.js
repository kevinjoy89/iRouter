/**
 * 文件流式下载与重定向跟随模块
 * 负责安全下载 Release 资产与校验文件，支持进度反馈、原子重命名与取消清理
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const http = require("node:http");

/**
 * 获取用户默认的下载目录路径
 *
 * @return {string} 下载目录绝对路径
 */
function getDefaultDownloadsDir() {
  return path.join(os.homedir(), "Downloads");
}

/**
 * 抓取远程文本资源（用于获取 checksums.txt）
 *
 * @param {string} url 目标 URL
 * @param {number} [timeoutMs=15000] 超时时间
 * @return {Promise<string>} 文本内容
 * @throws {Error} 请求失败或状态非 200 时抛出异常
 */
function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https:") ? https : http;
    const req = protocol.get(
      url,
      {
        headers: { "User-Agent": "iRouter-Desktop" },
        timeout: timeoutMs,
      },
      (res) => {
        // 重定向跟随（301/302）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchText(res.headers.location, timeoutMs)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve(data));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.on("error", (err) => reject(err));
  });
}

/**
 * 流式下载文件到指定目录
 *
 * @param {object} options 下载参数配置
 * @param {string} options.url 待下载资源的直接或重定向 URL
 * @param {string} [options.destinationDir] 保存目录，默认使用系统 Downloads 目录
 * @param {string} options.fileName 目标文件名
 * @param {number} [options.sizeHint=0] 预期文件大小（服务端未传 Content-Length 时的后备参考）
 * @param {Function} [options.onProgress] 进度回调函数 ({ downloaded, total, percent }) => void
 * @param {AbortSignal} [options.abortSignal] 用于中断取消下载的信号量
 * @return {Promise<string>} 下载成功后的完整文件路径
 * @throws {Error} 下载中断、网络异常或文件写入错误时抛出异常
 */
function downloadFile({
  url,
  destinationDir = getDefaultDownloadsDir(),
  fileName,
  sizeHint = 0,
  onProgress,
  abortSignal,
}) {
  return new Promise((resolve, reject) => {
    if (!url || !fileName) {
      reject(new Error("URL and fileName are required for download"));
      return;
    }

    if (abortSignal && abortSignal.aborted) {
      reject(new Error("Download aborted"));
      return;
    }

    try {
      fs.mkdirSync(destinationDir, { recursive: true });
    } catch (e) {
      reject(new Error(`Failed to create directory: ${e.message}`));
      return;
    }

    const partPath = path.join(destinationDir, `${fileName}.part`);
    const finalPath = path.join(destinationDir, fileName);

    let fileStream = null;
    let req = null;
    let isCleanedUp = false;

    // 清理临时 .part 文件的安全回收函数
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (fileStream) {
        try {
          fileStream.close();
        } catch {
          /* 忽略关闭错误 */
        }
      }
      if (fs.existsSync(partPath)) {
        try {
          fs.unlinkSync(partPath);
        } catch {
          /* 忽略删除错误 */
        }
      }
    };

    const handleAbort = () => {
      if (req) {
        req.destroy();
      }
      cleanup();
      reject(new Error("Download canceled by user"));
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", handleAbort, { once: true });
    }

    const startRequest = (targetUrl) => {
      const protocol = targetUrl.startsWith("https:") ? https : http;
      req = protocol.get(
        targetUrl,
        {
          headers: {
            "User-Agent": "iRouter-Desktop",
            Accept: "*/*",
          },
        },
        (res) => {
          // 处理 301/302 重定向（如从 GitHub Releases 跳转至 S3 存储桶）
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            startRequest(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            cleanup();
            reject(new Error(`Download failed with HTTP ${res.statusCode}`));
            return;
          }

          const totalBytes = parseInt(res.headers["content-length"], 10) || sizeHint || 0;
          let downloadedBytes = 0;

          fileStream = fs.createWriteStream(partPath);

          res.on("data", (chunk) => {
            downloadedBytes += chunk.length;
            if (onProgress) {
              const percent = totalBytes > 0
                ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
                : 0;
              onProgress({
                downloaded: downloadedBytes,
                total: totalBytes,
                percent,
              });
            }
          });

          res.pipe(fileStream);

          fileStream.on("finish", () => {
            fileStream.close(() => {
              if (abortSignal && abortSignal.aborted) {
                cleanup();
                reject(new Error("Download canceled"));
                return;
              }
              try {
                // 原子重命名去掉 .part 后缀
                fs.renameSync(partPath, finalPath);
                isCleanedUp = true;
                resolve(finalPath);
              } catch (e) {
                cleanup();
                reject(new Error(`Failed to finalize file: ${e.message}`));
              }
            });
          });

          fileStream.on("error", (err) => {
            cleanup();
            reject(err);
          });
        },
      );

      req.on("error", (err) => {
        cleanup();
        reject(err);
      });
    };

    startRequest(url);
  });
}

module.exports = {
  getDefaultDownloadsDir,
  fetchText,
  downloadFile,
};
