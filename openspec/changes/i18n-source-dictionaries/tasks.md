## 1. 文案规范化

- [x] 1.1 Profile 页 Effort-aware Routing 描述去除中英夹杂，规范为纯英文源文
- [x] 1.2 Combos 页 Effort-aware 开关 title 由中文改英文；成员思考强度上限占位符 `effort?` → `effort`

## 2. 字典迁移与补全

- [x] 2.1 外挂转正：`desktop/resources/i18n/{zh-CN,zh-TW}.json` 各 650 条并入 `public/i18n/literals/{zh-CN,zh-TW}.json`，补丁值优先（zh-CN 覆盖 139 条、zh-TW 覆盖 38 条）；验证：python 合并脚本输出 + 抽查品牌条目（`9Router Proxy v0.5.69`、`~/.9router/db/data.sqlite`）
- [x] 2.2 新增 22 条新 UI 字符串翻译（Effort-aware / Retry Strategy 卡片全部 label 与描述，zh-CN + zh-TW）；验证：JSON 可解析，抽查 `Effort-aware Routing`/`Retry Strategy`/`Max Retries`/`Status Codes` 四条
- [x] 2.3 删除外挂：build-server 步骤 5（合并逻辑与未用导入）与 `desktop/resources/i18n/`；验证：grep 无残留引用，目录已删
- [x] 2.4 配额跟踪器补全（真机反馈）：usage 服务 49 条静态消息（Ollama/DeepSeek/Groq/Kiro/Zed 等 connected/未配置/鉴权失败提示）+ 连接编辑 UI 10 条（Test Connection/Account name/Azure 字段说明等）入字典 zh-CN + zh-TW；验证：条目数 zh-CN 1787 → 1846、zh-TW 806 → 865，Ollama Cloud 与 Test Connection 抽查命中
- [x] 2.5 title 属性翻译（真机反馈）：runtime.js 补 `processElementTitles`（幂等）+ observer 监听 title 属性变化；Effort-aware 开关与成员上限选择两条 title 文案入字典；验证：node --check 通过

## 3. 提交与打包

- [x] 3.1 外层仓库提交
- [ ] 3.2 重打 dmg（待办：build-server 根目录首跑 npm install 较慢；hdiutil 需提权）
