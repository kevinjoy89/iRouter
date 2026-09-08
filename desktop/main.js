// iRouter 壳层主进程：内嵌窗口 + 托盘 + 网关子进程管理。
// 上游 9Router 零改动，仅通过进程边界交互（见 docs/adr/0002-pinned-upstream.md）。
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  session,
  dialog,
  shell,
  nativeImage,
  nativeTheme,
} = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const DEFAULT_PORT = 20128;
const PORT_SCAN_SPAN = 50;
const SMOKE = process.argv.includes("--smoke");
const IMPORT_MARKER = ".irouter-import-decided";
// 导入旧 CLI 数据时排除的条目：runtime/ 是 CLI 自装的 node 运行时，桌面版不需要
const LEGACY_SKIP_ENTRIES = ["runtime"];

let mainWindow = null;
let tray = null;
let gateway = null;
let gatewayPort = 0;
let quitting = false;
let smokeStarted = false;

// 应用名必须在任何 getPath 调用前固定：userData 目录名取自它（spec: 数据目录隔离）
app.setName("iRouter");

// userData 必须在 app ready 前设置，否则 Chromium 缓存目录已按旧路径创建
if (process.env.IROUTER_USER_DATA) {
  app.setPath("userData", process.env.IROUTER_USER_DATA);
}

// 单实例锁：抢不到直接退出，已有实例会收到 second-instance 并聚焦窗口
const gotTheLock = app.requestSingleInstanceLock();
console.log(
  `[iRouter] singleInstanceLock=${gotTheLock} userData=${app.getPath("userData")}`,
);
if (!gotTheLock) {
  app.quit();
}

// ---------------------------------------------------------------- 环境净化
// 宿主 shell 可能带有其他 Next 应用泄漏的私有变量（__NEXT_PRIVATE_STANDALONE_CONFIG 等）。
// 子进程 next 一旦读到会跳过本项目的配置、改用泄漏配置并崩溃，必须整批剔除。
function sanitizedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("__NEXT_")) continue;
    if (
      k === "NEXT_DIST_DIR" ||
      k === "NEXT_DEPLOYMENT_ID" ||
      k === "NEXT_TRACING_ROOT_MODE"
    )
      continue;
    // 宿主泄漏：PORT / HOSTNAME 会被 Next standalone 直接当作监听配置
    if (k === "PORT" || k === "HOST" || k === "HOSTNAME") continue;
    env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------- 路径
function gatewayDir() {
  // 打包：extraResources → resources/gateway/server；开发：desktop/build/gateway/server
  return app.isPackaged
    ? path.join(process.resourcesPath, "gateway", "server")
    : path.join(__dirname, "build", "gateway", "server");
}

function legacyDir() {
  return process.env.IROUTER_LEGACY_DIR || path.join(os.homedir(), ".9router");
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "resources", "icon.png");
}

let cachedLogoDataUrl = null;
function getLogoDataUrl() {
  if (cachedLogoDataUrl) return cachedLogoDataUrl;
  const p = iconPath();
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    // 渲染在 36x36 容器中，用 72x72 在 Retina 屏幕下呈现 2x 细腻度
    cachedLogoDataUrl = img.resize({ width: 72, height: 72 }).toDataURL();
    return cachedLogoDataUrl;
  }
  return "";
}

// ---------------------------------------------------------------- 端口
function isPortFree(port) {
  // 用“能否连上”判定占用：macOS 下 SO_REUSEADDR 会让 listen(127.0.0.1:N) 在已有 *:N
  // 监听时照样成功，误报空闲（实测撞上用户运行中的 9Router 实例）。
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve(false);
    });
    sock.setTimeout(600, () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => {
      sock.destroy();
      resolve(true);
    });
  });
}

// 默认端口被占用时向上顺延（spec: 端口自适应，如 20129），绝不杀占用进程
async function pickPort(from = DEFAULT_PORT) {
  for (let p = from; p <= DEFAULT_PORT + PORT_SCAN_SPAN; p++) {
    if (await isPortFree(p)) return p;
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.once("listening", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.listen(0, "127.0.0.1");
  });
}

function waitHttpReady(port, timeoutMs = 60000) {
  // TCP 能连上 ≠ 能服务 HTTP：Next 先 accept 再初始化，实测会让紧接的探测全部落空。
  // 就绪以 GET /login 返回 200 为准。
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(attempt, 200);
    };
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/login", timeout: 3000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve(true);
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    attempt();
  });
}

// ---------------------------------------------------------------- 网关子进程
const PIDFILE = ".gateway.pid";

