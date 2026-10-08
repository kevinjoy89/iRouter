/**
 * 桌面壳层版本更新主聚合入口模块
 * 串联版本检测、流式下载、SHA-256 完整性校验与安装引导全流程
 *
 * @author kevinjoy89
 * @since 2026-09-29
 */

const version = require("./version");
const asset = require("../../tools/asset.js"); // 同上：asset.js 已搬到 tools/
const checksum = require("./checksum");
const checker = require("./checker");
const download = require("./download");
const installer = require("./installer");

module.exports = {
  ...version,
  ...asset,
  ...checksum,
  ...checker,
  ...download,
  ...installer,
};
