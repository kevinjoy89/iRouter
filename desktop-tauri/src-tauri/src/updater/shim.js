/* iRouter 更新器 shim —— 由 `updater::shim_js()` 经 `WebviewWindowBuilder::initialization_script`
 * 注入到面板（远端 http://127.0.0.1:<port>）里，等价于 `desktop/preload.js:10-62`。
 *
 * 五条必须守住的契约（违反任何一条都很难被发现）：
 *   1. `window.irouterShell` 必须**同步存在且为真值对象**——面板用
 *      `Boolean(window.irouterShell)` 判断"我在不在桌面壳里"，为假则「软件更新」整段消失
 *      （src/shared/components/ShellSettingsModal.js:66-70）。
 *   2. `onUpdate*()` 必须**同步返回取消函数**（面板写的是 `unsubX?.()`，
 *      UpdateSettings.js:72-77）。Tauri 的 `listen()` 是 async —— 若把 Promise 直接返回，
 *      `?.()` 会静默不执行 → 监听器泄漏、反复打开设置会叠加回调。
 *      所以这里是「一次 listen + 本地 Set 分发」，取消只从 Set 里移除，完全同步。
 *   3. 事件回调收到的**裸 payload**要原样交给面板（Tauri 的监听器收到 `{event,id,payload}`）。
 *   4. `update-error` 的 payload 是字符串，直接透传即可（不要在 JS 侧再包一层）。
 *   5. 与 shell 模块的 shim **合并**而不是覆盖：两个 initialization_script 都会写同一个
 *      `window.irouterShell`，整体覆盖会让另一方的方法静默消失。
 *
 * 注入时机：文档只承诺"晚于 global object 创建、早于文档解析"，**没有**承诺与
 * `__TAURI_INTERNALS__` 注入的先后顺序（设计 §16-U1）。所以这里先同步占位、
 * 再轮询桥接就绪，就绪前的调用排队回放。
 */
