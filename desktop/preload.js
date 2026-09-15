// 设置窗口的 preload：把壳层能力暴露给渲染进程。
//
// 安全约定：contextIsolation: true + sandbox: true（与主窗口一致），
// 只暴露白名单方法，不暴露 ipcRenderer 本体。
//
// 同时负责注入 `__IRouter_SHELL__` 标记：设置页面既可能被壳层窗口打开
// （此时壳层专属项有意义），也可能被浏览器打开（Dock、关窗行为在浏览器里
// 点了没用）。页面据此决定是否渲染壳层专属分区。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__IRouter_SHELL__", true);

contextBridge.exposeInMainWorld("irouterShell", {
  /** 读取壳层设置（含 launchAtLogin，它来自系统 API 而非设置文件） */
  getSettings: () => ipcRenderer.invoke("shell:get-settings"),
  /** 写入单项设置；返回写入后的完整设置 */
  setSetting: (key, value) =>
    ipcRenderer.invoke("shell:set-setting", key, value),
  /** 平台标识，供页面按平台显隐 Dock 相关项 */
  platform: process.platform,
});
