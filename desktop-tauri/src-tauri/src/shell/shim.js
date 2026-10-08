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

(() => {
  "use strict";

  const PLATFORM = "__IROUTER_PLATFORM__";
  const EVENT_OPEN_SETTINGS = "shell:open-settings";

  // 面板可能在本脚本之前/之后就绪：所有对外成员先挂上，内部等 IPC 好了再生效。
  const existing = window.irouterShell || {};
  const shell = Object.assign(existing, {
    // 对齐 preload.js 的 `process.platform`（面板目前不读它，留着是为了零成本对齐）。
    platform: existing.platform || PLATFORM,
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
