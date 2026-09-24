<div align="center">

# iRouter

**Cross-platform Native Desktop Application for 9Router**

English | [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/kevinjoy89/iRouter?include_prereleases)](https://github.com/kevinjoy89/iRouter/releases)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](https://github.com/kevinjoy89/iRouter/releases)

</div>

---

**iRouter** is a cross-platform standalone desktop application for 9Router. It packages the gateway and dashboard into a true native desktop app powered by Electron—no system Node.js environment required and no need to open a separate browser tab.

The gateway core is based on upstream [decolua/9router](https://github.com/decolua/9router) (MIT, **v0.5.86**) with custom extensions in the repository root (`src/`, `open-sse/`, `tests/`), while the desktop shell layer is maintained under `desktop/`. For architecture decisions and terms, see [CONTEXT.md](./CONTEXT.md) and [docs/adr/](./docs/adr/).

---

## ✨ Key Features

- 🖥️ **Native Desktop Experience**: Built with Electron, supporting system tray residency, single-instance lock, and auto-start on boot. Closing the window simply minimizes it to the tray, keeping the background gateway service running seamlessly.
- 🎯 **Effort Cap Degradation & Effort-Aware Routing**: Proactively clamps the request `reasoning_effort` to the supported tier set declared by each provider, prioritizing combo model members that natively support the target effort.
- 🔄 **Intelligent Auto-Retry**: Automatically intercepts rate-limiting and temporary gateway errors (429, 503, 529) with jittered exponential backoff before the first byte is streamed, preventing external CLI agents (Claude Code, Codex, Cursor) from aborting immediately.
- 🛡️ **Egress Request Redaction (DLP)**: Inspects and sanitizes outbound request bodies for sensitive credentials, private keys, national IDs, and payment card numbers before forwarding, operating with a fail-open guarantee.
- 📊 **Full Usage Retention & Real-time Refresh**: Rolling 24-hour dynamic refresh with comprehensive historical detail preservation and precise status filtering.
- 🔒 **Isolated Data Storage**: Gateway SQLite database, keys, and configurations are persisted in `~/.irouter`, isolated from app cache and uninstallation. Seamless one-click migration from legacy CLI `~/.9router` data is supported on first launch.

---

## 🚀 Installation & Downloads

### Option 1: Download Pre-built Installers (Recommended)
Download the latest pre-compiled binary package from [GitHub Releases](https://github.com/kevinjoy89/iRouter/releases):
- **macOS**: `iRouter-0.3.0.dmg`
- **Windows**: `iRouter-0.3.0-setup.exe`
- **Linux**: `iRouter-0.3.0.AppImage`

Drag **iRouter** into your `Applications` folder to start.

> **macOS Gatekeeper Notice**:
> Since this is a personal open-source application without an Apple paid developer certificate (unsigned and un-notarized), macOS Gatekeeper may show a warning upon first launch. You can bypass it by:
> 1. In Finder -> Applications, **Right-click (or Control-click) iRouter -> Open -> click Open** in the prompt;
> 2. Or go to **System Settings -> Privacy & Security -> Security** and click **Open Anyway**.
> This confirmation is only required once.

### Option 2: Build from Source
```bash
git clone https://github.com/kevinjoy89/iRouter.git
cd iRouter/desktop
npm install --include=dev

# Package installer for your platform
npm run dist:mac    # macOS (.dmg)
npm run dist:win    # Windows (NSIS .exe)
npm run dist:linux  # Linux (.AppImage)
```

---

## 💡 Daily Usage

| Action | Behavior |
| --- | --- |
| **Launch iRouter** | Opens the window with embedded 9Router dashboard (gateway ready) |
| **Close Window** | Hides the window to system tray; the gateway service continues running |
| **System Tray** | Click tray icon for quick actions: Open Dashboard / Auto-Start / Quit |
| **Quit iRouter** | Right-click tray -> Quit; safely terminates gateway process and children |

---

## 🔌 Gateway Endpoint & CLI Configuration

The desktop dashboard and the OpenAI-compatible API share the same port:

```
Endpoint:  http://127.0.0.1:20128/v1
API Key:   Copy directly from the embedded dashboard
```

- **Default Port 20128**: Matches upstream CLI convention.
- **Port Escalation**: If port 20128 is already occupied (e.g., your CLI is running), iRouter **automatically probes and increments** to the next available port (e.g., 20129) without killing conflicting processes. Check the window title or tray tooltip for the active port.
- **Localhost Only**: Binds strictly to `127.0.0.1` for loopback security and never exposes the gateway to local networks.

---

## 📂 Data Directories

| Platform | Core Gateway Database & Settings (`DATA_DIR`) | Runtime & Chromium Cache |
| --- | --- | --- |
| macOS | `~/.irouter` (Core DB: `~/.irouter/db/data.sqlite`) | `~/Library/Application Support/iRouter` |
| Windows | `%USERPROFILE%\.irouter` | `%APPDATA%\iRouter` |
| Linux | `~/.irouter` | `~/.config/iRouter` |

**Uninstallation**: Quit from tray -> delete `iRouter.app` -> remove `~/.irouter` to leave zero traces.

---

## 🛠️ Local Development & Testing

```bash
cd desktop

# 1. Build server and launch desktop dev instance
npm run dev

# 2. Run end-to-end automated smoke tests (in isolated temp directory)
npm run smoke

# 3. Test migration import and single instance mutex
npm run test:import
npm run test:instance
```

See [CONTEXT.md](./CONTEXT.md), [docs/adr/](./docs/adr/), and [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed architecture decisions and development guides.

---

## 🤝 Acknowledgements

This project builds upon the work and inspiration of several open-source projects:

1. **[decolua/9router](https://github.com/decolua/9router)**:
   - Thanks to decolua and the 9Router contributors for providing a powerful, extensible AI routing gateway. iRouter customizes and packages 9Router under the terms of the MIT License.
2. **[momijineko/llm-retry-proxy](https://github.com/momijineko/llm-retry-proxy)**:
   - Special thanks to momijineko for pioneering techniques in resilient LLM proxying. iRouter draws direct inspiration and adapts core designs from this project for its **intelligent rate-limit auto-retry strategy**, **egress request redaction / DLP engine**, and **virtual-scrolling console log presentation layer**.

---

## 📄 License

This project is licensed under the **[MIT License](./LICENSE)**.
- Upstream 9Router components: Copyright (c) 2024-2026 decolua and contributors.
- iRouter desktop wrapper and custom enhancements: Copyright (c) 2026 kevinjoy89 and contributors.