// macOS：子进程若直接用主二进制启动，会被 LaunchServices 当成独立应用，
// 在 Dock 上多出一个通用 "exec" 图块。改用 Electron 自带的 Helper bundle 启动：
// 其 Info.plist 已声明 LSUIElement=true（不占 Dock），这也是 VS Code 跑扩展宿主的做法。
function gatewayBinary() {
  if (process.platform !== "darwin") return process.execPath;
  const contents = path.dirname(path.dirname(process.execPath)); // <App>.app/Contents
  const fw = path.join(contents, "Frameworks");
  if (!fs.existsSync(fw)) return process.execPath;
  let names;
  try {
    names = fs.readdirSync(fw).filter((n) => n.endsWith(".app"));
  } catch {
    return process.execPath;
  }
  // 取不带括号的基础 Helper（(GPU)/(Renderer)/(Plugin) 是 Chromium 专用角色）
  const base = names.find((n) => !n.includes("(")) || names[0];
  if (!base) return process.execPath;
  const bin = path.join(
    fw,
    base,
    "Contents",
    "MacOS",
    base.replace(/\.app$/, ""),
  );
  return fs.existsSync(bin) ? bin : process.execPath;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 上次若被强杀（非托盘退出），网关子进程会孤儿化继续占端口与数据目录。
// 能执行到这里说明已拿到单实例锁，不存在“另一个正常实例”，可安全回收。
async function reapOrphanGateway(dataDir) {
  const f = path.join(dataDir, PIDFILE);
  let pid = 0;
  try {
    if (!fs.existsSync(f)) return;
    pid = parseInt(fs.readFileSync(f, "utf8"), 10) || 0;
    fs.unlinkSync(f);
  } catch (e) {
    console.error(`[iRouter] 读取 pidfile 失败: ${e.message}`);
    return;
  }
  if (!pid || !isPidAlive(pid)) return;
  console.log(`[iRouter] 回收上次遗留的网关进程 pid=${pid}`);
  try {
    process.kill(-pid, "SIGKILL"); // detached 启动，pid 即进程组组长
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  // 等它真正消失再选端口，否则刚被占的默认端口会被误判为不可用而无谓顺延
  const deadline = Date.now() + 3000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

function startGateway(port, dataDir) {
  const dir = gatewayDir();
  const entry = path.join(dir, "custom-server.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`找不到网关入口：${entry}\n请先执行 npm run build-server`);
  }
  // detached:true → 独立进程组，退出时可整组回收（Next 会派生 next-server 子进程）
  // 打包后的 server.js 只认 PORT 环境变量（忽略 --port）；上游默认 HOSTNAME=0.0.0.0
  // 会把网关暴露到局域网，桌面版显式绑定回环地址。
  const child = spawn(gatewayBinary(), [entry, "--port", String(port)], {
    cwd: dir,
    env: {
      ...sanitizedEnv(),
      ELECTRON_RUN_AS_NODE: "1",
      DATA_DIR: dataDir,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[gateway] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[gateway] ${d}`));
  try {
    fs.writeFileSync(path.join(dataDir, PIDFILE), String(child.pid));
  } catch (e) {
    console.error(`[iRouter] 写 pidfile 失败: ${e.message}`);
  }
  return child;
}

// 杀掉整个进程组；Windows 无 POSIX 信号组，用 taskkill /T 递归终止
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        process.kill(-child.pid, "SIGTERM");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
    setTimeout(() => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
      resolve();
    }, 3000);
  });
}

// 端口探测与实际绑定之间存在 TOCTOU（并发实例、其他程序恰好抢绑），
// 因次失败则换下一个端口重试，而不是直接报错退出。
async function startGatewayWithRetry(dataDir, maxAttempts = 3) {
  let from = DEFAULT_PORT;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await pickPort(from);
    let child;
    try {
      child = startGateway(port, dataDir);
    } catch (e) {
      dialog.showErrorBox("iRouter 启动失败", e.message);
      app.exit(1);
      return false;
    }
    gatewayPort = port;
    gateway = child;
    child.once("exit", (code, signal) => {
      // 重试中主动回收的子进程（gateway 已指向别处）不当作意外退出
      if (quitting || gateway !== child) return;
      gateway = null;
      showGatewayError(`进程退出 code=${code} signal=${signal}`);
    });

    if (await waitHttpReady(port, 20000)) {
      if (attempt > 1)
        console.log(`[iRouter] 第 ${attempt} 次尝试后网关就绪，端口 ${port}`);
      return true;
    }

    console.error(`[iRouter] 网关在端口 ${port} 未就绪，换端口重试`);
    gateway = null; // 先摘钩，避免回收时误报“意外退出”
    await killTree(child);
    from = port + 1;
  }
  return false;
}

// ---------------------------------------------------------------- 窗口
function gatewayOrigin() {
  return `http://127.0.0.1:${gatewayPort}`;
}

// 窗口标题：空字符串，保持标题栏纯净无多余字样（面板侧栏已有品牌大标题）
function windowTitle() {
  return "";
}

function trayTooltip() {
  const t = getMenuI18n(currentLocale);
  return `${t.trayTooltip} :${gatewayPort}`;
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 壳层隐藏与定制的上游 UI（纯表现层，无功能影响；上游源码零改动，见 ADR-0002）：
// 1. 侧栏顶部仿 macOS 红绿灯装饰 —— 与窗口真标题栏重复
// 2. 9Remote / 9English 入口 —— 产品化时不想暴露的入口；9Remote 无 href，
//    用相邻兄弟选择器（它正好在 9English 链接前面）；上游小改结构时
//    选择器失效仅是“恢复显示”，优雅降级
// 3. 顶部栏捐赠入口 —— 纯赞助入口，壳层予以隐藏
// 4. 侧栏品牌与版本 —— 9Router Proxy 替换为 iRouter Proxy，版本号与桌面端当前版本保持一致
// 5. 顶部栏右侧工具按钮 —— 主题切换、语言切换、四宫格菜单，壳层予以隐藏
// 6. 侧栏 Logo —— 原 hub 图标容器替换为 iRouter 官方应用图标
// 7. 侧栏 Skills 入口 —— 壳层予以隐藏
function getShellCss() {
  const version = app.getVersion();
  const logoUrl = getLogoDataUrl();
  return `
  aside > div.flex.items-center.gap-2.px-6.pt-5 { display: none !important; }
  aside > div.px-6.py-4 { padding-top: 18px !important; }
  aside > nav a[href="https://9english.net/"],
  aside > nav button:has(+ a[href="https://9english.net/"]) { display: none !important; }
  aside > nav a[href="/dashboard/skills"] { display: none !important; }
  header button[aria-label="Donate"] { display: none !important; }
  header button[aria-label*="mode"],
  header button[title*="mode"],
  header button[title="Language"],
  header button[data-i18n-skip="true"],
  header div.relative:has(> button[title="Menu"]),
  header button[title="Menu"] { display: none !important; }
  aside a[href="/dashboard"] > div:first-child {
    background-image: url("${logoUrl}") !important;
    background-color: transparent !important;
    background-size: contain !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    box-shadow: none !important;
  }
  aside a[href="/dashboard"] > div:first-child > span { display: none !important; }
  aside a[href="/dashboard"] h1 { font-size: 0 !important; }
  aside a[href="/dashboard"] h1::after {
    content: "iRouter Proxy" !important;
    font-size: 1.125rem !important;
    line-height: 1.75rem !important;
  }
  aside a[href="/dashboard"] h1 + span { font-size: 0 !important; }
  aside a[href="/dashboard"] h1 + span::after {
    content: "v${version}" !important;
    font-size: 0.75rem !important;
    line-height: 1rem !important;
  }
`;
}

function applyShellCss(win) {
  const inject = () => {
    win.webContents.insertCSS(getShellCss()).catch(() => {});
  };
  win.webContents.on("dom-ready", inject);
  win.webContents.on("did-finish-load", inject);
}

// ---------------------------------------------------------------- 深浅色与多语言跟随
// 监听面板内深浅色模式（<html> class）与语言设定（document.cookie 中的 locale），
// 通过 console-message 通知主进程，同步切换 macOS 系统标题栏外观与顶部原生菜单语言
const SHELL_SYNC_SCRIPT = `
(() => {
  if (window.__irouter_shell_sync_injected) return;
  window.__irouter_shell_sync_injected = true;

  function reportTheme() {
    const isDark = document.documentElement.classList.contains("dark");
    console.log("__IROUTER_THEME__:" + (isDark ? "dark" : "light"));
  }
  reportTheme();
  const themeObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === "class") {
        reportTheme();
        break;
      }
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  function getLocale() {
    const m = document.cookie.match(/(?:^|;\\s*)locale=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  let lastLocale = getLocale();
  if (lastLocale) {
    console.log("__IROUTER_LOCALE__:" + lastLocale);
  }
  setInterval(() => {
    const current = getLocale();
    if (current && current !== lastLocale) {
      lastLocale = current;
      console.log("__IROUTER_LOCALE__:" + current);
    }
  }, 1000);
})();
`;

/**
 * 注入深浅色与多语言监听脚本并同步初始 Cookie 语言
 * @param {BrowserWindow} win 目标窗口实例
 */
function applyShellSync(win) {
  const inject = () => {
    win.webContents.executeJavaScript(SHELL_SYNC_SCRIPT).catch(() => {});
    win.webContents.session.cookies
      .get({ name: "locale" })
      .then((cookies) => {
        const loc = cookies.find((c) => c.name === "locale");
        if (loc?.value) {
          setAppLocale(loc.value);
        }
      })
      .catch(() => {});
  };
  win.webContents.on("dom-ready", inject);
  win.webContents.on("did-finish-load", inject);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: windowTitle(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18181b" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  // 接收渲染进程主题与多语言通知，同步更新系统原生外观与菜单文案
  win.webContents.on("console-message", (event, ...args) => {
    const message =
      typeof event?.message === "string"
        ? event.message
        : typeof args[1] === "string"
          ? args[1]
          : "";
    if (message.startsWith("__IROUTER_THEME__:")) {
      const mode = message.slice("__IROUTER_THEME__:".length);
      if (mode === "dark" || mode === "light") {
        nativeTheme.themeSource = mode;
        win.setBackgroundColor(mode === "dark" ? "#18181b" : "#ffffff");
      }
    } else if (message.startsWith("__IROUTER_LOCALE__:")) {
      const loc = message.slice("__IROUTER_LOCALE__:".length);
      setAppLocale(loc);
    }
  });

  // 面板自带 <title>，固定为空白标题（保持标题栏纯净无文字）
  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(windowTitle());
  });

  // 关窗最小化到托盘：网关是常驻服务，关窗不等于停服
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(gatewayOrigin())) {
      return { action: "allow" }; // 同源 OAuth 弹窗：依赖 window.opener / BroadcastChannel / localStorage
    }
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url); // 站外链接交给系统浏览器
    }
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", () => {
    win.setTitle(windowTitle());
    if (SMOKE && !smokeStarted) runSmoke();
  });
  applyShellCss(win);
  applyShellSync(win);

  win.once("ready-to-show", () => win.show());

  win.loadURL(`${gatewayOrigin()}/`);
  return win;
}

function showGatewayError(detail) {
  const html = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>iRouter</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;background:#111;color:#eee;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{max-width:520px;padding:32px;border:1px solid #333;border-radius:12px}
h1{font-size:18px;margin:0 0 12px;color:#f97316}code{background:#222;padding:2px 6px;border-radius:4px}</style>
</head><body><div><h1>网关服务已停止</h1>
<p>内嵌的 9Router 网关进程意外退出，面板与 API 暂时不可用。</p>
<p>请从托盘菜单选择<b>退出</b>，然后重新启动 iRouter。</p>
<p><code>${String(detail || "").slice(0, 200)}</code></p></div></body></html>`)}`;
  if (mainWindow) {
    mainWindow.show();
    mainWindow.loadURL(html);
  }
}

// ---------------------------------------------------------------- 应用多语言与菜单栏
let currentLocale = "en";

const MENU_TRANSLATIONS = {
  en: {
    view: "View",
    window: "Window",
    about: "About iRouter",
    services: "Services",
    hide: "Hide iRouter",
    hideOthers: "Hide Others",
    unhide: "Show All",
    quit: "Quit iRouter",
    reload: "Reload",
    forceReload: "Force Reload",
    toggleDevTools: "Toggle Developer Tools",
    actualSize: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    toggleFullScreen: "Toggle Full Screen",
    minimize: "Minimize",
    zoom: "Zoom",
    front: "Bring All to Front",
    close: "Close Window",
    openDashboard: "Open Dashboard",
    autostart: "Launch at Login",
    gatewayAddr: "Gateway Address",
    quitApp: "Quit iRouter",
    trayTooltip: "iRouter Gateway",
  },
  "zh-CN": {
    view: "视图",
    window: "窗口",
    about: "关于 iRouter",
    services: "服务",
    hide: "隐藏 iRouter",
    hideOthers: "隐藏其他",
    unhide: "全部显示",
    quit: "退出 iRouter",
    reload: "重新加载",
    forceReload: "强制重新加载",
    toggleDevTools: "开发者工具",
    actualSize: "实际大小",
    zoomIn: "放大",
    zoomOut: "缩小",
    toggleFullScreen: "切换全屏",
    minimize: "最小化",
    zoom: "缩放",
    front: "前置全部窗口",
    close: "关闭窗口",
    openDashboard: "打开面板",
    autostart: "开机自启",
    gatewayAddr: "网关地址",
    quitApp: "退出 iRouter",
    trayTooltip: "iRouter 网关",
  },
  "zh-TW": {
    view: "檢視",
    window: "視窗",
    about: "關於 iRouter",
    services: "服務",
    hide: "隱藏 iRouter",
    hideOthers: "隱藏其他",
    unhide: "全部顯示",
    quit: "結束 iRouter",
    reload: "重新載入",
    forceReload: "強制重新載入",
    toggleDevTools: "開發人員工具",
    actualSize: "實際大小",
    zoomIn: "放大",
    zoomOut: "縮小",
    toggleFullScreen: "切換全螢幕",
    minimize: "最小化",
    zoom: "縮放",
    front: "將全部視窗移至最前",
    close: "關閉視窗",
    openDashboard: "開啟控制台",
    autostart: "開機自動啟動",
    gatewayAddr: "閘道位址",
    quitApp: "結束 iRouter",
    trayTooltip: "iRouter 閘道",
  },
  ja: {
    view: "表示",
    window: "ウィンドウ",
    about: "iRouter について",
    services: "サービス",
    hide: "iRouter を隠す",
    hideOthers: "ほかを隠す",
    unhide: "すべてを表示",
    quit: "iRouter を終了",
    reload: "再読み込み",
    forceReload: "強制的に再読み込み",
    toggleDevTools: "デベロッパー ツール",
    actualSize: "実際のサイズ",
    zoomIn: "拡大",
    zoomOut: "縮小",
    toggleFullScreen: "フルスクリーンにする",
    minimize: "最小化",
    zoom: "拡大/縮小",
    front: "すべてを手前に移動",
    close: "ウィンドウを閉じる",
    openDashboard: "ダッシュボードを開く",
    autostart: "ログイン時に起動",
    gatewayAddr: "ゲートウェイ アドレス",
    quitApp: "iRouter を終了",
    trayTooltip: "iRouter ゲートウェイ",
  },
  ko: {
    view: "보기",
    window: "윈도우",
    about: "iRouter 정보",
    services: "서비스",
    hide: "iRouter 숨기기",
    hideOthers: "기타 가리기",
    unhide: "모두 보기",
    quit: "iRouter 종료",
    reload: "새로고침",
    forceReload: "강제 새로고침",
    toggleDevTools: "개발자 도구",
    actualSize: "실제 크기",
    zoomIn: "확대",
    zoomOut: "축소",
    toggleFullScreen: "전체 화면",
    minimize: "최소화",
    zoom: "확대/축소",
    front: "모두 앞으로 가져오기",
    close: "창 닫기",
    openDashboard: "대시보드 열기",
    autostart: "로그인 시 시작",
    gatewayAddr: "게이트웨이 주소",
    quitApp: "iRouter 종료",
    trayTooltip: "iRouter 게이트웨이",
  },
  es: {
    view: "Ver",
    window: "Ventana",
    about: "Acerca de iRouter",
    services: "Servicios",
    hide: "Ocultar iRouter",
    hideOthers: "Ocultar otros",
    unhide: "Mostrar todo",
    quit: "Salir de iRouter",
    reload: "Recargar",
    forceReload: "Forzar recarga",
    toggleDevTools: "Herramientas de desarrollador",
    actualSize: "Tamaño real",
    zoomIn: "Acercar",
    zoomOut: "Alejar",
    toggleFullScreen: "Pantalla completa",
    minimize: "Minimizar",
    zoom: "Zoom",
    front: "Traer todo al frente",
    close: "Cerrar ventana",
    openDashboard: "Abrir panel",
    autostart: "Iniciar al arrancar",
    gatewayAddr: "Dirección de gateway",
    quitApp: "Salir de iRouter",
    trayTooltip: "Gateway iRouter",
  },
  fr: {
    view: "Présentation",
    window: "Fenêtre",
    about: "À propos de iRouter",
    services: "Services",
    hide: "Masquer iRouter",
    hideOthers: "Masquer les autres",
    unhide: "Tout afficher",
    quit: "Quitter iRouter",
    reload: "Recharger la page",
    forceReload: "Forcer le rechargement",
    toggleDevTools: "Outils de développement",
    actualSize: "Taille réelle",
    zoomIn: "Zoom avant",
    zoomOut: "Zoom arrière",
    toggleFullScreen: "Activer le mode plein écran",
    minimize: "Réduire",
    zoom: "Agrandir/réduire",
    front: "Tout ramener au premier plan",
    close: "Fermer la fenêtre",
    openDashboard: "Ouvrir le tableau de bord",
    autostart: "Lancer au démarrage",
    gatewayAddr: "Adresse de la passerelle",
    quitApp: "Quitter iRouter",
    trayTooltip: "Passerelle iRouter",
  },
  de: {
    view: "Darstellung",
    window: "Fenster",
    about: "Über iRouter",
    services: "Dienste",
    hide: "iRouter ausblenden",
    hideOthers: "Andere ausblenden",
    unhide: "Alle einblenden",
    quit: "iRouter beenden",
    reload: "Neu laden",
    forceReload: "Erneutes Laden erzwingen",
    toggleDevTools: "Entwicklertools",
    actualSize: "Originalgröße",
    zoomIn: "Vergrößern",
    zoomOut: "Verkleinern",
    toggleFullScreen: "Vollbildmodus ein-/ausschalten",
    minimize: "Minimieren",
    zoom: "Zoom",
    front: "Alle nach vorne bringen",
    close: "Fenster schließen",
    openDashboard: "Dashboard öffnen",
    autostart: "Beim Systemstart ausführen",
    gatewayAddr: "Gateway-Adresse",
    quitApp: "iRouter beenden",
    trayTooltip: "iRouter Gateway",
  },
  ru: {
    view: "Вид",
    window: "Окно",
    about: "О программе iRouter",
    services: "Службы",
    hide: "Скрыть iRouter",
    hideOthers: "Скрыть остальные",
    unhide: "Показать все",
    quit: "Завершить iRouter",
    reload: "Перезагрузить",
    forceReload: "Перезагрузить с очисткой кэша",
    toggleDevTools: "Инструменты разработчика",
    actualSize: "Фактический размер",
    zoomIn: "Увеличить",
    zoomOut: "Уменьшить",
    toggleFullScreen: "Полноэкранный режим",
    minimize: "Свернуть",
    zoom: "Масштабирование",
    front: "Все окна — на передний план",
    close: "Закрыть окно",
    openDashboard: "Открыть панель",
    autostart: "Запуск при входе в систему",
    gatewayAddr: "Адрес шлюза",
    quitApp: "Завершить iRouter",
    trayTooltip: "Шлюз iRouter",
  },
  "pt-BR": {
    view: "Visualizar",
    window: "Janela",
    about: "Sobre o iRouter",
    services: "Serviços",
    hide: "Ocultar iRouter",
    hideOthers: "Ocultar outros",
    unhide: "Mostrar tudo",
    quit: "Encerrar iRouter",
    reload: "Recarregar",
    forceReload: "Forçar recarregamento",
    toggleDevTools: "Ferramentas do desenvolvedor",
    actualSize: "Tamanho real",
    zoomIn: "Mais zoom",
    zoomOut: "Menos zoom",
    toggleFullScreen: "Alternar tela cheia",
    minimize: "Minimizar",
    zoom: "Zoom",
    front: "Trazer todas para a frente",
    close: "Fechar janela",
    openDashboard: "Abrir painel",
    autostart: "Iniciar no login",
    gatewayAddr: "Endereço do gateway",
    quitApp: "Encerrar iRouter",
    trayTooltip: "Gateway iRouter",
  },
  vi: {
    view: "Xem",
    window: "Cửa sổ",
    about: "Giới thiệu về iRouter",
    services: "Dịch vụ",
    hide: "Ẩn iRouter",
    hideOthers: "Ẩn mục khác",
    unhide: "Hiển thị tất cả",
    quit: "Thoát iRouter",
    reload: "Tải lại",
    forceReload: "Buộc tải lại",
    toggleDevTools: "Công cụ cho nhà phát triển",
    actualSize: "Kích thước thực tế",
    zoomIn: "Phóng to",
    zoomOut: "Thu nhỏ",
    toggleFullScreen: "Toàn màn hình",
    minimize: "Thu nhỏ",
    zoom: "Thu phóng",
    front: "Đưa tất cả lên phía trước",
    close: "Đóng cửa sổ",
    openDashboard: "Mở bảng điều khiển",
    autostart: "Khởi chạy khi đăng nhập",
    gatewayAddr: "Địa chỉ gateway",
    quitApp: "Thoát iRouter",
    trayTooltip: "Gateway iRouter",
  },
};

/**
 * 规范化语言代码
 * 将任意语言字符串映射至受支持的菜单语言字典键名
 * @param {string} raw 原始语言字符串
 * @return {string} 规范化后的语言键名
 */
function normalizeMenuLocale(raw) {
  if (!raw || typeof raw !== "string") return "en";
  const s = raw.trim().toLowerCase();
  if (s.startsWith("zh")) {
    if (s.includes("tw") || s.includes("hk") || s.includes("hant")) {
      return "zh-TW";
    }
    return "zh-CN";
  }
  if (s.startsWith("ja")) return "ja";
  if (s.startsWith("ko")) return "ko";
  if (s.startsWith("es")) return "es";
  if (s.startsWith("fr")) return "fr";
  if (s.startsWith("de")) return "de";
  if (s.startsWith("ru")) return "ru";
  if (s.startsWith("pt")) return "pt-BR";
  if (s.startsWith("vi")) return "vi";
  return "en";
}

/**
 * 获取当前语言对应的菜单国际化文案
 * @param {string} [locale] 目标语言代码
 * @return {Object} 国际化文案键值对对象
 */
function getMenuI18n(locale = currentLocale) {
  const norm = normalizeMenuLocale(locale);
  return MENU_TRANSLATIONS[norm] || MENU_TRANSLATIONS.en;
}

/**
 * 构建应用原生菜单栏配置模板
 * 排除 File 与 Edit 顶栏菜单，保留应用菜单、View 与 Window，并在 macOS 隐藏项中保留快捷键
 * @param {string} [locale] 目标语言代码
 * @return {Array<Object>} 菜单项模板列表
 */
function buildMenuTemplate(locale = currentLocale) {
  const isMac = process.platform === "darwin";
  const t = getMenuI18n(locale);
  return [
    ...(isMac
      ? [
          {
            label: "iRouter",
            submenu: [
              { role: "about", label: t.about },
              { type: "separator" },
              { role: "services", label: t.services },
              { type: "separator" },
              { role: "hide", label: t.hide },
              { role: "hideOthers", label: t.hideOthers },
              { role: "unhide", label: t.unhide },
              { type: "separator" },
              { role: "quit", label: t.quit },
            ],
          },
        ]
      : []),
    ...(isMac
      ? [
          {
            label: "Edit",
            visible: false,
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
        ]
      : []),
    {
      label: t.view,
      submenu: [
        { role: "reload", label: t.reload },
        { role: "forceReload", label: t.forceReload },
        { role: "toggleDevTools", label: t.toggleDevTools },
        { type: "separator" },
        { role: "resetZoom", label: t.actualSize },
        { role: "zoomIn", label: t.zoomIn },
        { role: "zoomOut", label: t.zoomOut },
        { type: "separator" },
        { role: "togglefullscreen", label: t.toggleFullScreen },
      ],
    },
    {
      label: t.window,
      submenu: [
        { role: "minimize", label: t.minimize },
        { role: "zoom", label: t.zoom },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front", label: t.front },
              { type: "separator" },
              { role: "close", label: t.close },
            ]
          : [{ role: "close", label: t.close }]),
      ],
    },
  ];
}

/**
 * 配置并更新应用顶部原生菜单栏
 * @param {string} [locale] 目标语言代码，缺省时使用 currentLocale
 */
function setupApplicationMenu(locale = currentLocale) {
  const norm = normalizeMenuLocale(locale);
  currentLocale = norm;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(norm)));
}

