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
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("shell:open-settings", handler);
    return () => ipcRenderer.removeListener("shell:open-settings", handler);
  },
  /** 平台标识，供界面按平台显隐 Dock 相关项 */
  platform: process.platform,
  /** 检查版本更新（force 为 true 时绕过限流缓存） */
  checkUpdate: (force = false) => ipcRenderer.invoke("shell:check-update", force),
  /** 开始下载最新版本更新产物 */
  downloadUpdate: () => ipcRenderer.invoke("shell:download-update"),
  /** 取消当前正在进行的更新下载 */
  cancelDownload: () => ipcRenderer.invoke("shell:cancel-download"),
  /** 安装已下载完成并通过完整性校验的安装包并退出应用 */
  installUpdate: () => ipcRenderer.invoke("shell:install-update"),
  /** 记录用户选择忽略的版本号 */
  ignoreVersion: (version) => ipcRenderer.invoke("shell:ignore-version", version),
  /** 订阅下载进度事件 */
  onUpdateProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on("shell:update-progress", handler);
    return () => ipcRenderer.removeListener("shell:update-progress", handler);
  },
  /** 订阅发现新版本事件（含自动静默检查与菜单触发） */
  onUpdateAvailable: (callback) => {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on("shell:update-available", handler);
    return () => ipcRenderer.removeListener("shell:update-available", handler);
  },
  /** 订阅更新包下载并校验成功事件 */
  onUpdateDownloaded: (callback) => {
    const handler = (_event, downloaded) => callback(downloaded);
    ipcRenderer.on("shell:update-downloaded", handler);
    return () => ipcRenderer.removeListener("shell:update-downloaded", handler);
  },
  /** 订阅更新过程异常事件 */
  onUpdateError: (callback) => {
    const handler = (_event, err) => callback(err);
    ipcRenderer.on("shell:update-error", handler);
    return () => ipcRenderer.removeListener("shell:update-error", handler);
  },
});
