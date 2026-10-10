// iRouter 壳层注入脚本（Tauri v2 版 preload 等价物）。
//
// 由 `shell::shim_script()` 返回、`main.rs` 在建窗处经 `initialization_script` 注入。
// 注入时机：全局对象已创建、HTML 解析之前、页面自身脚本之前运行
//（`tauri-2.12.1/src/webview/webview_window.rs:966-990` 的文档原文）。
//
// 三条硬约束：
//   1. **合并，不覆盖**：`window.irouterShell` 是壳层与面板之间唯一的桥，updater 也会往
//      同一个对象上挂方法。必须 `Object.assign(window.irouterShell || {}, …)`。
//      为假会让面板「软件更新 / 窗口设置」整段消失（`ShellSettingsModal.js:66-70`）。
//   2. **不假设 IPC 已就绪**：`__TAURI_INTERNALS__` 与本脚本的先后顺序**没有文档承诺**
//      （API notes §9-U10），所以一切 invoke 都等到它出现之后再做。
//   3. **不改面板**：面板源码是别人的代码（Global Constraints），本脚本只**追加**能力。
//
// 与 `desktop/preload.js` 的对应：getSettings / setSetting / onOpenSettings / platform。
// 更新相关的 5 个方法由 updater 的注入脚本负责（同一个对象，各自 assign）。
//
// 本脚本额外负责**把应用语言写进 cookie**：壳层先判定（它必须先于面板知道语言，
// 因为要渲染原生菜单），再把结果注入给面板（ADR 0008）。