(function () {
  'use strict';

  var EV = {
    progress: 'shell:update-progress',
    available: 'shell:update-available',
    downloaded: 'shell:update-downloaded',
    error: 'shell:update-error'
  };

  // ---- 1) 同步建立存在性（契约 1 + 5）----
  var existing = window.irouterShell;
  var shell = (existing && typeof existing === 'object') ? existing : {};
  window.irouterShell = shell;

  // ---- 2) 本地分发状态 ----
  var bridge = null;            // { invoke, listen }
  var readyWaiters = [];        // 桥接就绪前排队的一次性调用
  var subscribed = false;       // 4 个事件是否已挂载
  var listeners = {};           // event -> [callback, ...]
  var MAX_ATTEMPTS = 6;

  Object.keys(EV).forEach(function (k) {
    listeners[EV[k]] = [];
  });

  function detectPlatform() {
    var injected = window.__IROUTER_PLATFORM__;
    if (typeof injected === 'string' && injected) return injected;
    // 兜底：`shim_js()` 没注入平台时用 UA 猜（当前面板没有 platform 消费者，成本为零）
    var raw = '';
    try {
      raw = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
    } catch (e) { raw = ''; }
    var s = String(raw).toLowerCase();
    if (s.indexOf('mac') >= 0) return 'darwin';
    if (s.indexOf('win') >= 0) return 'win32';
    if (s.indexOf('linux') >= 0) return 'linux';
    return 'unknown';
  }

  /* `window.__TAURI__`（withGlobalTauri=true）不存在时的低层实现。
   * 协议与 tauri 2.12.1 的 bundle.global.js 中 `N()` / `S()` 完全一致：
   *   listen   → invoke('plugin:event|listen',   {event, target:{kind:'Any'}, handler: transformCallback(cb)})
   *   unlisten → invoke('plugin:event|unlisten', {event, eventId}) */
  function internalsListen(internals) {
    return function (event, handler) {
      var id = internals.transformCallback(handler);
      return internals.invoke('plugin:event|listen', {
        event: event,
        target: { kind: 'Any' },
        handler: id
      }).then(function (eventId) {
        return function () {
          try {
            var ev = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
            if (ev && typeof ev.unregisterListener === 'function') ev.unregisterListener(event, eventId);
          } catch (e) { /* 忽略：下面还会走 unlisten 命令 */ }
          return internals.invoke('plugin:event|unlisten', { event: event, eventId: eventId });
        };
      });
    };
  }

  function resolveBridge() {
    var g = window.__TAURI__;
    if (g && g.core && typeof g.core.invoke === 'function' && g.event && typeof g.event.listen === 'function') {
      return { invoke: g.core.invoke, listen: g.event.listen };
    }
    var i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function' && typeof i.transformCallback === 'function') {
      return { invoke: i.invoke, listen: internalsListen(i) };
    }
    return null;
  }

  // ---- 3) 一次 listen + 本地 Set 分发（契约 2）----
  function dispatch(event, raw) {
    var payload = (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'payload'))
      ? raw.payload
      : raw;
    var set = listeners[event] || [];
    for (var i = 0; i < set.length; i++) {
      try {
        set[i](payload);
      } catch (e) {
        // 面板回调抛错不能影响其它订阅者
        console.error('[irouterShell] 更新事件回调异常 ' + event + '：', e);
      }
    }
  }

  function subscribe(event) {
    var attempt = 0;
    (function go() {
      bridge.listen(event, function (raw) { dispatch(event, raw); })
        .then(function () { /* 挂载成功；取消函数由各自的监听器持有，这里不需要 */ })
        .catch(function (err) {
          attempt += 1;
          if (attempt < MAX_ATTEMPTS) {
            // ACL 可能还没生效 / webview 正在切换：退避重试
            setTimeout(go, 200 * attempt);
          } else {
            console.error('[irouterShell] 订阅失败（面板将收不到 ' + event + '）：', err);
          }
        });
    })();
  }

  function boot() {
    if (bridge) return true;
    var b = resolveBridge();
    if (!b) return false;
    bridge = b;
    if (!subscribed) {
      subscribed = true;
      Object.keys(EV).forEach(function (k) { subscribe(EV[k]); });
      var queued = readyWaiters;
      readyWaiters = [];
      for (var i = 0; i < queued.length; i++) queued[i](bridge);
    }
    return true;
  }

  var tries = 0;
  (function waitForBridge() {
    if (boot()) return;
    tries += 1;
    if (tries > 600) {
      console.error('[irouterShell] 等不到 Tauri 桥接，更新功能不可用');
      return;
    }
    setTimeout(waitForBridge, tries < 50 ? 10 : 100);
  })();

  function call(cmd, args) {
    if (bridge) return bridge.invoke(cmd, args || {});
    return new Promise(function (resolve, reject) {
      readyWaiters.push(function (b) {
        b.invoke(cmd, args || {}).then(resolve, reject);
      });
    });
  }

  function on(event, cb) {
    if (typeof cb !== 'function') return function () {};
    (listeners[event] || (listeners[event] = [])).push(cb);
    return function off() {                       // ← **同步**返回，契约 2
      var set = listeners[event] || [];
      var i = set.indexOf(cb);
      if (i >= 0) set.splice(i, 1);
    };
  }

  // ---- 4) 对外 ABI：方法名不可改（面板直接调用）----
  shell.platform = detectPlatform();
  shell.checkUpdate = function (force) {
    return call('shell_check_update', { force: !!force });
  };
  shell.downloadUpdate = function () {
    return call('shell_download_update', {});
  };
  shell.cancelDownload = function () {
    return call('shell_cancel_download', {});
  };
  shell.installUpdate = function () {
    return call('shell_install_update', {});
  };
  shell.ignoreVersion = function (version) {
    return call('shell_ignore_version', { version: typeof version === 'string' ? version : null });
  };
  shell.onUpdateProgress = function (cb) { return on(EV.progress, cb); };
  shell.onUpdateAvailable = function (cb) { return on(EV.available, cb); };
  shell.onUpdateDownloaded = function (cb) { return on(EV.downloaded, cb); };
  shell.onUpdateError = function (cb) { return on(EV.error, cb); };
})();