/**
 * 应用新的多语言设定并刷新菜单栏与托盘菜单
 * @param {string} nextLocale 新的语言代码
 */
function setAppLocale(nextLocale) {
  const norm = normalizeMenuLocale(nextLocale);
  if (norm === currentLocale && Menu.getApplicationMenu()) return;
  setupApplicationMenu(norm);
  if (tray) {
    updateTrayMenu();
  }
}

// ---------------------------------------------------------------- 托盘与自启
function trayIcon() {
  const p = iconPath();
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    // macOS 菜单栏按高度缩放，模板图自动适配深浅色
    return process.platform === "darwin"
      ? img.resize({ width: 18, height: 18 })
      : img.resize({ width: 22, height: 22 });
  }
  return nativeImage.createEmpty();
}

function autostartEnabled() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setAutostart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  } catch (e) {
    dialog.showErrorBox("iRouter", `设置开机自启失败：${e.message}`);
  }
}

/**
 * 刷新托盘菜单文案与提示
 */
function updateTrayMenu() {
  if (!tray) return;
  const t = getMenuI18n(currentLocale);
  tray.setToolTip(trayTooltip());
  const menu = Menu.buildFromTemplate([
    { label: `${t.gatewayAddr}：${gatewayOrigin()}/v1`, enabled: false },
    { type: "separator" },
    { label: t.openDashboard, click: showWindow },
    {
      label: t.autostart,
      type: "checkbox",
      checked: autostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    { type: "separator" },
    { label: t.quitApp, click: () => quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(trayIcon());
  updateTrayMenu();
  tray.on("double-click", showWindow);
}

// ---------------------------------------------------------------- 首次运行导入
// 网关自己的数据条目（也是导入的目标条目）。不能用“目录为空”判首次：
// Electron/Chromium 会把 profile 文件（Cache、Local Storage 等）写进同一个 userData 目录。
const GATEWAY_DATA_MARKERS = ["db", "auth", "jwt-secret", "machine-id"];

function dataDirHasGatewayData(dataDir) {
  return GATEWAY_DATA_MARKERS.some((m) => fs.existsSync(path.join(dataDir, m)));
}

function askImport(legacy) {
  // 测试接缝：自动化验证无法点击模态框。默认（未设置）仍弹框询问用户。
  const preset = process.env.IROUTER_IMPORT_DECISION;
  if (preset === "import") return 0;
  if (preset === "skip") return 1;
  return dialog.showMessageBoxSync({
    type: "question",
    title: "iRouter",
    message: "检测到旧版 9Router CLI 数据",
    detail: `位置：${legacy}\n是否导入其中的配置、数据库与密钥？（原数据保留不动，仅复制）`,
    buttons: ["导入", "跳过", "取消"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
}

// 返回 false 表示用户取消启动
function maybeImportLegacyData(dataDir) {
  const legacy = legacyDir();
  if (!fs.existsSync(legacy)) return true; // 无旧数据不询问
  if (fs.existsSync(path.join(dataDir, IMPORT_MARKER))) return true; // 已决定过
  if (dataDirHasGatewayData(dataDir)) return true; // 非首次运行

  const choice = askImport(legacy);
  if (choice === 2) return false; // 取消：不导入、不记录，下次再问
  fs.mkdirSync(dataDir, { recursive: true });
  if (choice === 1) {
    fs.writeFileSync(path.join(dataDir, IMPORT_MARKER), "skipped\n");
    return true;
  }
  for (const name of fs.readdirSync(legacy)) {
    if (LEGACY_SKIP_ENTRIES.includes(name)) continue;
    fs.cpSync(path.join(legacy, name), path.join(dataDir, name), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
  fs.writeFileSync(path.join(dataDir, IMPORT_MARKER), "imported\n");
  return true;
}

// ---------------------------------------------------------------- 生命周期
function quit() {
  quitting = true;
  app.quit();
}

async function stopGateway() {
  if (gateway) {
    await killTree(gateway);
    gateway = null;
  }
  try {
    fs.unlinkSync(path.join(app.getPath("userData"), PIDFILE));
  } catch {
    /* 不存在则忽略 */
  }
}

function httpProbe(pathname) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: gatewayPort, path: pathname, timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
  });
}

async function runSmoke() {
  if (smokeStarted) return;
  smokeStarted = true;
  const results = [];
  let ok = true;
  try {
    const code = await httpProbe("/login");
    results.push(`GET /login -> ${code}`);
    ok &&= code === 200;
    const models = await httpProbe("/v1/models");
    results.push(`GET /v1/models -> ${models}`);
    ok &&= models === 200;
    const cb = await httpProbe("/callback");
    results.push(`GET /callback -> ${cb}`);
    ok &&= cb > 0;
    if (mainWindow) {
      // 用 jwt-secret 自签一个合法 token 写进窗口 cookie，让 smoke 能进仪表盘页
      // （aside/假红绿灯只在那边存在）；仅 smoke 路径执行。
      try {
        const crypto = require("node:crypto");
        const secret = fs.readFileSync(
          path.join(app.getPath("userData"), "jwt-secret"),
        );
        const b64u = (buf) =>
          buf
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        const now = Math.floor(Date.now() / 1000);
        const payload = b64u(
          Buffer.from(
            JSON.stringify({ authenticated: true, iat: now, exp: now + 3600 }),
          ),
        );
        const sig = b64u(
          crypto
            .createHmac("sha256", secret)
            .update(
              `${b64u(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${payload}`,
            )
            .digest(),
        );
        await mainWindow.webContents.session.cookies.set({
          url: gatewayOrigin(),
          name: "auth_token",
          value: `${b64u(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${payload}.${sig}`,
        });
        await mainWindow.webContents.loadURL(`${gatewayOrigin()}/dashboard`);
      } catch (e) {
        results.push(`smoke 登录注入失败：${e.message}`);
      }
      await new Promise((resolve) => {
        if (!mainWindow.webContents.isLoadingMainFrame()) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 3000);
        mainWindow.webContents.once("did-finish-load", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      results.push("窗口 did-finish-load ✓");

      // 壳层 CSS 应已隐藏的上游 UI 元素（假红绿灯 / 9Remote / 9English / 捐赠按钮 / 顶部三工具 / Skills 入口），不许回归
      const win = mainWindow;
      const checks = {
        假红绿灯: "aside > div.flex.items-center.gap-2.px-6.pt-5",
        九Remote: "aside > nav button:has(+ a[href='https://9english.net/'])",
        九English: "aside > nav a[href='https://9english.net/']",
        技能入口: "aside > nav a[href='/dashboard/skills']",
        捐赠按钮: "header button[aria-label='Donate']",
        主题切换: "header button[aria-label*='mode']",
        语言切换: "header button[title='Language']",
        四宫格菜单: "header button[title='Menu']",
      };
      const hiddenState = await win.webContents.executeJavaScript(
        `(() => { const q = ${JSON.stringify(checks)};
                  return Object.fromEntries(Object.entries(q).map(([k, sel]) => {
                    const el = document.querySelector(sel);
                    return [k, el ? getComputedStyle(el).display === "none" : "no-element"];
                  })); })()`,
        true,
      );
      for (const [k, v] of Object.entries(hiddenState)) {
        results.push(`${k}已隐藏=${v}`);
        ok &&= v === true;
      }

      // 校验窗口标题已移除所有字样（保持标题栏纯净无文字）
      const title = win.getTitle();
      const titleOk = title === "";
      results.push(`窗口标题无字样=${titleOk} ("${title}")`);
      ok &&= titleOk;

      // 校验侧栏品牌名与版本号已改为 iRouter Proxy 与桌面端当前版本
      const brandText = await win.webContents.executeJavaScript(
        `(() => {
          const h1 = document.querySelector('aside a[href="/dashboard"] h1');
          return h1 ? window.getComputedStyle(h1, '::after').content : "";
        })()`,
        true,
      );
      const versionText = await win.webContents.executeJavaScript(
        `(() => {
          const span = document.querySelector('aside a[href="/dashboard"] h1 + span');
          return span ? window.getComputedStyle(span, '::after').content : "";
        })()`,
        true,
      );
      const brandOk = brandText === '"iRouter Proxy"';
      const versionOk = versionText === `"v${app.getVersion()}"`;
      results.push(`品牌名iRouter Proxy=${brandOk}`);
      results.push(`版本号v${app.getVersion()}=${versionOk}`);
      ok &&= brandOk && versionOk;

      // 校验侧栏 Logo 容器已替换为官方应用图标且原 hub 图标已隐藏
      const logoReplaced = await win.webContents.executeJavaScript(
        `(() => {
          const container = document.querySelector('aside a[href="/dashboard"] > div:first-child');
          const span = container ? container.querySelector('span') : null;
          const bg = container ? getComputedStyle(container).backgroundImage : "";
          const spanHidden = span ? getComputedStyle(span).display === "none" : false;
          return bg.startsWith('url("data:image/png') && spanHidden;
        })()`,
        true,
      );
      results.push(`侧栏Logo替换为应用图标=${logoReplaced}`);
      ok &&= logoReplaced;

      // 校验深浅色模式与系统标题栏外观跟随
      const isDarkInPage = await win.webContents.executeJavaScript(
        `document.documentElement.classList.contains("dark")`,
        true,
      );
      const expectedMode = isDarkInPage ? "dark" : "light";
      const themeFollowed = nativeTheme.themeSource === expectedMode;
      results.push(`暗黑标题栏跟随=${themeFollowed} (页面=${expectedMode})`);
      ok &&= themeFollowed;

      // 校验顶部原生菜单栏已移除 File 与 Edit 菜单
      const appMenu = Menu.getApplicationMenu();
      const visibleMenuLabels = appMenu
        ? appMenu.items.filter((i) => i.visible).map((i) => i.label || i.role)
        : [];
      const hasVisibleFile = appMenu
        ? appMenu.items.some((i) => i.visible && (i.label === "File" || i.role === "filemenu"))
        : false;
      const hasVisibleEdit = appMenu
        ? appMenu.items.some((i) => i.visible && (i.label === "Edit" || i.role === "editmenu"))
        : false;
      const menuOk = !hasVisibleFile && !hasVisibleEdit;
      results.push(`菜单栏移除File和Edit=${menuOk} (可见项=[${visibleMenuLabels.join(", ")}])`);
      ok &&= menuOk;

      // 校验顶部原生菜单随软件多语言动态响应
      const prevLoc = currentLocale;
      setAppLocale("zh-CN");
      const zhMenu = Menu.getApplicationMenu();
      const zhLabels = zhMenu ? zhMenu.items.filter((i) => i.visible).map((i) => i.label) : [];
      const zhOk = zhLabels[1] === "视图" && zhLabels[2] === "窗口";

      setAppLocale("en");
      const enMenu = Menu.getApplicationMenu();
      const enLabels = enMenu ? enMenu.items.filter((i) => i.visible).map((i) => i.label) : [];
      const enOk = enLabels[1] === "View" && enLabels[2] === "Window";

      setAppLocale(prevLoc);
      const i18nOk = zhOk && enOk;
      results.push(`菜单栏多语言动态响应=${i18nOk} (中=[${zhLabels.join(", ")}], 英=[${enLabels.join(", ")}])`);
      ok &&= i18nOk;

      // 关窗应隐藏到托盘，且网关继续服务（spec: 关窗最小化到托盘）
      win.close();
      await new Promise((r) => setTimeout(r, 400));
      const hidden = !win.isVisible();
      const alive = await httpProbe("/login");
      results.push(`关窗后隐藏=${hidden} 网关仍响应=${alive}`);
      ok &&= hidden && alive === 200;
    }
    results.push(`托盘已创建=${!!tray}`);
    ok &&= !!tray;
  } catch (e) {
    ok = false;
    results.push(`异常：${e.message}`);
  }
  console.log(`[smoke] port=${gatewayPort}`);
  console.log(`[smoke] ${results.join(" | ")}`);
  console.log(`[smoke] ${ok ? "PASS" : "FAIL"}`);
  await stopGateway();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(async () => {
  // 抢锁失败时 quit 已发出；此处再显式守卫一次，避免 whenReady 仍 resolve 而起第二个网关
  if (!gotTheLock) {
    app.exit(0);
    return;
  }
  if (process.platform === "darwin") {
    app.setAboutPanelOptions({
      applicationName: "iRouter",
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      copyright: "跨平台本地 AI 路由网关 · MIT License",
    });
  }
  // 初始语言设定：优先读取系统语言偏好
  currentLocale = normalizeMenuLocale(app.getLocale());
  setupApplicationMenu(currentLocale);

  // 监听 Cookies 变化，当用户在面板切换语言时即时同步菜单
  session.defaultSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (!removed && cookie.name === "locale") {
      setAppLocale(cookie.value);
    }
  });
  const dataDir = app.getPath("userData");
  fs.mkdirSync(dataDir, { recursive: true });
  await reapOrphanGateway(dataDir);

  if (!maybeImportLegacyData(dataDir)) {
    app.exit(0);
    return;
  }

  const started = await startGatewayWithRetry(dataDir);
  if (!started) {
    dialog.showErrorBox(
      "iRouter 启动失败",
      "网关多次尝试后仍未就绪，请检查端口占用情况与应用日志",
    );
    await stopGateway();
    app.exit(1);
    return;
  }

  console.log(`[iRouter] ready http://127.0.0.1:${gatewayPort}`);

  createTray();

  const openedAtLogin = !SMOKE && app.getLoginItemSettings().wasOpenedAtLogin;
  if (openedAtLogin) {
    console.log("[iRouter] 开机自启：驻留托盘，不显示窗口");
  } else {
    createWindow();
  }

  app.on("activate", showWindow);
});

app.on("second-instance", () => {
  showWindow();
});

app.on("window-all-closed", () => {
  /* 常驻托盘，不退出 */
});

app.on("before-quit", (e) => {
  quitting = true;
  if (gateway && !gateway.killed && gateway.exitCode === null) {
    e.preventDefault();
    stopGateway().then(() => app.exit(0));
  }
});

process.on("SIGINT", quit);
process.on("SIGTERM", quit);
