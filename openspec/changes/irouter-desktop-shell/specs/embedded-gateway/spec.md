## Purpose

定义内嵌 9Router 网关的构建、启动与数据管理行为：随应用自包含分发、上游零改动、端口自适应、数据目录隔离与旧 CLI 数据导入，确保"装完即用"且不依赖目标机器环境。

## ADDED Requirements

### Requirement: 自包含分发

应用安装包 SHALL 包含完整可运行的 9Router 网关（面板与 /v1 API）；运行 SHALL NOT 依赖目标机器预装 Node/npm 或网络访问。

#### Scenario: 无 Node 环境可用

- **WHEN** 在未安装 Node 的机器上安装并启动 iRouter
- **THEN** 面板可打开且 <http://127.0.0.1>:<port>/v1 正常响应

#### Scenario: 离线可用

- **WHEN** 应用已安装且机器断网
- **THEN** 本地网关仍可启动并提供面板与 API（不涉及联网功能的操作除外）

### Requirement: 上游零改动

构建与运行 SHALL NOT 修改 9router/ 中的任何源码；升级上游 SHALL 通过切换 submodule 锁定版本并重新构建完成。

#### Scenario: 构建后上游保持干净

- **WHEN** 完成一次应用构建
- **THEN** 9router/ 目录无源码改动（仅允许未跟踪的构建副产物）

### Requirement: 网关生命周期

应用启动时 SHALL 启动网关；应用退出时 SHALL 终止网关，无残留进程。网关进程意外退出时，应用 SHALL 显示可理解的错误状态而非静默失败。

#### Scenario: 随应用启动与退出

- **WHEN** 应用启动、随后正常退出
- **THEN** 网关随之启动与终止，无残留进程

#### Scenario: 网关意外退出有提示

- **WHEN** 网关进程异常退出而应用仍在运行
- **THEN** 应用内显示错误提示，引导用户重启应用

### Requirement: 端口自适应

网关默认监听 20128；若被占用 SHALL 自动选择下一个空闲端口；SHALL NOT 终止或干扰占用端口的其他进程。实际端口 SHALL 用于面板加载并向用户展示。

#### Scenario: 默认端口可用

- **WHEN** 20128 空闲
- **THEN** 网关监听 20128

#### Scenario: 默认端口被占用

- **WHEN** 20128 已被其他进程占用
- **THEN** 网关改监听下一个空闲端口（如 20129），占用进程不受影响，面板使用实际端口

### Requirement: 数据目录隔离

网关数据（配置、数据库、密钥）SHALL 存放在平台标准应用数据目录：macOS `~/Library/Application Support/iRouter`、Windows `%APPDATA%\iRouter`、Linux `~/.config/iRouter`。数据 SHALL NOT 写入 9router/ 或安装目录。

#### Scenario: 首次运行判定

- **WHEN** 数据目录中尚无网关自身数据（db、auth、jwt-secret、machine-id）
- **THEN** 系统视为首次运行（Electron/Chromium 写入同目录的 profile 文件不算网关数据）

#### Scenario: macOS 数据位置

- **WHEN** 应用在 macOS 运行并产生数据
- **THEN** 数据位于 ~/Library/Application Support/iRouter

#### Scenario: 数据不写入源码与安装目录

- **WHEN** 应用运行
- **THEN** 安装目录与 9router/ 目录无数据写入（构建副产物除外）

### Requirement: 首次运行导入旧数据

当数据目录中尚无网关数据、且检测到旧 CLI 数据目录 ~/.9router 存在时，应用 SHALL 在首次运行询问用户是否导入；导入 SHALL 复制配置、数据库与密钥（auth、db、jwt-secret、machine-id、model-catalog 等，不含 runtime/）；用户选择跳过 SHALL 持久化标记，不再重复询问。

#### Scenario: 导入旧数据

- **WHEN** 首次运行且存在 ~/.9router，用户选择导入
- **THEN** 数据被复制到平台数据目录，面板呈现原有配置与登录态

#### Scenario: 跳过导入

- **WHEN** 首次运行且用户选择跳过
- **THEN** 应用以干净数据目录运行，且后续启动不再询问

#### Scenario: 无旧数据不询问

- **WHEN** 首次运行且不存在 ~/.9router
- **THEN** 不出现导入询问

### Requirement: 无原生模块存储

应用分发的网关 SHALL 使用不需按 Electron ABI 重编译的存储路径：优先 Node 内建的 `node:sqlite`，不可用时回退 `sql.js`（纯 WASM）；安装包 SHALL NOT 包含 `better-sqlite3` 原生模块。数据读写 SHALL 正常持久化。

#### Scenario: 无原生模块仍可持久化

- **WHEN** 应用运行并写入配置或用量数据，随后重启应用
- **THEN** 数据仍然存在且面板显示正确

#### Scenario: 包内不含需重编译的原生模块

- **WHEN** 检查安装包内的网关依赖
- **THEN** 不存在 better-sqlite3，且存储驱动正常初始化
