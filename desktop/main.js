// iRouter 桌面端主进程：窗口生命周期 + 系统托盘 + 原生菜单 + 网关子进程管理
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
  ipcMain,
} = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const {
  readSettings: readShellSettings,
  writeSettings: writeShellSettings,
} = require("./settings.js");

const DEFAULT_PORT = 20128;
const PORT_SCAN_SPAN = 50;
const SMOKE = process.argv.includes("--smoke");
const IMPORT_MARKER = ".irouter-import-decided";
// 导入旧 CLI 数据时排除的条目：runtime/ 是 CLI 自装的 node 运行时，桌面版不需要
const LEGACY_SKIP_ENTRIES = ["runtime"];
// 面板访问守卫：与网关侧 src/proxy.js 约定的客户端头，浏览器直连面板会被 403
const PANEL_CLIENT_HEADER = "x-irouter-client";
const PANEL_CLIENT_VALUE = "irouter-app";
// 覆盖安装后，Chromium 磁盘缓存可能残留旧构建的页面/脚本：旧 Server Action ID
// 发给新网关会抛 "Failed to find Server Action"。禁用磁盘缓存，窗口永远加载当前构建。
app.commandLine.appendSwitch("disable-http-cache");

let mainWindow = null;
let tray = null;
let gateway = null;
let gatewayPort = 0;
let quitting = false;
let smokeStarted = false;

// 应用名必须在任何 getPath 调用前固定：userData 目录名取自它（spec: 数据目录隔离）
app.setName("iRouter");

// userData 必须在 app ready 前设置，否则 Chromium 缓存目录已按旧路径创建
const MULTI_INSTANCE = process.argv.includes("--multi-instance");
if (MULTI_INSTANCE && !process.env.IROUTER_USER_DATA) {
  const baseUserData = app.getPath("userData");
  app.setPath(
    "userData",
    path.join(path.dirname(baseUserData), "iRouter-Multi"),
  );
} else if (process.env.IROUTER_USER_DATA) {
  app.setPath("userData", process.env.IROUTER_USER_DATA);
}

