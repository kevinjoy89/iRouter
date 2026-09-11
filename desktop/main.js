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
  app.setPath("userData", path.join(path.dirname(baseUserData), "iRouter-Multi"));
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
        { host: "127.0.0.1", port, path: "/login", timeout: 3000, headers: { [PANEL_CLIENT_HEADER]: PANEL_CLIENT_VALUE } },
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
  header button[aria-label="Donate"],
  header button[aria-label*="mode"],
  header button[title*="mode"],
  header button[title="Language"],
  header button[data-i18n-skip="true"],
  header div.relative:has(> button[title="Menu"]),
  header button[title="Menu"],
  header div.flex.items-center.gap-1.shrink-0 > button,
  header div.flex.items-center.gap-1.shrink-0 > div.relative:not(:has(input)) { display: none !important; }
  div.fixed.inset-0.z-50[data-i18n-skip="true"],
  button[data-irouter-legacy-lang-btn="true"],
  div[data-irouter-lang-card="true"] > button:not([data-irouter-lang-switcher="true"] button) { display: none !important; }
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
  div.text-center.py-4 > p:first-child,
  div.text-center.text-text-muted.py-4 > p:first-child {
    font-size: 0 !important;
  }
  div.text-center.py-4 > p:first-child::after,
  div.text-center.text-text-muted.py-4 > p:first-child::after {
    content: "iRouter Proxy v${version}" !important;
    font-size: 0.875rem !important;
    line-height: 1.25rem !important;
  }
  /* 应用形态：默认禁文本选中（复制只发生在输入类与显式可复制区域）。
     Next 的 CSS 优化器会吞掉 globals.css 里的 body user-select 规则，
     故由壳层运行时注入（insertCSS 不走优化管线）。 */
  html, body, body * {
    -webkit-user-select: none !important;
    user-select: none !important;
  }
  input, textarea, select, option, [contenteditable="true"],
  [data-irouter-log], [data-irouter-log] * {
    -webkit-user-select: text !important;
    user-select: text !important;
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
// 通过 console-message 通知主进程，同步切换 macOS 系统标题栏外观与顶部原生菜单语言；
// 同时全面补足上游未处理的 placeholder、title、aria-label 属性、select 下拉选项与 skipped 节点翻译
const SHELL_SYNC_SCRIPT = `
(() => {
  if (window.__irouter_shell_sync_injected) return;
  window.__irouter_shell_sync_injected = true;
  const DESKTOP_VERSION = "${app.getVersion()}";

  // 拦截下载文件名，将 9router 前缀自动转换为 irouter 前缀
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "download");
    if (desc && desc.set) {
      const origSet = desc.set;
      Object.defineProperty(HTMLAnchorElement.prototype, "download", {
        get: desc.get,
        set: function(val) {
          if (typeof val === "string" && /^9router-(.+)$/i.test(val)) {
            val = val.replace(/^9router-/i, "irouter-");
          }
          return origSet.call(this, val);
        },
        configurable: true,
        enumerable: desc.enumerable,
      });
    }

    const origSetAttribute = HTMLAnchorElement.prototype.setAttribute;
    HTMLAnchorElement.prototype.setAttribute = function(name, val) {
      if (name === "download" && typeof val === "string" && /^9router-(.+)$/i.test(val)) {
        val = val.replace(/^9router-/i, "irouter-");
      }
      return origSetAttribute.call(this, name, val);
    };

    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (typeof this.download === "string" && /^9router-(.+)$/i.test(this.download)) {
        this.download = this.download.replace(/^9router-/i, "irouter-");
      }
      return origClick.call(this);
    };
  } catch (e) {
    /* 忽略拦截异常 */
  }

  // 1. 深浅色模式侦听与同步
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

  // 2. 多语言字典与 DOM 补全翻译
  function getLocale() {
    const m = document.cookie.match(/(?:^|;\\s*)locale=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  let currentLocale = getLocale() || "zh-CN";
  let currentDict = {};

  async function loadDict(loc) {
    if (!loc || loc === "en") {
      currentDict = {};
      return;
    }
    try {
      const res = await fetch("/i18n/literals/" + encodeURIComponent(loc) + ".json");
      if (res.ok) {
        currentDict = await res.json();
      }
    } catch (e) {
      // 忽略字典加载异常
    }
  }

  // 翻译 input / textarea placeholder 属性
  function translatePlaceholders() {
    const inputs = document.querySelectorAll("input[placeholder], textarea[placeholder]");
    for (const el of inputs) {
      if (el._i18nOrigPlaceholder === undefined) {
        el._i18nOrigPlaceholder = el.placeholder;
      }
      const orig = el._i18nOrigPlaceholder;
      if (!orig) continue;
      if (currentLocale === "en" || !currentDict) {
        if (el.placeholder !== orig) el.placeholder = orig;
      } else if (currentDict[orig]) {
        const target = currentDict[orig];
        if (el.placeholder !== target) el.placeholder = target;
      }
    }
  }

  // 仅精准处理设置页中被 data-i18n-skip 阻断的显示语言文案与图标
  function translateSkippedElements() {
    const skippedButtons = document.querySelectorAll("button[data-i18n-skip='true']");
    for (const btn of skippedButtons) {
      const spans = btn.querySelectorAll("span");
      for (const s of spans) {
        if (s._i18nOrigText === undefined) {
          s._i18nOrigText = s.textContent.trim();
        }
        const orig = s._i18nOrigText;
        if (orig === "Display language") {
          if (currentLocale === "en" || !currentDict) {
            if (s.textContent !== orig) s.textContent = orig;
          } else if (currentDict[orig]) {
            const target = currentDict[orig];
            if (s.textContent !== target) s.textContent = target;
          }
        } else if (s.textContent === "🇹🇼") {
          // 替换设置页按钮上的繁体国旗，防止渲染为方框缺失字符
          s.textContent = "🇭🇰";
        }
      }
    }
  }

  // 动态模式匹配翻译器（处理分页组件与配额计数的动态数字拼接文本）
  function translateDynamicPatterns() {
    const isZh = currentLocale === "zh-CN";
    const isTw = currentLocale === "zh-TW";
    if (!isZh && !isTw) return;

    const targets = document.querySelectorAll(".text-sm, .text-xs, span, p, h1, h2, h3, h4");
    for (const el of targets) {
      if (el.children.length > 0) continue;
      const txt = el.textContent.trim();
      if (!txt) continue;

      // 0. 替换旧品牌名称与版本号
      if (/^9Router\\s+Proxy(?:\\s+v[\\d.]+)?/i.test(txt)) {
        el.textContent = "iRouter Proxy v" + DESKTOP_VERSION;
        continue;
      }
      if (txt === "9Router Proxy") {
        el.textContent = "iRouter Proxy";
        continue;
      }
      // 替换个人设置页数据库实际持久化路径
      if (txt === "~/.9router/db/data.sqlite") {
        el.textContent = "~/.irouter/db/data.sqlite";
        continue;
      }

      // 1. 分页 "Showing 0-0 of 0" / "Showing 1-20 of 35"
      const showingMatch = txt.match(/^Showing\\s+(\\d+-\\d+)\\s+of\\s+(\\d+)(?:\\s+results)?$/i);
      if (showingMatch) {
        el.textContent = isTw
          ? "顯示 " + showingMatch[1] + " / 共 " + showingMatch[2] + " 條"
          : "显示 " + showingMatch[1] + " / 共 " + showingMatch[2] + " 条";
        continue;
      }

      // 2. 每页条数 "20 / page"
      const perPageMatch = txt.match(/^(\\d+)\\s*[/]\\s*page$/i);
      if (perPageMatch) {
        el.textContent = isTw
          ? perPageMatch[1] + " 條 / 頁"
          : perPageMatch[1] + " 条 / 页";
        continue;
      }

      // 3. 页码 "Page 1 / 1"
      const pageMatch = txt.match(/^Page\\s+(\\d+)\\s*[/]\\s*(\\d+)$/i);
      if (pageMatch) {
        el.textContent = isTw
          ? "第 " + pageMatch[1] + " / " + pageMatch[2] + " 頁"
          : "第 " + pageMatch[1] + " / " + pageMatch[2] + " 页";
        continue;
      }

      // 4. 配额计数 "1 quota", "2 quotas"
      const quotaMatch = txt.match(/^(\\d+)\\s+quotas?$/i);
      if (quotaMatch) {
        el.textContent = isTw
          ? quotaMatch[1] + " 個配額"
          : quotaMatch[1] + " 个配额";
        continue;
      }

      // 5. 供应商凭据弹窗标题 "Add <provider> API Key" 等
      const addKeyMatch = txt.match(/^Add\\s+(.+?)\\s+API\\s+Key$/i);
      if (addKeyMatch) {
        el.textContent = isTw
          ? "新增 " + addKeyMatch[1] + " API 金鑰"
          : "添加 " + addKeyMatch[1] + " API 密钥";
        continue;
      }
      const addCookieMatch = txt.match(/^Add\\s+(.+?)\\s+Cookie\\s+Value$/i);
      if (addCookieMatch) {
        el.textContent = isTw
          ? "新增 " + addCookieMatch[1] + " Cookie 值"
          : "添加 " + addCookieMatch[1] + " Cookie 值";
        continue;
      }
      const addPatMatch = txt.match(/^Add\\s+(.+?)\\s+Personal\\s+Access\\s+Token\\s*\\(PAT\\)$/i);
      if (addPatMatch) {
        el.textContent = isTw
          ? "新增 " + addPatMatch[1] + " 個人存取權杖 (PAT)"
          : "添加 " + addPatMatch[1] + " 个人访问令牌 (PAT)";
        continue;
      }

      // 6. 代理绑定数量 "Apply Proxy (1 connection)" / "Apply Proxy (3 connections)"
      const applyProxyMatch = txt.match(/^Apply\\s+Proxy\\s*\\(\\s*(\\d+)\\s+connections?\\s*\\)$/i);
      if (applyProxyMatch) {
        el.textContent = isTw
          ? "套用代理（" + applyProxyMatch[1] + " 個連線）"
          : "应用代理（" + applyProxyMatch[1] + " 个连接）";
        continue;
      }

      // 7. 社交登录连接 "Connect Kiro via <provider>"
      const kiroViaMatch = txt.match(/^Connect\\s+Kiro\\s+via\\s+(.+)$/i);
      if (kiroViaMatch) {
        el.textContent = isTw
          ? "透過 " + kiroViaMatch[1] + " 連線 Kiro"
          : "通过 " + kiroViaMatch[1] + " 连接 Kiro";
        continue;
      }

      // 8. 兼容节点编辑 "Edit Anthropic Compatible Node" / "Edit OpenAI Compatible Node"
      const editCompatMatch = txt.match(/^Edit\\s+(Anthropic|OpenAI)\\s+Compatible\\s+Node$/i);
      if (editCompatMatch) {
        el.textContent = isTw
          ? "編輯 " + editCompatMatch[1] + " 相容節點"
          : "编辑 " + editCompatMatch[1] + " 兼容节点";
        continue;
      }

      // 9. 代理池轮换动态提示
      const rotatePoolsMatch = txt.match(/^Rotating\\s+through\\s+all\\s+(\\d+)\\s+active\\s+pools\\s+in\\s+order\\.\\s+State\\s+is\\s+in-memory\\s*\\(resets\\s+on\\s+restart\\)\\.$/i);
      if (rotatePoolsMatch) {
        el.textContent = isTw
          ? "按順序在全部 " + rotatePoolsMatch[1] + " 個活躍代理池間輪換。狀態儲存在記憶體中（重啟後重設）。"
          : "按顺序在全部 " + rotatePoolsMatch[1] + " 个活跃代理池间轮换。状态保存在内存中（重启后重置）。";
        continue;
      }
      const randomPoolMatch = txt.match(/^Picking\\s+a\\s+random\\s+pool\\s+from\\s+(\\d+)\\s+active\\s+pools\\s+each\\s+request\\.$/i);
      if (randomPoolMatch) {
        el.textContent = isTw
          ? "每次請求從 " + randomPoolMatch[1] + " 個活躍代理池中隨機選取一個。"
          : "每次请求从 " + randomPoolMatch[1] + " 个活跃代理池中随机选择一个。";
        continue;
      }

      // 10. 媒体类型配置卡片标题 "类别 Config"
      const mediaConfigMatch = txt.match(/^(.+?)\\s+Config$/i);
      if (mediaConfigMatch) {
        const rawKind = mediaConfigMatch[1];
        const kindDict = {
          "Text To Speech": isTw ? "文字轉語音設定" : "文本转语音配置",
          "Speech To Text": isTw ? "語音轉文字設定" : "语音转文本配置",
          "Text to Image": isTw ? "文字轉影像設定" : "文本转图像配置",
          "Image to Text": isTw ? "影像轉文字設定" : "图像转文本配置",
          "Embedding": isTw ? "嵌入設定" : "嵌入配置",
          "Web Search": isTw ? "Web 搜尋設定" : "Web 搜索配置",
          "Web Fetch": isTw ? "Web 擷取設定" : "Web 抓取配置",
          "Video": isTw ? "影片設定" : "视频配置",
          "Music": isTw ? "音樂設定" : "音乐配置"
        };
        if (kindDict[rawKind]) {
          el.textContent = kindDict[rawKind];
          continue;
        }
      }

      // 11. 媒体提供商卡片连接统计状态 "1 Connected" / "2 Error" / "3 Added"
      const connStatMatch = txt.match(/^(\\d+)\\s+(Connected|Error|Added)$/i);
      if (connStatMatch) {
        const count = connStatMatch[1];
        const statType = connStatMatch[2].toLowerCase();
        if (statType === "connected") {
          el.textContent = isTw ? count + " 個已連線" : count + " 个已连接";
        } else if (statType === "error") {
          el.textContent = isTw ? count + " 個錯誤" : count + " 个错误";
        } else if (statType === "added") {
          el.textContent = isTw ? count + " 個已新增" : count + " 个已添加";
        }
        continue;
      }

      // 12. 媒体提供商统计摘要 "(X providers · Y combos)"
      const comboSummaryMatch = txt.match(/^\\((\\d+)\\s+providers\\s+·\\s+(\\d+)\\s+combos\\)$/i);
      if (comboSummaryMatch) {
        el.textContent = isTw
          ? "（" + comboSummaryMatch[1] + " 個供應商 · " + comboSummaryMatch[2] + " 個組合）"
          : "（" + comboSummaryMatch[1] + " 个供应商 · " + comboSummaryMatch[2] + " 个组合）";
        continue;
      }

      // 13. 添加模型模态框标题 "Add <kind> Model" / "Add <kind> Model to Combo"
      const addModelMatch = txt.match(/^Add\\s+(.+?)\\s+Model(\\s+to\\s+Combo)?$/i);
      if (addModelMatch) {
        const targetKind = addModelMatch[1];
        const isToCombo = !!addModelMatch[2];
        el.textContent = isTw
          ? (isToCombo ? "新增 " + targetKind + " 模型至組合" : "新增 " + targetKind + " 模型")
          : (isToCombo ? "添加 " + targetKind + " 模型到组合" : "添加 " + targetKind + " 模型");
        continue;
      }
    }
  }

  // 常用操作按钮与开关的 title 悬停提示翻译
  function translateActionTitles() {
    const isZh = currentLocale === "zh-CN";
    const isTw = currentLocale === "zh-TW";
    if (!isZh && !isTw) return;
    const titleDict = {
      "Enable provider": isTw ? "啟用供應商" : "启用供应商",
      "Disable provider": isTw ? "禁用供應商" : "禁用供应商",
      "Move up": isTw ? "上移" : "上移",
      "Move down": isTw ? "下移" : "下移",
      "Remove": isTw ? "移除" : "移除",
      "Click to edit": isTw ? "點擊編輯" : "点击编辑"
    };
    const titledElements = document.querySelectorAll("[title]");
    for (const el of titledElements) {
      const orig = el.getAttribute("title");
      if (orig && titleDict[orig]) {
        el.setAttribute("title", titleDict[orig]);
      }
    }
  }

  // 动态节点与异步状态翻译（处理表格表头与动态状态 Chip）
  function translateDynamicNodes() {
    const isZh = currentLocale === "zh-CN";
    const isTw = currentLocale === "zh-TW";
    if (!isZh && !isTw || !currentDict) return;

    // 1. 使用统计表格表头 <th> 翻译
    const ths = document.querySelectorAll("table thead th");
    for (const th of ths) {
      for (const node of th.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const raw = node.nodeValue;
          const trimmed = raw.trim();
          if (trimmed && currentDict[trimmed]) {
            const translated = currentDict[trimmed];
            const space = raw.endsWith(" ") ? " " : "";
            if (node.nodeValue !== translated + space) {
              node.nodeValue = translated + space;
            }
          }
        }
      }
    }

    // 2. 异步状态与弹窗动态状态（Token 节省器卡片与 Headroom/PXPIPE 弹窗等）
    const stateElements = document.querySelectorAll("span, p");
    const stateDict = {
      "Not installed": isTw ? "未安裝" : "未安装",
      "Checking…": isTw ? "正在檢查…" : "正在检查…",
      "Checking...": isTw ? "正在檢查…" : "正在检查…",
      "Installing…": isTw ? "正在安裝…" : "正在安装…",
      "Installing...": isTw ? "正在安裝…" : "正在安装…",
      "Uninstalling…": isTw ? "正在卸載…" : "正在卸载…",
      "Uninstalling...": isTw ? "正在卸載…" : "正在卸载…",
      "Stopping…": isTw ? "正在停止…" : "正在停止…",
      "Stopping...": isTw ? "正在停止…" : "正在停止…",
      "Running": isTw ? "運行中" : "运行中",
      "Stopped": isTw ? "已停止" : "已停止",
      "External": isTw ? "外部服務" : "外部服务",
      "Healthy": isTw ? "健康" : "健康",
      "PXPIPE is not installed.": isTw ? "未安裝 PXPIPE。" : "未安装 PXPIPE。"
    };
    for (const el of stateElements) {
      if (el.children.length > 0) continue;
      const txt = el.textContent.trim();
      if (stateDict[txt] && el.textContent !== stateDict[txt]) {
        el.textContent = stateDict[txt];
      }
    }

    // 3. 动态描述文本与模态框标题（Caveman / Ponytail 压缩模式说明、供应商提示横幅、弹窗标题等）
    const descElements = document.querySelectorAll("h1, h2, h3, h4, p.text-xs.text-primary, p.text-xs, p.text-sm, span.text-sm, span.text-xs");
    for (const el of descElements) {
      if (el.children.length > 0) continue;
      const txt = el.textContent.trim();
      if (currentDict && currentDict[txt] && el.textContent !== currentDict[txt]) {
        el.textContent = currentDict[txt];
      }
    }
  }

  // 检查跟随系统偏好，自动对齐系统语言
  function checkSystemLocaleSync() {
    try {
      const pref = localStorage.getItem("irouter_locale_preference");
      if (pref === "system") {
        const navLang = (navigator.language || navigator.userLanguage || "en").toLowerCase();
        let expected = "en";
        if (navLang.includes("tw") || navLang.includes("hk") || navLang.includes("hant")) {
          expected = "zh-TW";
        } else if (navLang.startsWith("zh")) {
          expected = "zh-CN";
        }
        const cur = getLocale();
        if (cur && cur !== expected) {
          document.cookie = "locale=" + encodeURIComponent(expected) + "; path=/; max-age=31536000";
          fetch("/api/locale", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ locale: expected }),
          }).catch(() => {});
          window.location.reload();
        }
      }
    } catch (e) {
      /* 忽略异常 */
    }
  }
  checkSystemLocaleSync();

  // 重构个人设置页多语言卡片：移除弹出面板，内嵌跟随系统、英文、简体中文、繁体中文切换项
  function renderLanguageSettingsSwitcher() {
    // 1. 全局将繁体中文旗帜 🇹🇼 安全替换为 🇭🇰，消灭在 macOS 上的方框缺失乱码
    const flagSpans = document.querySelectorAll("span");
    for (const sp of flagSpans) {
      if (sp.children.length === 0 && sp.textContent === "🇹🇼") {
        sp.textContent = "🇭🇰";
      }
    }

    // 2. 彻底隐藏并移除上游全量模态弹窗（若意外挂载）
    const legacyModals = document.querySelectorAll(".fixed.inset-0.z-50[data-i18n-skip='true']");
    for (const m of legacyModals) {
      m.style.setProperty("display", "none", "important");
      try { m.remove(); } catch (e) {}
    }

    // 3. 寻找个人设置页包含地球图标与语言标题的卡片容器
    const icons = document.querySelectorAll("span.material-symbols-outlined");
    let targetHeader = null;
    let targetCard = null;
    for (const icon of icons) {
      if (icon.textContent.trim() === "language") {
        const iconBox = icon.parentElement;
        const candidateHeader = iconBox ? iconBox.parentElement : null;
        if (!candidateHeader) continue;
        const h3 = candidateHeader.querySelector("h3");
        if (h3 && /^(?:Language|语言|語言)$/i.test(h3.textContent.trim())) {
          targetHeader = candidateHeader;
          targetCard = candidateHeader.parentElement || candidateHeader.closest(".rounded-xl, .bg-surface, div");
          break;
        }
      }
    }
    if (!targetHeader || !targetCard) return;

    targetCard.setAttribute("data-irouter-lang-card", "true");

    // 4. 彻底隐藏并拦截卡片内原有的显示语言单行按钮
    const legacyBtn = targetCard.querySelector("button[data-i18n-skip='true']");
    if (legacyBtn) {
      legacyBtn.setAttribute("data-irouter-legacy-lang-btn", "true");
      legacyBtn.style.setProperty("display", "none", "important");
      legacyBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
    }

    // 5. 彻底清理任何已存在的多余 switcher，保证全局唯一
    const existingSwitchers = targetCard.querySelectorAll("[data-irouter-lang-switcher='true']");
    for (let i = 1; i < existingSwitchers.length; i++) {
      existingSwitchers[i].remove();
    }

    // 6. 调整头部容器样式：保持横向并允许自适应
    targetHeader.className = "flex items-center gap-3 mb-4 flex-wrap sm:flex-nowrap";

    // 7. 注入或复用 Segmented Control 分段切换容器（靠右对齐且不缩小）
    let switcher = targetHeader.querySelector("[data-irouter-lang-switcher='true']");
    if (!switcher) {
      switcher = document.createElement("div");
      switcher.setAttribute("data-irouter-lang-switcher", "true");
      targetHeader.appendChild(switcher);
    }
    switcher.className = "inline-flex items-center p-1 rounded-lg bg-black/5 dark:bg-white/5 ml-auto shrink-0";
    switcher.style.whiteSpace = "nowrap";

    // 8. 获取当前用户偏好设置（默认为跟随系统）
    let pref = localStorage.getItem("irouter_locale_preference");
    if (!pref) {
      pref = "system";
      localStorage.setItem("irouter_locale_preference", "system");
    }

    // 9. 依据当前生效语言渲染选项文本
    const isTw = currentLocale === "zh-TW";
    const isZh = currentLocale === "zh-CN";
    const options = [
      { id: "system", label: isTw ? "跟隨系統" : isZh ? "跟随系统" : "System" },
      { id: "en", label: isTw ? "英文" : isZh ? "英文" : "English" },
      { id: "zh-CN", label: isTw ? "簡體中文" : isZh ? "简体中文" : "Simplified Chinese" },
      { id: "zh-TW", label: isTw ? "繁體中文" : isZh ? "繁体中文" : "Traditional Chinese" },
    ];

    // 解析宿主系统当前语言
    function resolveSystemLocale() {
      const navLang = (navigator.language || navigator.userLanguage || "en").toLowerCase();
      if (navLang.includes("tw") || navLang.includes("hk") || navLang.includes("hant")) {
        return "zh-TW";
      }
      if (navLang.startsWith("zh")) {
        return "zh-CN";
      }
      return "en";
    }

    // 执行多语言切换与生效
    async function applyLocaleSelection(selectedId) {
      localStorage.setItem("irouter_locale_preference", selectedId);
      const targetLocale = selectedId === "system" ? resolveSystemLocale() : selectedId;
      try {
        await fetch("/api/locale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale: targetLocale }),
        });
      } catch (err) {
        /* 忽略网络异常 */
      }
      document.cookie = "locale=" + encodeURIComponent(targetLocale) + "; path=/; max-age=31536000";
      window.location.reload();
    }

    // 10. 渲染并更新切换项状态（强制横向不换行）
    options.forEach((opt) => {
      let btn = switcher.querySelector("button[data-lang='" + opt.id + "']");
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("data-lang", opt.id);
        btn.addEventListener("click", () => {
          if (pref === opt.id) return;
          applyLocaleSelection(opt.id);
        });
        switcher.appendChild(btn);
      }
      btn.textContent = opt.label;
      btn.style.whiteSpace = "nowrap";
      const isSelected = pref === opt.id;
      btn.className = isSelected
        ? "flex items-center justify-center px-3 py-1.5 rounded-md font-medium text-xs sm:text-sm whitespace-nowrap shrink-0 bg-white dark:bg-white/10 text-text-main shadow-sm transition-all cursor-pointer"
        : "flex items-center justify-center px-3 py-1.5 rounded-md font-medium text-xs sm:text-sm whitespace-nowrap shrink-0 text-text-muted hover:text-text-main transition-all cursor-pointer";
    });
  }

  // 替换设置页底部及各处遗留的产品名称与版本号为桌面端真实名称与版本
  function replaceAppBrandAndVersion() {
    const sideVer = document.querySelector("aside a[href='/dashboard'] h1 + span");
    if (sideVer && sideVer.textContent.trim() !== "v" + DESKTOP_VERSION) {
      sideVer.textContent = "v" + DESKTOP_VERSION;
    }

    const profileAppInfoP = document.querySelector("div.text-center.py-4 > p:first-child, div.text-center.text-text-muted.py-4 > p:first-child");
    if (profileAppInfoP && profileAppInfoP.textContent.trim() !== "iRouter Proxy v" + DESKTOP_VERSION) {
      profileAppInfoP.textContent = "iRouter Proxy v" + DESKTOP_VERSION;
    }

    const targets = document.querySelectorAll("p, span, h1");
    for (const el of targets) {
      if (el.children.length > 0) continue;
      const txt = el.textContent.trim();
      if (!txt) continue;
      if (/^9Router\\s+Proxy(?:\\s+v[\\d.]+)?/i.test(txt)) {
        if (el.textContent !== "iRouter Proxy v" + DESKTOP_VERSION) {
          el.textContent = "iRouter Proxy v" + DESKTOP_VERSION;
        }
      } else if (txt === "9Router Proxy") {
        if (el.textContent !== "iRouter Proxy") {
          el.textContent = "iRouter Proxy";
        }
      } else if (txt === "~/.9router/db/data.sqlite") {
        if (el.textContent !== "~/.irouter/db/data.sqlite") {
          el.textContent = "~/.irouter/db/data.sqlite";
        }
      }
    }

    // 修正已有下载链接的文件名前缀
    const downloadAnchors = document.querySelectorAll("a[download]");
    for (const a of downloadAnchors) {
      const dl = a.getAttribute("download");
      if (dl && /^9router-/i.test(dl)) {
        a.setAttribute("download", dl.replace(/^9router-/i, "irouter-"));
      }
    }
  }

  // 换算大数值指标为万/亿单位，仅大于 10000 时生效
  function formatLargeMetricNumber(rawText, locale) {
    if (typeof rawText !== "string") return rawText;
    const cleaned = rawText.replace(/,/g, "").trim();
    const num = Number(cleaned);
    if (isNaN(num) || !isFinite(num)) return rawText;

    // 仅大于 10000 时才换算
    if (num <= 10000) {
      return rawText;
    }

    const isTw = locale === "zh-TW";
    const isZh = locale === "zh-CN" || (!isTw && locale !== "en");

    if (isZh || isTw) {
      const wanUnit = isTw ? " 萬" : " 万";
      const yiUnit = isTw ? " 億" : " 亿";

      // 大于等于 1 亿 (100,000,000)
      if (num >= 100000000) {
        const val = num / 100000000;
        return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + yiUnit;
      }

      // 大于 1 万
      const val = num / 10000;
      // 进位检查：若四舍五入后达到 10000.00 万，进位至 1.00 亿
      const roundedStr = val.toFixed(2);
      if (roundedStr === "10000.00") {
        return "1.00" + yiUnit;
      }
      return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + wanUnit;
    }

    // 英文模式 (en)
    if (locale === "en") {
      if (num >= 1000000000) {
        const val = num / 1000000000;
        return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "B";
      }
      if (num >= 1000000) {
        const val = num / 1000000;
        const rounded = val.toFixed(2);
        if (rounded === "1000.00") return "1.00B";
        return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "M";
      }
      const val = num / 1000;
      const rounded = val.toFixed(2);
      if (rounded === "1000.00") return "1.00M";
      return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "K";
    }

    return rawText;
  }

  // 对使用情况页面的统计卡片大数值进行万/亿换算
  function formatUsageOverviewNumbers() {
    const candidateSpans = document.querySelectorAll("span.truncate.text-2xl.font-bold");
    for (const el of candidateSpans) {
      if (el.classList.contains("text-warning")) continue;

      const currentText = el.textContent.trim();
      if (!currentText || currentText.includes("$") || currentText.includes("~")) continue;

      const isPureNumber = /^\\d{1,3}(?:,\\d{3})*$/.test(currentText);

      if (isPureNumber) {
        el._irouterRawNumber = currentText;
        el.setAttribute("title", currentText);
        const formatted = formatLargeMetricNumber(currentText, currentLocale);
        if (el.textContent !== formatted) {
          el.textContent = formatted;
          el._irouterFormattedText = formatted;
          el._irouterFormattedLocale = currentLocale;
        }
      } else if (el._irouterRawNumber && el._irouterFormattedLocale !== currentLocale) {
        const formatted = formatLargeMetricNumber(el._irouterRawNumber, currentLocale);
        if (el.textContent !== formatted) {
          el.textContent = formatted;
          el._irouterFormattedText = formatted;
          el._irouterFormattedLocale = currentLocale;
        }
      }
    }
  }

  let updateTimer = null;
  function triggerDomTranslate() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      replaceAppBrandAndVersion();
      formatUsageOverviewNumbers();
      translatePlaceholders();
      translateSkippedElements();
      translateDynamicPatterns();
      translateDynamicNodes();
      renderLanguageSettingsSwitcher();
      translateActionTitles();
    }, 50);
  }

  async function updateLocale(newLocale) {
    currentLocale = newLocale;
    await loadDict(newLocale);
    triggerDomTranslate();
  }

  let lastLocale = getLocale();
  if (lastLocale) {
    console.log("__IROUTER_LOCALE__:" + lastLocale);
    updateLocale(lastLocale);
  }

  setInterval(() => {
    const current = getLocale();
    if (current && current !== lastLocale) {
      lastLocale = current;
      console.log("__IROUTER_LOCALE__:" + current);
      updateLocale(current);
    }
  }, 500);

  const domObserver = new MutationObserver(() => {
    triggerDomTranslate();
  });
  const observeConfig = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["placeholder"]
  };
  if (document.body) {
    domObserver.observe(document.body, observeConfig);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      domObserver.observe(document.body, observeConfig);
      triggerDomTranslate();
    });
  }
  triggerDomTranslate();
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
            { role: "selectAll", label: t.selectAll, enabled: editable || hasSel },
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

  // 拦截下载事件，若文件名仍带有 9router 前缀则兜底重命名为 irouter 前缀
  win.webContents.session.on("will-download", (_event, item) => {
    const filename = item.getFilename();
    if (/^9router-/i.test(filename)) {
      const newFilename = filename.replace(/^9router-/i, "irouter-");
      const currentSavePath = item.getSavePath();
      if (currentSavePath) {
        item.setSavePath(path.join(path.dirname(currentSavePath), newFilename));
      }
    }
  });

  win.webContents.on("did-finish-load", () => {
    win.setTitle(windowTitle());
    if (SMOKE && !smokeStarted) runSmoke();
  });
  applyShellCss(win);
  applyShellSync(win);

  // 面板访问守卫：网关侧（custom-server）按 UA 中的 Electron 标识放行桌面窗口，
  // 浏览器直连 HTML 页面被连接级拒绝（见 custom-server.js isBlockedPanelRequest）。

  win.once("ready-to-show", () => win.show());

  // 启动时清一次残留缓存再加载，避免覆盖安装后的旧资源（详见顶部 disable-http-cache）
  session.defaultSession.clearCache().catch(() => {}).then(() => {
    win.loadURL(`${gatewayOrigin()}/`);
  });
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
    copy: "Copy",
    paste: "Paste",
    cut: "Cut",
    selectAll: "Select All"
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
    copy: "复制",
    paste: "粘贴",
    cut: "剪切",
    selectAll: "全选"
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
    copy: "複製",
    paste: "貼上",
    cut: "剪下",
    selectAll: "全選"
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
    selectAll: "すべて選択"
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
    selectAll: "모두 선택"
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
    selectAll: "Seleccionar todo"
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
    selectAll: "Tout sélectionner"
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
    selectAll: "Alles auswählen"
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
    selectAll: "Выделить всё"
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
    selectAll: "Selecionar tudo"
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
    selectAll: "Chọn tất cả"
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

// 从历史 Application Support 目录平滑迁移现有数据至 ~/.irouter
function migrateFromLegacyApplicationSupport(targetDir) {
  try {
    const targetDb = path.join(targetDir, "db", "data.sqlite");
    if (fs.existsSync(targetDb)) return;

    const oldSupportDir = app.getPath("userData");
    if (path.resolve(oldSupportDir) === path.resolve(targetDir)) return;
    const oldDb = path.join(oldSupportDir, "db", "data.sqlite");
    if (!fs.existsSync(oldDb)) return;

    console.log(`[iRouter] 检测到旧应用支持目录数据，正在平滑迁移至 ${targetDir}...`);
    fs.mkdirSync(targetDir, { recursive: true });

    // 需要迁移的核心条目
    const itemsToMigrate = [
      "db",
      "auth",
      "headroom",
      "jwt-secret",
      "machine-id",
      "model-catalog.json",
      "model-catalog-raw.json",
      ".irouter-import-decided",
    ];

    for (const item of itemsToMigrate) {
      const src = path.join(oldSupportDir, item);
      const dest = path.join(targetDir, item);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true, force: false });
      }
    }
    console.log(`[iRouter] 旧应用支持目录数据已成功平滑迁移至 ${targetDir}`);
  } catch (e) {
    console.error(`[iRouter] 平滑迁移旧数据异常: ${e.message}`);
  }
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
      { host: "127.0.0.1", port: gatewayPort, path: pathname, timeout: 5000, headers: { [PANEL_CLIENT_HEADER]: PANEL_CLIENT_VALUE } },
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
        const secretPath = fs.existsSync(path.join(getGatewayDataDir(), "jwt-secret"))
          ? path.join(getGatewayDataDir(), "jwt-secret")
          : path.join(app.getPath("userData"), "jwt-secret");
        const secret = fs.readFileSync(secretPath);
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

      // 面板文案多语言：以「脱敏策略」卡片（ADR 0005）为探针，验证面板字典确实随包分发
      // 且新增文案已入典。浏览器直连面板被 custom-server 守卫拒绝（连接级掐断），
      // 故只能在这里驱动真实桌面窗口断言——这也是本检查放在 smoke 而非单测的原因。
      // 回归背景：该卡片首版全部文案漏入字典，中文界面整片显示英文。
      try {
        await win.webContents.session.cookies.set({
          url: gatewayOrigin(),
          name: "locale",
          value: "zh-CN",
        });
        await win.webContents.loadURL(`${gatewayOrigin()}/dashboard/profile`);
        await new Promise((resolve) => {
          if (!win.webContents.isLoadingMainFrame()) {
            resolve();
            return;
          }
          const t = setTimeout(resolve, 5000);
          win.webContents.once("did-finish-load", () => {
            clearTimeout(t);
            resolve();
          });
        });
        // 等运行时 i18n 取回字典并完成 DOM 替换
        await new Promise((r) => setTimeout(r, 2500));

        const panelI18n = await win.webContents.executeJavaScript(
          `(() => {
             const body = document.body.innerText;
             const opts = [...document.querySelectorAll("option")].map((o) => o.textContent.trim());
             // 豁免标记字面量须可见（曾有版本只留开关，用户无从得知该写什么）；
             // 用码点构造断言串，避免源码/中间层改写 [[ ]] 字面量
             const B = String.fromCharCode(91, 91), E2 = String.fromCharCode(93, 93);
             const OPEN = B + "ALLOW_SENSITIVE" + E2;
             const CLOSE = B + "/ALLOW_SENSITIVE" + E2;
             const codes = [...document.querySelectorAll("code")].map((c) => c.textContent.trim());
             return {
               card: body.includes("脱敏策略"),
               knownSecrets: body.includes("匹配本机已存凭据"),
               exemptions: body.includes("允许豁免标记"),
               // 四档 mode 文案（option 的直接父元素不在 runtime skipTags 内，故会被翻译）
               modes: ["关闭 —", "仅告警 —", "改写 —", "拦截 —"].every((p) => opts.some((o) => o.startsWith(p))),
               markers: codes.includes(OPEN) && codes.includes(CLOSE),
               // 英文残留即回归（卡片内不应再有整句英文）
               leaked: body.includes("Redaction Policy") || body.includes("forward everything unchanged"),
             };
           })()`,
          true,
        );
        const panelOk = panelI18n.card && panelI18n.knownSecrets && panelI18n.exemptions
          && panelI18n.modes && panelI18n.markers && !panelI18n.leaked;
        results.push(`面板文案中文=${panelOk} (卡片=${panelI18n.card}, 凭据=${panelI18n.knownSecrets}, 豁免=${panelI18n.exemptions}, 档位=${panelI18n.modes}, 豁免标记可见=${panelI18n.markers}, 英文残留=${panelI18n.leaked})`);
        ok &&= panelOk;

        // 可选：把面板截图落盘，供人工核对布局（文本断言看不出换行/溢出/对齐问题）。
        // 用法：IROUTER_SMOKE_SHOT=/tmp/x.png npm run smoke:packaged
        if (process.env.IROUTER_SMOKE_SHOT) {
          try {
            // 滚到 Redaction Policy 卡片，再截可视区
            await win.webContents.executeJavaScript(
              `(() => { const el = [...document.querySelectorAll("h3")].find((h) => h.textContent.trim() === "脱敏策略");
                        if (el) el.scrollIntoView({ block: "center" }); return !!el; })()`,
              true,
            );
            await new Promise((r) => setTimeout(r, 600));
            const img = await win.webContents.capturePage();
            fs.writeFileSync(process.env.IROUTER_SMOKE_SHOT, img.toPNG());
            results.push(`面板截图=${process.env.IROUTER_SMOKE_SHOT}`);
          } catch (e) {
            results.push(`面板截图失败：${e.message}`);
          }
        }
      } catch (e) {
        results.push(`面板文案中文检查异常：${e.message}`);
        ok = false;
      } finally {
        await win.webContents.session.cookies.remove(gatewayOrigin(), "locale").catch(() => {});
      }

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
  // 初始语言设定：优先读取系统语言偏好
  currentLocale = normalizeMenuLocale(app.getLocale());
  setupApplicationMenu(currentLocale);

  // 监听 Cookies 变化，当用户在面板切换语言时即时同步菜单
  session.defaultSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (!removed && cookie.name === "locale") {
      setAppLocale(cookie.value);
    }
  });
  const dataDir = getGatewayDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  migrateFromLegacyApplicationSupport(dataDir);
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
