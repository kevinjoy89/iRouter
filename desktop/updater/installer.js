/**
 * 跨平台安装包调起与引导模块
 * 负责在校验通过后以非阻塞独立子进程方式唤起系统原生安装器并退出主进程
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

const { spawn } = require("node:child_process");

/**
 * 判断目标文件是否为压缩包格式（便携版）
 *
 * @param {string} filePath 文件路径
 * @return {boolean} 是 zip 或 tar.gz 返回 true，否则返回 false
 */
function isArchivePackage(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }
  const lower = filePath.toLowerCase();
  return lower.endsWith(".zip") || lower.endsWith(".tar.gz");
}

/**
 * 以系统原生默认方式打开下载好的安装包
 *
 * @param {string} filePath 本地安装包完整路径
 * @param {string} [platform=process.platform] 操作系统平台
 * @return {Promise<boolean>} 成功发起返回 true
 * @throws {Error} 执行命令出错时抛出异常
 */
function openInstaller(filePath, platform = process.platform) {
  return new Promise((resolve, reject) => {
    if (!filePath) {
      reject(new Error("File path is required"));
      return;
    }

    let cmd = "";
    let args = [];

    if (platform === "darwin") {
      // macOS: open <dmg>
      cmd = "open";
      args = [filePath];
    } else if (platform === "win32") {
      // Windows: cmd /c start "" "<path>"
      cmd = "cmd.exe";
      args = ["/c", "start", "", filePath];
    } else {
      // Linux: xdg-open <deb/tarball>
      cmd = "xdg-open";
      args = [filePath];
    }

    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      resolve(true);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  isArchivePackage,
  openInstaller,
};