(() => {
  "use strict";

  const PLATFORM = "__IROUTER_PLATFORM__";
  // 壳层判定好的**应用语言**（显式选择 > 系统语言 > 英文），由 Rust 侧烘进脚本字符串。
  // 为什么不用 invoke 异步取：init 脚本在 document-start 跑，而那时
  // `__TAURI_INTERNALS__` 可能还没就绪（见约束 2），异步取值赶不上面板首帧。
  const APP_LOCALE = "__IROUTER_APP_LOCALE__";
  const LOCALE_COOKIE = "locale";
  const EVENT_OPEN_SETTINGS = "shell:open-settings";
  // 与 Rust 侧 `shell::window::EV_DOWNLOAD_SAVED` **逐字同名**（契约，改要两边一起改）
  const EVENT_DOWNLOAD_SAVED = "shell:download-saved";

  // ---------------------------------------------------------------- 应用语言注入
  // 把壳层的判定结果写进 cookie，供面板的 runtime i18n 读取。
  //
  // ⚠️ **必须先 guard origin**：init 脚本对**每次顶层导航**都跑，包括窗口建起时
  // 先加载的本地兜底页（`tauri://localhost` / `http://tauri.localhost`）。
  // 不 guard 的话第一份 cookie 会写进兜底页的 origin，面板那份仍为空 → 首启又回英文。
  // 兜底页走 `tauri://`，面板是 `http://127.0.0.1:<port>`，按 host 即可区分。
  function isPanelOrigin() {
    const host = String(window.location.hostname || "");
    return host === "127.0.0.1" || host === "localhost";
  }
  if (isPanelOrigin() && APP_LOCALE) {
    try {
      document.cookie =
        LOCALE_COOKIE +
        "=" +
        encodeURIComponent(APP_LOCALE) +
        "; path=/; max-age=31536000";
    } catch (e) {
      console.warn("[irouter-shell] 写入语言 cookie 失败", e);
    }
  }

  // 面板可能在本脚本之前/之后就绪：所有对外成员先挂上，内部等 IPC 好了再生效。
  const existing = window.irouterShell || {};
  const shell = Object.assign(existing, {
    // 对齐 preload.js 的 `process.platform`（面板目前不读它，留着是为了零成本对齐）。
    platform: existing.platform || PLATFORM,
    // 壳层判定好的应用语言。面板的「语言」设置项读它来显示当前选项
    // （显式选择存在壳层设置文件里，面板不自己判定——见 ADR 0008）。
    locale: existing.locale || APP_LOCALE,
  });
  // 只有此前不存在桥时才挂上去（updater 的脚本可能已经建好对象，绝不能整体替换）。
  if (!window.irouterShell) {
    window.irouterShell = shell;
  }

  function internals() {
    const i = window.__TAURI_INTERNALS__;
    return i && typeof i.invoke === "function" ? i : null;
  }

  // __TAURI_INTERNALS__ 可能晚于本脚本出现（U10）：轮询等待，最多 ~10s。
  const waiters = [];
  let ready = false;
  function whenReady(fn) {
    if (ready || internals()) {
      ready = true;
      fn();
      return;
    }
    waiters.push(fn);
  }
  const readyTimer = setInterval(() => {
    if (internals()) {
      ready = true;
      clearInterval(readyTimer);
      const pending = waiters.splice(0, waiters.length);
      pending.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.warn("[irouter-shell] 初始化回调失败", e);
        }
      });
    }
  }, 25);
  setTimeout(() => clearInterval(readyTimer), 10000);

  function invoke(cmd, args) {
    const i = internals();
    if (!i) return Promise.reject(new Error("[irouter-shell] IPC 尚未就绪：" + cmd));
    return i.invoke(cmd, args || {});
  }

  // ---------------------------------------------------------------- 设置读写
  // 对齐 preload.js:12-15 / main.js:679-698。
  shell.getSettings = () => invoke("shell_get_settings");
  shell.setSetting = (key, value) => invoke("shell_set_settings", { key: key, value: value });

  // ---------------------------------------------------------------- 打开设置
  // 对齐 preload.js:21-25 的 onOpenSettings：返回**同步**取消订阅函数
  // （面板写的是 `unsubscribe()`，返回 Promise 会静默不执行——updater 设计 §7 同款约束）。
  const openCallbacks = new Set();
  const pendingOpen = [];
  let listening = false;

  function deliverOpen(payload) {
    if (openCallbacks.size === 0) {
      // 面板还没注册监听（React 尚未挂载）：先存着，注册时回放。
      pendingOpen.push(payload);
      return;
    }
    openCallbacks.forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {
        console.warn("[irouter-shell] onOpenSettings 回调抛错", e);
      }
    });
  }

  function ensureListener() {
    if (listening) return;
    listening = true;
    whenReady(() => {
      const i = internals();
      try {
        // 等价于 @tauri-apps/api 的 listen(event, cb)：
        // invoke('plugin:event|listen', { event, target: {kind:'Any'}, handler })，
        // handler 用 transformCallback 注册（见 tauri-2.12.1/scripts/bundle.global.js 的 N() 实现）。
        const handler = i.transformCallback((message) => {
          deliverOpen(message && message.payload ? message.payload : {});
        });
        i.invoke("plugin:event|listen", {
          event: EVENT_OPEN_SETTINGS,
          target: { kind: "Any" },
          handler: handler,
        }).catch((e) => {
          listening = false;
          console.warn("[irouter-shell] 订阅 shell:open-settings 失败（capability 是否含 core:event:allow-listen？）", e);
        });
      } catch (e) {
        listening = false;
        console.warn("[irouter-shell] 注册事件监听失败", e);
      }
    });
  }

  shell.onOpenSettings = (cb) => {
    if (typeof cb !== "function") return () => {};
    openCallbacks.add(cb);
    ensureListener();
    // 回放缓冲区（对齐 Electron 版「窗口首次加载后再发」的语义，main.js:662-668）
    while (pendingOpen.length > 0) {
      const payload = pendingOpen.shift();
      try {
        cb(payload);
      } catch (e) {
        console.warn("[irouter-shell] onOpenSettings 回放失败", e);
      }
    }
    return () => {
      openCallbacks.delete(cb);
    };
  };

  // 脚本一加载就订阅：早了会被缓冲（pendingOpen），晚了会丢（所以不等调用方）。
  ensureListener();

  // ---------------------------------------------------------------- 下载落盘通知
  // 导出配置是**静默**落到系统下载目录的，面板只显示「已导出」而用户不知道文件在哪。
  // 路径只有壳层知道（面板不知道下载目录，也不知道重名去重后的 "name (1).json" 后缀），
  // 所以由壳层在下载完成时发 shell:download-saved 通知它。
  //
  // 这里**不需要 pending 缓冲**：订阅发生在面板挂载时，而下载只可能由用户点击触发，
  // 一定晚于订阅。漏掉事件的唯一情形是"下载早于面板加载"，那种情况本来也没有 UI 可更新。
  const downloadCallbacks = new Set();
  let downloadListening = false;
  shell.onDownloadSaved = (cb) => {
    if (typeof cb !== "function") return () => {};
    downloadCallbacks.add(cb);
    if (!downloadListening) {
      downloadListening = true;
      whenReady(() => {
        const i = internals();
        try {
          const handler = i.transformCallback((message) => {
            const payload = message && message.payload ? message.payload : {};
            downloadCallbacks.forEach((fn) => {
              try {
                fn(payload);
              } catch (e) {
                console.warn("[irouter-shell] onDownloadSaved 回调抛错", e);
              }
            });
          });
          i.invoke("plugin:event|listen", {
            event: EVENT_DOWNLOAD_SAVED,
            target: { kind: "Any" },
            handler: handler,
          }).catch((e) => {
            downloadListening = false;
            console.warn("[irouter-shell] 订阅 shell:download-saved 失败", e);
          });
        } catch (e) {
          downloadListening = false;
          console.warn("[irouter-shell] 注册下载事件监听失败", e);
        }
      });
    }
    return () => {
      downloadCallbacks.delete(cb);
    };
  };

  // ---------------------------------------------------------------- 右键菜单
  // Tauri v2 没有 context-menu 事件（API notes §5.2），触发链是：
  // DOM contextmenu → invoke shell_context_menu → Rust popup_menu_at。
  // 规则（是否弹、弹什么）在 Rust 侧，与 main.js:521-545 同款；这里只负责上报现场。
  function isEditableTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      // 与 Electron 的 params.isEditable 口径一致：不可输入的 input 不算可编辑
      return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
    }
    return false;
  }

  function hasSelection() {
    try {
      return String(window.getSelection ? window.getSelection() : "").trim().length > 0;
    } catch (e) {
      return false;
    }
  }

  whenReady(() => {
    try {
      document.addEventListener(
        "contextmenu",
        (event) => {
          // 面板自己的右键菜单（若有）优先：只在无人处理时接管。
          if (event.defaultPrevented) return;
          event.preventDefault();
          const editable = isEditableTarget(event.target);
          const selection = hasSelection();
          const payload = {
            x: event.clientX,
            y: event.clientY,
            editable: editable,
            selection: selection,
            url: String(window.location.href || ""),
          };
          invoke("shell_context_menu", payload).catch((e) => {
            console.warn("[irouter-shell] 右键菜单调用失败", e);
          });
        },
        true
      );
    } catch (e) {
      console.warn("[irouter-shell] 绑定 contextmenu 失败", e);
    }
  });
})();
