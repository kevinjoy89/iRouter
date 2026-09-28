/**
 * 安装包 SHA-256 校验和解析与比对模块
 * 确保下载产物的完整性与安全性，防止网络劫持或文件损坏
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

/**
 * 解析 checksums.txt 文件内容
 * 格式为经典的 sha256sum 输出：`<hash>  <filename>` 或 `<hash> *<filename>`
 *
 * @param {string | Buffer} content checksums 文件的原始文本内容
 * @return {Record<string, string>} 文件名到小写 SHA-256 哈希值的映射字典
 */
function parseChecksums(content) {
  const result = {};
  if (!content) {
    return result;
  }
  const text = typeof content === "string" ? content : content.toString("utf8");
  const lines = text.split("\n");

  for (let line of lines) {
    line = line.trim();
    // 剔除可能存在的 UTF-8 BOM 字符
    if (line.charCodeAt(0) === 0xfeff) {
      line = line.slice(1);
    }
    if (!line) {
      continue;
    }
    // 分割哈希值与文件名（支持单个或多个空格分隔）
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const hash = parts[0].toLowerCase();
      // 移除二进制模式前缀星号（*）
      const filename = parts[1].replace(/^\*/, "");
      result[filename] = hash;
    }
  }
  return result;
}

/**
 * 流式计算本地文件的 SHA-256 哈希值并与预期值比对
 *
 * @param {string} filePath 待验证的本地文件绝对路径
 * @param {string} expectedHash 预期的 SHA-256 哈希值
 * @return {Promise<boolean>} 哈希完全一致返回 true，否则返回 false
 * @throws {Error} 读取文件系统失败时抛出错误
 */
function verifyFileSha256(filePath, expectedHash) {
  return new Promise((resolve, reject) => {
    if (!filePath || !expectedHash) {
      resolve(false);
      return;
    }
    if (!fs.existsSync(filePath)) {
      resolve(false);
      return;
    }
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => {
      const actualHash = hash.digest("hex").toLowerCase();
      const targetHash = expectedHash.trim().toLowerCase();
      resolve(actualHash === targetHash);
    });
    stream.on("error", (err) => reject(err));
  });
}

module.exports = {
  parseChecksums,
  verifyFileSha256,
};
