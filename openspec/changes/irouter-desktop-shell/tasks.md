## 1. 仓库与构建管线

- [x] 1.1 确认/修正仓库结构：iRouter/ 为 git 仓库，9router/ 以 submodule 锁定 v0.5.69（commit eb712ca8），根目录 .gitignore 覆盖 desktop/build、node_modules、.next、.codegraph、.pi；验证 `git status` 干净且 `git -C 9router log -1` 为 eb712ca8
- [x] 1.2 搭建 desktop/ 脚手架：package.json（electron、electron-builder，scripts：build-server / dev / dist:mac / smoke）与 desktop/.gitignore；验证 `npm install` 成功
- [x] 1.3 实现 scripts/build-server.mjs：9router 内 npm install（幂等）→ `npm run build`（next build + postbuild 并入 static/public/custom-server.js）→ 复制 .next/standalone 到 desktop/build/server → 删除其中 node_modules/better-sqlite3；验证：desktop/build/server 存在且含 custom-server.js 与 .next/static，无 better-sqlite3，`git -C 9router status` 无源码改动
- [x] 1.4 验证 standalone 可独立运行：`node desktop/build/server/custom-server.js --port <随机端口>` 后 HTTP 探测 /v1 与 / 均 200，随后清理进程

## 2. 主进程（壳层行为）

- [x] 2.1 main.js 基础：单实例锁（重复启动聚焦已有实例）、网关子进程以 ELECTRON_RUN_AS_NODE 启动（--port + DATA_DIR=app.getPath('userData')）、waitServerReady 就绪后开窗；验证 `--smoke` 模式：网关就绪、/v1 响应、窗口 did-finish-load、退出码 0
- [x] 2.2 端口自适应：默认 20128，被占用时向上顺延空闲端口（TCP 连接探测，不用 listen 探测），不杀占用进程，窗口 URL 用实际端口且展示实际端口；验证：预先占用 20128 再启动，窗口指向新端口、占用进程存活
- [x] 2.3 窗口行为：内嵌面板、close 时 preventDefault + hide（关窗最小化到托盘）、setWindowOpenHandler 同源弹窗放行 / 异源走 shell.openExternal；验证：关窗后网关仍响应；同源 /callback 可达；站外链接在系统浏览器打开
- [ ] 2.4 托盘与自启：菜单含打开面板 / 开机自启 checkbox / 退出；自启默认关闭，开启后写入登录项且重启保持，自启启动（wasOpenedAtLogin）时不弹窗驻留托盘；验证：开关切换后系统登录项随之添加/移除，重启后设置保持
- [x] 2.5 首次运行导入：数据目录中尚无网关数据（db/auth/jwt-secret/machine-id）且 ~/.9router 存在时弹三选对话框（导入/跳过/取消），导入复制除 runtime/ 外的条目，跳过写标记不再询问，无旧数据不询问；验证：预置 ~/.9router 后启动弹窗、导入后平台数据目录出现数据、再启动不重复询问
- [x] 2.6 退出流程：托盘退出时 await 子进程终止 + 超时强杀；验证：退出后 `lsof -ti:<port>` 无残留

## 3. 图标与打包

- [x] 3.1 生成 iRouter 应用图标（1024×1024 PNG，AI 生成，橙色 AI 路由主题），置于 desktop/resources/icon.png（源资产纳入版本控制，build/ 是 gitignore 产物目录）；已验证：1024×1024、hasAlpha=yes、四角透明遮罩已加
- [x] 3.2 electron-builder 配置：appId com.irouter.desktop、productName iRouter、version 0.0.1、mac dmg（identity: null）、win nsis 与 linux AppImage 配置就位、extraResources 携带 desktop/build/server、icon 自动转 icns/ico；验证 `electron-builder --mac` 产出 desktop/build/dist/iRouter-0.0.1.dmg，且包内含 gateway/server/node_modules（30 包）、无 better-sqlite3；已验证：dmg 149M、打包产物 smoke PASS
- [ ] 3.3 dmg 人工安装验证（spec 验收）：安装后启动即见面板（无 Node 依赖）、数据写入平台目录、导入的旧配置可用、关窗驻留托盘、托盘退出无残留

## 4. 收尾

- [x] 4.1 README.md（iRouter 根目录）：安装与首次打开（未签名右键打开说明）、端口与外部 CLI endpoint 同步说明、开机自启、卸载方式、与 CLI 形态的关系
- [x] 4.2 全量回归：已重跑 build-server（幂等）、standalone 独立运行、smoke、test:import(15/15)、test:instance(5/5)、dist:mac、smoke:packaged；并补验两个 spec 场景——PATH 无 node 时成品可运行（自包含分发 ✓）、20128 被占用时顺延下一空闲端口且不动占用进程（端口自适应 ✓）。仍需人工：托盘点击类交互、开机自启、真实 OAuth 弹窗、dmg 安装
