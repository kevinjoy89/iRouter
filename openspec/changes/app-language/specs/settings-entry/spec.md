# Spec Delta

## Purpose

定义桌面应用的设置入口：让 Windows、Linux 与 macOS 上的用户都能以一致且易达的方式打开设置，而不依赖仅存在于某一平台的入口形态。

## ADDED Requirements

### Requirement: 面板内提供设置入口

面板 SHALL 在主界面的固定位置提供一个设置入口，三平台一致，且不依赖托盘或原生菜单即可到达。

#### Scenario: 从面板直接打开设置

- **WHEN** 用户在主界面点击设置入口
- **THEN** 设置界面打开，无需经由托盘或系统菜单

#### Scenario: 三平台入口一致

- **WHEN** 分别在 macOS、Windows、Linux 上打开应用
- **THEN** 面板内的设置入口位置与行为一致

### Requirement: 浏览器形态同样可用

面板在系统浏览器中打开时，设置入口 SHALL 同样可用；仅在需要桌面壳层能力的功能上 SHALL 有所区别。

#### Scenario: 浏览器中的设置入口

- **WHEN** 用户在系统浏览器中打开面板并点击设置入口
- **THEN** 设置界面打开，仅与桌面壳层相关的功能项不呈现

### Requirement: 保留托盘设置入口

Windows 与 Linux 的托盘菜单 SHALL 保留设置入口，并 SHALL 将其置于菜单中的显著位置。

#### Scenario: 从托盘打开设置

- **WHEN** 用户在 Windows 或 Linux 上右键托盘图标
- **THEN** 菜单中的设置项位于第一项，点击后打开设置

### Requirement: 平台限制下的可达性

在托盘交互受限的平台上，设置 SHALL 仍可通过面板内入口到达，SHALL NOT 仅依赖托盘。

#### Scenario: Linux 托盘不产生鼠标事件

- **WHEN** 用户在 Linux 上单击托盘图标而平台不产生该事件
- **THEN** 用户仍可通过面板内的设置入口打开设置

### Requirement: 界面中不残留不可达的设置入口

面板中 SHALL NOT 存在无渲染点、用户无法到达的设置入口组件。

#### Scenario: 入口组件被重构移除

- **WHEN** 某设置入口组件的渲染点已被移除
- **THEN** 该组件被删除，而非留在代码中成为不可达的死代码