// 单实例锁：抢不到锁时暂不在此处静默退出，交由 whenReady 进行系统弹窗引导或独立双开分流
const gotTheLock = app.requestSingleInstanceLock();
console.log(
  `[iRouter] singleInstanceLock=${gotTheLock} userData=${app.getPath("userData")}`,
);
if (!gotTheLock && SMOKE) {
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

// 获取服务端网关数据目录（优先环境变量，默认持久化至 ~/.irouter）
function getGatewayDataDir() {
  if (process.env.IROUTER_DATA_DIR) {
    return process.env.IROUTER_DATA_DIR;
  }
  // 若显式指定了 IROUTER_USER_DATA（如 smoke 自动化测试隔离），则以其为主
  if (process.env.IROUTER_USER_DATA) {
    return process.env.IROUTER_USER_DATA;
  }
  if (MULTI_INSTANCE) {
    return path.join(os.homedir(), ".irouter-multi");
  }
  return path.join(os.homedir(), ".irouter");
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "resources", "icon.png");
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
        {
          host: "127.0.0.1",
          port,
          path: "/login",
          timeout: 3000,
          headers: { [PANEL_CLIENT_HEADER]: PANEL_CLIENT_VALUE },
        },
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
  console.log(`[iRouter] 回收上次遗留的网关进程 pid=${pid}，优先发送 SIGTERM 优雅退出`);
  // 优先发送 SIGTERM 允许网关进程执行 shutdown 钩子落盘并完成 WAL checkpoint
  try {
    process.kill(-pid, "SIGTERM"); // detached 启动，pid 即进程组组长
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
  }

  // 优雅期等待：最多 1500ms
  const gracefulDeadline = Date.now() + 1500;
  while (isPidAlive(pid) && Date.now() < gracefulDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // 若优雅期内未退出，降级为 SIGKILL 强杀
  if (isPidAlive(pid)) {
    console.warn(`[iRouter] 遗留网关进程 pid=${pid} 未在优雅期内退出，强制终止 (SIGKILL)`);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }

  // 等它真正消失再选端口，否则刚被占的默认端口会被误判为不可用而无谓顺延
  const deadline = Date.now() + 2000;
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
      IR_PANEL_GUARD: "1",
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

// Dock 显隐（macOS 专属）。非 mac 平台 app.dock 是 undefined，两个函数都退化为空操作。
//
// 这两个调用点承担 closeAction 三档里的 "tray" 档语义：
//   关窗 → hideDock()（Dock 图块消失，只剩托盘入口）
//   唤回 → showDock()（图块回来，Dock 与 Cmd+Tab 都能找到它）
// 刻意不做「进程启动即隐藏」——那会让窗口开着却在应用切换器里找不到，
// 用户会以为程序崩了。隐藏只发生在「窗口全部收进托盘」之后。
function showDock() {
  if (process.platform === "darwin" && app.dock) app.dock.show();
}

function hideDock() {
  if (process.platform === "darwin" && app.dock) app.dock.hide();
}

function showWindow() {
  showDock(); // 从托盘唤回：Dock 图块一并恢复
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------- 深浅色跟随
// 监听面板内深浅色模式（<html> class），同步切换 macOS 系统标题栏外观与背景色
const THEME_SYNC_SCRIPT = `
(() => {
  if (window.__irouter_theme_sync_injected) return;
  window.__irouter_theme_sync_injected = true;

  function reportTheme() {
    try {
      const saved = localStorage.getItem("theme");
      const pref = saved ? (JSON.parse(saved).state || {}).theme : "system";
      const isDark = document.documentElement.classList.contains("dark");
      console.log("__IROUTER_THEME_PREF__:" + (pref || "system"));
      console.log("__IROUTER_THEME__:" + (isDark ? "dark" : "light"));
    } catch {
      const isDark = document.documentElement.classList.contains("dark");
      console.log("__IROUTER_THEME__:" + (isDark ? "dark" : "light"));
    }
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
})();
`;

/**
 * 注入深浅色监听脚本并同步初始 Cookie 语言
 * @param {BrowserWindow} win 目标窗口实例
 */
function applyThemeSync(win) {
  const inject = () => {
    win.webContents.executeJavaScript(THEME_SYNC_SCRIPT).catch(() => {});
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
      // 主窗口也挂 preload：设置面板是主窗口内的模态框，壳层能力（关窗行为、
      // 开机自启）必须在这个 document 里可读写。浏览器打开时没有 preload，
      // window.irouterShell 不存在，模态框只渲染主题与语言。
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow = win;

  // 监听操作系统原生主题切换，实时同步窗口背景色与外观
  const onThemeUpdated = () => {
    if (!win.isDestroyed()) {
      win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#18181b" : "#ffffff");
    }
  };
  nativeTheme.on("updated", onThemeUpdated);
  win.on("closed", () => {
    nativeTheme.removeListener("updated", onThemeUpdated);
  });

  // 右键上下文菜单（自维护）：Electron 默认无右键菜单；面板 Edit 顶栏菜单
  // 被隐藏后 macOS 的选区复制无键等效可用，右键菜单提供复制/全选等原生角色
  //（角色标签走系统语言，符合 macOS 惯例）。适配选中态与可编辑态。
  win.webContents.on("context-menu", (_event, params) => {
    // 仅日志页与可编辑输入框弹出右键菜单；其余页面禁止任何右键菜单
    //（文字选择在 globals.css 中已默认禁用，仅日志区显式放行）
    const isLogPage = (params.pageURL || "").includes("/dashboard/console-log");
    const editable = params.isEditable;
    if (!isLogPage && !editable) return;
    const hasSel = !!(params.selectionText && params.selectionText.trim());
    const t = getMenuI18n(currentLocale);
    const template =
      isLogPage && !editable
        ? // 日志区：仅提供复制（需先选中）
          [{ role: "copy", label: t.copy, enabled: hasSel }]
        : [
            { role: "copy", label: t.copy, enabled: hasSel || editable },
            { role: "cut", label: t.cut, enabled: editable },
            { role: "paste", label: t.paste, enabled: editable },
            { type: "separator" },
            {
              role: "selectAll",
              label: t.selectAll,
              enabled: editable || hasSel,
            },
          ];
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Cmd/Ctrl+C/V/X/A 显式接管（自维护）：隐藏 Edit 菜单后加速键可能不注册，
  // 保证选区复制/粘贴/剪切/全选始终可用；对输入框的原生处理幂等。
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const isMac = process.platform === "darwin";
    const mod = isMac ? input.meta : input.control;
    if (!mod || input.alt || input.shift) return;
    const k = input.key.toLowerCase();
    if (k === "c") win.webContents.copy();
    else if (k === "v") win.webContents.paste();
    else if (k === "x") win.webContents.cut();
    else if (k === "a") win.webContents.selectAll();
  });

  // 接收渲染进程主题与多语言通知，同步更新系统原生外观与菜单文案
  win.webContents.on("console-message", (event, ...args) => {
    const message =
      typeof event?.message === "string"
        ? event.message
        : typeof args[1] === "string"
          ? args[1]
          : "";
    if (message.startsWith("__IROUTER_THEME_PREF__:")) {
      const pref = message.slice("__IROUTER_THEME_PREF__:".length);
      if (pref === "system" || pref === "dark" || pref === "light") {
        nativeTheme.themeSource = pref;
        win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#18181b" : "#ffffff");
      }
    } else if (message.startsWith("__IROUTER_THEME__:")) {
      const mode = message.slice("__IROUTER_THEME__:".length);
      if (mode === "dark" || mode === "light") {
        // 仅在非跟随系统模式下覆盖 themeSource，避免破坏系统自动跟随
        if (nativeTheme.themeSource !== "system") {
          nativeTheme.themeSource = mode;
        }
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

  // 关窗行为三档（见 desktop/settings.js 的 CLOSE_ACTIONS）：
  //   quit — 退出应用（等价托盘菜单的「退出 iRouter」）
  //   dock — 隐藏到托盘，Dock 图块保留（默认；与历史行为一致）
  //   tray — 隐藏到托盘，Dock 图块一并隐藏（只剩托盘入口）
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    // 冒烟测试恒走隐藏路径：否则 closeAction=quit 会让 smoke 提前退出、断言拿不到结果。
    // 测试用独立 dataDir（默认 dock），这里是防御性兜底而非依赖。
    const action = SMOKE
      ? "dock"
      : readShellSettings(getGatewayDataDir()).closeAction;
    if (action === "quit") {
      quit();
      return;
    }
    win.hide();
    if (action === "tray") hideDock();
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
  applyThemeSync(win);

  // 面板访问守卫：网关侧（custom-server）按 UA 中的 Electron 标识放行桌面窗口，
  // 浏览器直连 HTML 页面被连接级拒绝（见 custom-server.js isBlockedPanelRequest）。

  win.once("ready-to-show", () => win.show());

  // 启动时清一次残留缓存再加载，避免覆盖安装后的旧资源（详见顶部 disable-http-cache）
  session.defaultSession
    .clearCache()
    .catch(() => {})
    .then(() => {
      win.loadURL(`${gatewayOrigin()}/`);
    });
  return win;
}

// ---------------------------------------------------------------- 设置面板
// 设置面板是**主窗口内的模态框**（渲染进程侧 src/shared/components/ShellSettingsModal.js），
// 不是一个独立的 BrowserWindow。第一版做成了独立窗口，两个问题：那个窗口有自己的
// document，改主题只影响它自己（主窗口的 zustand 不感知同 origin 的 localStorage 变更）；
// 语言切换也只作用于它，而它不在主窗口 i18n 的 MutationObserver 观察范围内。
// 模态框与面板同一个 document，两个问题一起消失。
//
// 主进程只负责「把面板调起来」：必要时先显示窗口，再发 IPC 让渲染进程开模态框。
function openSettings() {
  showDock();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    // 窗口首次加载后渲染进程才注册监听，等 did-finish-load 再发
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.send("shell:open-settings");
    });
    return;
  }
  showWindow();
  mainWindow.webContents.send("shell:open-settings");
}

/**
 * 壳层设置的读写通道。渲染进程只能经 preload 的白名单方法访问，
 * 不暴露 ipcRenderer 本体。
 */
function registerSettingsIpc() {
  ipcMain.handle("shell:get-settings", () => ({
    ...readShellSettings(getGatewayDataDir()),
    // 开机自启的真相源是系统登录项，不是设置文件（见 desktop/settings.js 顶部注释）
    launchAtLogin: autostartEnabled(),
  }));

  ipcMain.handle("shell:set-setting", (_event, key, value) => {
    if (key === "launchAtLogin") {
      setAutostart(value === true);
    } else {
      writeShellSettings(getGatewayDataDir(), { [key]: value });
    }
    updateTrayMenu();
    return {
      ...readShellSettings(getGatewayDataDir()),
      launchAtLogin: autostartEnabled(),
    };
  });
}

function showGatewayError(detail) {
  const html = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>iRouter</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;background:#111;color:#eee;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{max-width:520px;padding:32px;border:1px solid #333;border-radius:12px}
h1{font-size:18px;margin:0 0 12px;color:#f97316}code{background:#222;padding:2px 6px;border-radius:4px}</style>
</head><body><div><h1>网关服务已停止</h1>
<p>内嵌的 iRouter 网关进程意外退出，面板与 API 暂时不可用。</p>
<p>请从托盘菜单选择<b>退出</b>，然后重新启动 iRouter。</p>
<p><code>${String(detail || "").slice(0, 200)}</code></p></div></body></html>`)}`;
  if (mainWindow) {
    mainWindow.show();
    mainWindow.loadURL(html);
  }
}

// ---------------------------------------------------------------- 应用多语言与菜单栏
let currentLocale = "en";

// 壳层菜单文案。**只维护 en / zh-CN / zh-TW 三种**；其余语言的键是历史遗留，
// 缺键由 getMenuI18n 用英文兜底（见该函数）。新增菜单键只需补这三种。
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
    settings: "Settings…",
    copy: "Copy",
    paste: "Paste",
    cut: "Cut",
    selectAll: "Select All",
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
    settings: "设置…",
    copy: "复制",
    paste: "粘贴",
    cut: "剪切",
    selectAll: "全选",
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
    settings: "設定…",
    copy: "複製",
    paste: "貼上",
    cut: "剪下",
    selectAll: "全選",
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
    copy: "コピー",
    paste: "貼り付け",
    cut: "切り取り",
    selectAll: "すべて選択",
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
    copy: "복사",
    paste: "붙여넣기",
    cut: "잘라내기",
    selectAll: "모두 선택",
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
    copy: "Copiar",
    paste: "Pegar",
    cut: "Cortar",
    selectAll: "Seleccionar todo",
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
    copy: "Copier",
    paste: "Coller",
    cut: "Couper",
    selectAll: "Tout sélectionner",
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
    copy: "Kopieren",
    paste: "Einfügen",
    cut: "Ausschneiden",
    selectAll: "Alles auswählen",
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
    copy: "Копировать",
    paste: "Вставить",
    cut: "Вырезать",
    selectAll: "Выделить всё",
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
    copy: "Copiar",
    paste: "Colar",
    cut: "Recortar",
    selectAll: "Selecionar tudo",
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
    copy: "Sao chép",
    paste: "Dán",
    cut: "Cắt",
    selectAll: "Chọn tất cả",
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
  const dict = MENU_TRANSLATIONS[norm];
  if (!dict || dict === MENU_TRANSLATIONS.en) return MENU_TRANSLATIONS.en;
  // 英文兜底合并。壳层菜单只维护 en / zh-CN / zh-TW 三种语言，其余语言
  // 一律回退英文——这是既定策略，不是权宜之计。合并而非直接返回 dict 是为了
  // 让缺键显示英文原文而不是 undefined。
  return { ...MENU_TRANSLATIONS.en, ...dict };
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
              {
                label: t.settings,
                accelerator: "CmdOrCtrl+,",
                click: openSettings,
              },
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
    // macOS 已把「设置…」放进 App 菜单（Cmd+,），托盘不再重复；其余平台无应用菜单
    ...(process.platform === "darwin"
      ? []
      : [{ label: t.settings, click: openSettings }]),
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
  // 测试接缝：自动化验证无法点击模态框。默认（未设置）仍弹框询问用户
  const preset = process.env.IROUTER_IMPORT_DECISION;
  if (preset === "import") return 0;
  if (preset === "skip") return 1;

  const isEn = currentLocale === "en";
  const isTw = currentLocale === "zh-TW";
  const message = isEn
    ? "Legacy 9Router CLI data detected"
    : isTw
      ? "檢測到舊版 9Router CLI 資料"
      : "检测到旧版 9Router CLI 数据";
  const detail = isEn
    ? `Location: ${legacy}\nDo you want to import configurations, database and keys? (Original files are untouched, only copied)`
    : isTw
      ? `位置：${legacy}\n是否匯入其中的設定、資料庫與金鑰？（原資料保留不動，僅複製）`
      : `位置：${legacy}\n是否导入其中的配置、数据库与密钥？（原数据保留不动，仅复制）`;
  const buttons = isEn
    ? ["Import", "Skip", "Cancel"]
    : isTw
      ? ["匯入", "略過", "取消"]
      : ["导入", "跳过", "取消"];

  return dialog.showMessageBoxSync({
    type: "question",
    title: "iRouter",
    message,
    detail,
    buttons,
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
  const pidDirs = [getGatewayDataDir(), app.getPath("userData")];
  for (const dir of pidDirs) {
    try {
      fs.unlinkSync(path.join(dir, PIDFILE));
    } catch {
      /* 不存在则忽略 */
    }
  }
}

function httpProbe(pathname) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        path: pathname,
        timeout: 5000,
        headers: { [PANEL_CLIENT_HEADER]: PANEL_CLIENT_VALUE },
      },
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

      const win = mainWindow;

      // 校验窗口标题已移除所有字样（保持标题栏纯净无文字）
      const title = win.getTitle();
      const titleOk = title === "";
      results.push(`窗口标题无字样=${titleOk} ("${title}")`);
      ok &&= titleOk;

      // 校验深浅色模式与系统标题栏外观跟随
      const isDarkInPage = await win.webContents.executeJavaScript(
        `document.documentElement.classList.contains("dark")`,
        true,
      );
      const expectedMode = isDarkInPage ? "dark" : "light";
      const themeFollowed =
        nativeTheme.themeSource === expectedMode ||
        (nativeTheme.themeSource === "system" &&
          nativeTheme.shouldUseDarkColors === isDarkInPage);
      results.push(
        `暗黑标题栏跟随=${themeFollowed} (页面=${expectedMode}, themeSource=${nativeTheme.themeSource})`,
      );
      ok &&= themeFollowed;

      // 校验顶部原生菜单栏已移除 File 与 Edit 菜单
      const appMenu = Menu.getApplicationMenu();
      const visibleMenuLabels = appMenu
        ? appMenu.items.filter((i) => i.visible).map((i) => i.label || i.role)
        : [];
      const hasVisibleFile = appMenu
        ? appMenu.items.some(
            (i) => i.visible && (i.label === "File" || i.role === "filemenu"),
          )
        : false;
      const hasVisibleEdit = appMenu
        ? appMenu.items.some(
            (i) => i.visible && (i.label === "Edit" || i.role === "editmenu"),
          )
        : false;
      const menuOk = !hasVisibleFile && !hasVisibleEdit;
      results.push(
        `菜单栏移除File和Edit=${menuOk} (可见项=[${visibleMenuLabels.join(", ")}])`,
      );
      ok &&= menuOk;

      // 校验顶部原生菜单随软件多语言动态响应
      const prevLoc = currentLocale;
      setAppLocale("zh-CN");
      const zhMenu = Menu.getApplicationMenu();
      const zhLabels = zhMenu
        ? zhMenu.items.filter((i) => i.visible).map((i) => i.label)
        : [];
      const zhOk = zhLabels[1] === "视图" && zhLabels[2] === "窗口";

      setAppLocale("en");
      const enMenu = Menu.getApplicationMenu();
      const enLabels = enMenu
        ? enMenu.items.filter((i) => i.visible).map((i) => i.label)
        : [];
      const enOk = enLabels[1] === "View" && enLabels[2] === "Window";

      setAppLocale(prevLoc);
      const i18nOk = zhOk && enOk;
      results.push(
        `菜单栏多语言动态响应=${i18nOk} (中=[${zhLabels.join(", ")}], 英=[${enLabels.join(", ")}])`,
      );
      ok &&= i18nOk;

      // 设置模态框：验证它渲染在**主窗口内**，且主题/语言作用于整个应用。
      // 第一版把设置做成了独立 BrowserWindow——那个窗口有自己的 document，
      // 改主题只影响它自己，语言切换也不在主窗口 i18n 的观察范围内。这条断言
      // 就是为了钉住那个回归：模态框必须与面板同 document。
      const cjkCount = () =>
        (document.body.innerText.match(/[\u4e00-\u9fff]/g) || []).length;

      win.webContents.send("shell:open-settings");
      await new Promise((r) => setTimeout(r, 700));
      const modalOpen = await win.webContents.executeJavaScript(
        `Boolean(document.querySelector(".shell-settings-modal"))`,
        true,
      );
      results.push(`设置模态框在主窗口内打开=${modalOpen}`);
      ok &&= modalOpen;

      const cjkBefore = await win.webContents.executeJavaScript(
        `(${cjkCount.toString()})()`,
        true,
      );

      // 切深色：documentElement 的 dark 类是**文档级**的，证明作用于整个应用
      const clickedTheme = await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('[data-settings-option="theme:dark"]'); if (!el) return false; el.click(); return true; })()`,
        true,
      );
      await new Promise((r) => setTimeout(r, 500));
      const darkApplied = await win.webContents.executeJavaScript(
        `document.documentElement.classList.contains("dark")`,
        true,
      );
      results.push(`切深色作用于整个应用=${clickedTheme && darkApplied}`);
      ok &&= clickedTheme && darkApplied;

      // 切简体中文：验证整个应用的文本都变了，而不只是模态框
      // 若当前已经是中文环境（如二次运行继承了上一次的 userData），先切至英文建立对照基准
      if (cjkBefore > 50) {
        await win.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('[data-settings-option="locale:en"]'); if (el) el.click(); })()`,
          true,
        );
        await new Promise((r) => setTimeout(r, 1200));
      }
      const baseCjk = await win.webContents.executeJavaScript(
        `(${cjkCount.toString()})()`,
        true,
      );
      const clickedLocale = await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('[data-settings-option="locale:zh-CN"]'); if (!el) return false; el.click(); return true; })()`,
        true,
      );
      await new Promise((r) => setTimeout(r, 1200));
      const cjkAfter = await win.webContents.executeJavaScript(
        `(${cjkCount.toString()})()`,
        true,
      );
      const localeOk = clickedLocale && cjkAfter > baseCjk + 20;
      results.push(
        `切中文作用于整个应用=${localeOk} (中文字符 ${baseCjk}→${cjkAfter})`,
      );
      ok &&= localeOk;

      // 壳层专属项应渲染（主窗口已挂 preload，window.irouterShell 存在）
      const shellApiOk = await win.webContents.executeJavaScript(
        `Boolean(window.irouterShell?.getSettings)`,
        true,
      );
      results.push(`主窗口已挂preload=${shellApiOk}`);
      ok &&= shellApiOk;

      // 关闭路径：点显式关闭按钮应关掉模态框（用户要求：必须有关闭按钮，
      // 且不支持点非弹窗位置关闭——误触遮罩不该丢改动）。
      const closeBtnFound = await win.webContents.executeJavaScript(
        `(() => { const btns = Array.from(document.querySelectorAll(".shell-settings-modal button")); const el = btns.find((b) => /Close|关闭/.test(b.textContent)); if (!el) return false; el.click(); return true; })()`,
        true,
      );
      await new Promise((r) => setTimeout(r, 400));
      const modalClosed = await win.webContents.executeJavaScript(
        `!document.querySelector(".shell-settings-modal")`,
        true,
      );
      results.push(`关闭按钮可关掉模态框=${closeBtnFound && modalClosed}`);
      ok &&= closeBtnFound && modalClosed;

      // 点遮罩不应关闭：重新打开后点遮罩，模态框应仍在
      win.webContents.send("shell:open-settings");
      await new Promise((r) => setTimeout(r, 600));
      const overlayClicked = await win.webContents.executeJavaScript(
        `(() => { const m = document.querySelector(".shell-settings-modal"); if (!m) return false; const ov = m.parentElement.querySelector(".absolute.inset-0"); if (!ov) return false; ov.click(); return true; })()`,
        true,
      );
      await new Promise((r) => setTimeout(r, 400));
      const stillOpen = await win.webContents.executeJavaScript(
        `Boolean(document.querySelector(".shell-settings-modal"))`,
        true,
      );
      results.push(`点遮罩不关闭=${overlayClicked && stillOpen}`);
      ok &&= overlayClicked && stillOpen;

      // 配置导出/导入段（ADR 0006）：从面板的 profile 页迁到此处，故而是桌面专属。
      // 冒烟环境停在登录页，正好钉住未登录态——该接口在 ALWAYS_PROTECTED，无 JWT
      // 一律 401，所以这一段必须可见但禁用并说明原因，不能点了才发现。
      const gwData = await win.webContents.executeJavaScript(
        `(() => {
           const m = document.querySelector(".shell-settings-modal");
           if (!m) return { found: false };
           const txt = m.innerText;
           const btns = Array.from(m.querySelectorAll("button"));
           const pick = (re) => btns.find((b) => re.test(b.textContent)) || null;
           const exp = pick(/Export Configuration|导出配置/);
           const imp = pick(/Import Configuration|导入配置/);
           return {
             found: true,
             heading: /Gateway data|网关数据/.test(txt),
             signInHint: /Sign in to manage backups|请先登录/.test(txt),
             // 未登录时 /info 返回 401，路径为占位符而非任何写死的路径
             noHardcodedPath: !/data\\.sqlite/.test(txt),
             exportDisabled: exp ? exp.disabled : null,
             importDisabled: imp ? imp.disabled : null,
           };
         })()`,
        true,
      );
      const gwOk =
        gwData.found &&
        gwData.heading &&
        gwData.signInHint &&
        gwData.noHardcodedPath &&
        gwData.exportDisabled === true &&
        gwData.importDisabled === true;
      results.push(
        `配置段可见且未登录禁用=${gwOk} (标题=${gwData.heading} 未登录提示=${gwData.signInHint} 无写死路径=${gwData.noHardcodedPath} 导出禁用=${gwData.exportDisabled} 导入禁用=${gwData.importDisabled})`,
      );
      ok &&= gwOk;
      // 收尾：关掉再验关窗行为
      await win.webContents.executeJavaScript(
        `(() => { const btns = Array.from(document.querySelectorAll(".shell-settings-modal button")); const el = btns.find((b) => /Close|关闭/.test(b.textContent)); if (el) el.click(); })()`,
        true,
      );
      await new Promise((r) => setTimeout(r, 300));

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
  // 单实例锁被占用时：若为冒烟测试则直接退出；若为桌面用户操作则弹出原生对话框引导
  if (!gotTheLock) {
    if (SMOKE) {
      console.error("[iRouter] 获取单实例锁失败，已有实例运行中");
      app.exit(1);
      return;
    }
    // 弹出原生提示框，提供明确操作指引并支持一键双开体验
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "iRouter 已在运行",
      message: "检测到已有 iRouter 实例正在后台运行",
      detail:
        "系统已有一个正在运行的 iRouter 实例并占用默认数据目录与端口。\n\n" +
        "• 若要正常使用此新版本：请先在顶部菜单栏/托盘中退出旧版 iRouter，再重新打开本应用\n" +
        "• 若要保留旧版本同时测试新版本：请点击「以独立实例双开运行」",
      buttons: ["退出", "以独立实例双开运行"],
      defaultId: 1,
      cancelId: 0,
    });
    if (choice === 1) {
      // 启动独立实例：分配隔离的 userData 目录与数据目录，端口自动顺延至 20129
      const baseUserData = app.getPath("userData");
      const altDir = path.join(path.dirname(baseUserData), "iRouter-Multi");
      const altDataDir = path.join(os.homedir(), ".irouter-multi");
      const child = spawn(
        process.execPath,
        [...process.argv.slice(1), "--multi-instance"],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            IROUTER_USER_DATA: altDir,
            IROUTER_DATA_DIR: altDataDir,
          },
        },
      );
      child.unref();
    }
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
  registerSettingsIpc();

  // 初始语言设定：优先读取系统语言偏好
  currentLocale = normalizeMenuLocale(app.getLocale());
  setupApplicationMenu(currentLocale);

  // 监听 Cookies 变化，当用户在面板切换语言时即时同步菜单
  session.defaultSession.cookies.on(
    "changed",
    (_event, cookie, _cause, removed) => {
      if (!removed && cookie.name === "locale") {
        setAppLocale(cookie.value);
      }
    },
  );
  const dataDir = getGatewayDataDir();
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
