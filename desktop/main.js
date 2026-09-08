// iRouter 壳层主进程：内嵌窗口 + 托盘 + 网关子进程管理。
// 上游 9Router 零改动，仅通过进程边界交互（见 docs/adr/0002-pinned-upstream.md）。
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  shell,
  nativeImage,
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

function windowTitle() {
  return `iRouter — 9Router 网关 :${gatewayPort}`;
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

// 壳层注入 CSS：隐藏上游面板侧栏顶部的"假红绿灯"装饰（Sidebar.js 的 Traffic lights）。
// macOS 窗口自带真标题栏，页面里再画一组显得重复；且这是纯装饰，隐藏无功能影响。
// 选择器取 aside 内第一个 pt-5 的 flex 行（上游该块唯一），不依赖 Tailwind 色值类名。
// 壳层隐藏的上游 UI 装饰（均为纯装饰/入口，无功能影响；上游零改动，见 ADR-0002）：
// 1. 侧栏顶部仿 macOS 红绿灯装饰 —— 与窗口真标题栏重复
// 2. 9Remote / 9English 入口 —— 产品化时不想暴露的入口；9Remote 无 href，
//    用相邻兄弟选择器（它正好在 9English 链接前面）；上游小改结构时
//    选择器失效仅是“恢复显示”，优雅降级
// 3. 顶部栏捐赠入口 —— 纯赞助入口，壳层予以隐藏
const SHELL_HIDE_CSS = `
  aside > div.flex.items-center.gap-2.px-6.pt-5 { display: none !important; }
  aside > div.px-6.py-4 { padding-top: 18px !important; }
  aside > nav a[href="https://9english.net/"],
  aside > nav button:has(+ a[href="https://9english.net/"]) { display: none !important; }
  header button[aria-label="Donate"] { display: none !important; }
`;

function applyShellCss(win) {
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(SHELL_HIDE_CSS).catch(() => {});
  });
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  // 面板自带 <title>，固定为壳层标题（spec: 窗口标题包含 iRouter）
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
    if (SMOKE && !smokeStarted) runSmoke();
  });
  applyShellCss(win);

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

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(windowTitle());
  const menu = Menu.buildFromTemplate([
    { label: `网关地址：${gatewayOrigin()}/v1`, enabled: false },
    { type: "separator" },
    { label: "打开面板", click: showWindow },
    {
      label: "开机自启",
      type: "checkbox",
      checked: autostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    { type: "separator" },
    { label: "退出 iRouter", click: () => quit() },
  ]);
  tray.setContextMenu(menu);
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
        if (mainWindow.webContents.isLoadingMainFrame()) {
          mainWindow.webContents.once("did-finish-load", resolve);
        } else {
          resolve();
        }
      });
      results.push("窗口 did-finish-load ✓");

      // 壳层 CSS 应已隐藏的上游 UI 元素（假红绿灯 / 9Remote / 9English / 捐赠按钮），不许回归
      const win = mainWindow;
      const checks = {
        假红绿灯: "aside > div.flex.items-center.gap-2.px-6.pt-5",
        九Remote: "aside > nav button:has(+ a[href='https://9english.net/'])",
        九English: "aside > nav a[href='https://9english.net/']",
        捐赠按钮: "header button[aria-label='Donate']",
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
