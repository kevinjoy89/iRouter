# Spec Delta

## Purpose

定义安装向导的语言：安装包内置的语言列表，以及向导语言如何按系统语言确定，使用户在中文系统上安装时看到中文向导。

## ADDED Requirements

### Requirement: 安装向导语言跟随系统

Windows 安装向导 SHALL 按操作系统语言自动选择向导语言，SHALL NOT 固定为英文。

#### Scenario: 中文系统上的安装向导

- **WHEN** 用户在简体中文 Windows 上运行安装包
- **THEN** 安装向导以简体中文呈现

#### Scenario: 繁体中文系统上的安装向导

- **WHEN** 用户在繁体中文 Windows 上运行安装包
- **THEN** 安装向导以繁体中文呈现

### Requirement: 内置语言列表

安装包 SHALL 内置 `English`、`SimpChinese`、`TradChinese` 三种向导语言。当系统语言不在列表内时，向导 SHALL 回落到列表中的英文。

#### Scenario: 系统语言不在列表内

- **WHEN** 用户在日语 Windows 上运行安装包
- **THEN** 安装向导以英文呈现

### Requirement: 不插入语言选择对话框

安装向导 SHALL NOT 在开始前插入语言选择对话框；向导语言 SHALL 完全由系统语言决定。

#### Scenario: 安装过程无额外交互

- **WHEN** 用户运行安装包
- **THEN** 向导直接进入欢迎页，不出现语言选择步骤

### Requirement: 内置语言列表的一致性

安装包内置的语言列表 SHALL 由自动化断言守护，配置值与实际构建出的向导语言集合 SHALL 一致。

#### Scenario: 配置被改回默认

- **WHEN** 有人把向导语言配置改回仅英文
- **THEN** 自动化断言失败，阻止中文向导能力被静默移除
