// 主窗口的 preload：把壳层能力暴露给面板渲染进程。
//
// 安全约定：contextIsolation: true + sandbox: true，只暴露白名单方法，
// 不暴露 ipcRenderer 本体。
//
// 浏览器形态下没有 preload，`window.irouterShell` 不存在——设置模态框据此
// 只渲染主题与语言（关窗行为、开机自启在浏览器里没有意义）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("irouterShell", {
  /** 读取壳层设置（含 launchAtLogin，它来自系统 API 而非设置文件） */
  getSettings: () => ipcRenderer.invoke("shell:get-settings"),
  /** 写入单项设置；返回写入后的完整设置 */
  setSetting: (key, value) =>
    ipcRenderer.invoke("shell:set-setting", key, value),
  /**
   * 订阅「打开设置」请求（来自应用菜单 Cmd+, 或托盘菜单）。
   * 返回取消订阅函数。设置面板是主窗口内的模态框，主进程只能发信号，
   * 由渲染进程决定怎么呈现。
   */
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("shell:open-settings", handler);
    return () => ipcRenderer.removeListener("shell:open-settings", handler);
  },
  /** 平台标识，供界面按平台显隐 Dock 相关项 */
  platform: process.platform,
});
