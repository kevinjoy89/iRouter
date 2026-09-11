## 1. 同步准备

- [ ] 1.1 建 `sync/v0.5.75` 分支：`git checkout -b sync/v0.5.75 main`；验证：`git log --oneline -1` 指向 `63063e7f`
- [ ] 1.2 merge upstream HEAD `17c4cc76`（本地已 fetch，tag `v0.5.75` = `83af3f18`）；验证：`git merge --no-commit --no-ff 17c4cc76` 的冲突文件列表**恰好**为 `.gitignore` 一个；若出现其他冲突文件，停下核对（预跑实测无其他冲突）
- [ ] 1.3 解 `.gitignore` 冲突：保留我们的中文分节块（`node_modules/`、`.next/`、`out/`、`desktop/build/`、`.pi/`、`*.log`、`*.dmg`、`*.AppImage`、`*.exe`、`.tmp-ocr/`）**并入**上游 `9router-*`，删冲突标记；验证：`grep -c '<<<<<<<\|>>>>>>>' .gitignore` 为 0，且 `git check-ignore -v desktop/build/gateway/server/x.js` 命中
- [ ] 1.4 核对三个双改文件双方改动共存（预跑已确认，此处回归确认）：
  - `open-sse/handlers/chatCore.js`：`grep -c effortCap` = 3 且 `grep -c shouldDefaultClaudeToolType` ≥ 2
  - `src/app/(dashboard)/dashboard/providers/[id]/page.js`：`grep -c bg-surface-2` = 2 且 `grep -c handleImportClineModels` = 2
  - `src/lib/db/driver.js`：`grep -c 'nodeMajor >= 24'` = 1 且 `grep -c MODULE_NOT_FOUND` = 1
- [ ] 1.5 确认未误摘上游 revert 提交：`git log --oneline -1 248d7da0` 存在但**不在**本次 merge 的独立变更清单里；验证：`git diff v0.5.69 17c4cc76 --stat -- open-sse/translator/response/openai-to-claude.js open-sse/utils/stream.js` 为净零
- [ ] 1.6 commit merge（保留 merge commit 血缘，便于下次同步）；验证：`git log --oneline --graph -3` 显示两父提交

## 2. 版本号口径

- [ ] 2.1 `src/shared/constants/config.js`：`version: "0.0.9"` → `version: process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0"`；同步更新文件顶部注释（当前写"上游基线见 docs/adr/0003，当前基于 v0.5.69"）；验证：`grep -n NEXT_PUBLIC_APP_VERSION src/shared/constants/config.js` 命中，且该文件不再硬编码 `0.0.9`
- [ ] 2.2 `desktop/scripts/build-server.mjs`：读 `desktop/package.json` 的 `version`，在调用 `npm run build` 时以 `NEXT_PUBLIC_APP_VERSION` 注入（并入既有 `env: { JWT_SECRET, DATA_DIR }` 对象）；验证：run 时日志打印注入的版本号
- [ ] 2.3 `desktop/package.json`：`version` `0.0.9` → `0.1.0`，`description` 基线描述 `v0.5.69` → `v0.5.75`；验证：`node -e "console.log(require('./desktop/package.json').version)"` 输出 `0.1.0`
- [ ] 2.4 根 `package.json` 与 `cli/package.json` 保持 merge 带入的 `0.5.75`（上游基线号）；验证：两个文件 `"version"` 均为 `0.5.75`，且**不**改成 `0.1.0`（改则 UA/`X-Msh-Version` 偏离上游）
- [ ] 2.5 全仓搜残留的可见 `0.0.9`：验证：`grep -rn "0\.0\.9" src/ desktop/*.js desktop/package.json src/shared/constants/config.js` 无输出（`desktop/build/` 产物与 `node_modules/` 排除在外）

## 3. i18n 补键

- [ ] 3.1 `public/i18n/literals/zh-CN.json` 补 4 键：`Import from /models`、`Error fetching models`、`Please add an active Cline connection first`、`models`（措辞与既有键风格一致，如 `添加成功` / `获取模型失败`）
- [ ] 3.2 `public/i18n/literals/zh-TW.json` 补 5 键：上述 4 键 + `Fetching...`（zh-TW 已有 `获取中...` 的简中写法缺失，按繁体措辞补齐）
- [ ] 3.3 验证：脚本核对 merge 带入的 9 个 `translate()` 键在 zh-CN 与 zh-TW 中均存在；`node -e "JSON.parse(require('fs').readFileSync('public/i18n/literals/zh-CN.json'))"` 与 zh-TW 同样通过（JSON 合法）
- [ ] 3.4 确认 32 个非中文语言未改动；验证：`git diff --name-only` 的 literals 路径仅含 zh-CN.json 与 zh-TW.json

## 4. 测试与验收

- [ ] 4.1 回归门禁：`cd tests && npx vitest run --reporter=json --outputFile=__baseline__/current.json` 后 `node tests/__baseline__/verify-no-regression.mjs tests/__baseline__/current.json` 输出 ✅（基准 `known-fails.txt` 与上游 v0.5.69 逐字节相同，共 24 条）；验证：命令退出码 0
- [ ] 4.2 上游新增测试全绿：`npx vitest run unit/video-providers.test.js unit/claude-cache-budget-single-object.test.js unit/qoder-context-tier.test.js unit/antigravity-weekly-quota.test.js unit/cline-free-models-envelope.test.js unit/deepseek-claude-tools.test.js unit/codex-tool-normalization.test.js unit/db-sqlite-vs-lowdb.test.js translator/bugs-3905-deepseek-tool-type.test.js`；验证：全绿
- [ ] 4.3 本地定制回归：`npx vitest run unit/auto-retry.test.js unit/effort-caps.test.js unit/combo-effort.test.js unit/effort-cap-wire.test.js unit/console-log-parser.test.js unit/console-log-virtual.test.js unit/i18n-runtime.test.js unit/usage-pricing-entry.test.js unit/undefined-bg-token.test.js unit/custom-server-page-post.test.js unit/db-driver-chain.test.js`；验证：全绿
- [ ] 4.4 基线重新快照（有意识 review，不得静默）：跑 `node tests/__baseline__/snapshot-providers.mjs`，review 差异应**仅**为 Codex `cliVersion`/UA 与新增 provider/模型条目；`verify-providers.mjs`、`verify-alias.mjs`、`verify-oauth-urls.mjs` 全过；验证：三个 verify 脚本退出码 0
- [ ] 4.5 构建：根目录 `npm run build` 通过；验证：`.next/standalone/custom-server.js` 存在
- [ ] 4.6 桌面打包与冒烟：`cd desktop && npm run dist:mac` 出 dmg 后 `npm run smoke:packaged`；验证：冒烟输出中「品牌名iRouter Proxy=True」与「版本号v0.1.0=True」（断言读的是 `app.getVersion()`，注入正确才成立）
- [ ] 4.7 实机验证风险点 A（会话 cookie）：登录面板 → 关闭并重开应用 → 会话仍有效（不被强制登出）；点退出登录 → cookie 清除、回到登录页
- [ ] 4.8 实机验证风险点 B（配额与定价）：打开用量页配额跟踪器，确认 `gemini_weekly` / `claude_gpt_weekly` 类周窗口行按配额渲染，且**未**出现在定价配置或 Est. Cost 的模型行里
- [ ] 4.9 实机验证风险点 C（`/v1/messages` 主路径）：以 `/v1/messages` 向自建 OpenAI 兼容节点发一次带工具的请求，确认成功（验证 `claude-to-openai.js` 裸对象归一与 effort 钳制在真实链路上共存）

## 5. 文档与收尾

- [ ] 5.1 新增 `docs/adr/0004-version-number-decoupling.md`：只记录**版本号口径**（上游基线号 vs 产品号，`desktop/package.json` 为产品号唯一真源，构建期经 `NEXT_PUBLIC_APP_VERSION` 注入面板；被否决的"统一成单一版本号"与"config.js 回到 pkg.version"两个选项及其代价）。不记录本次同步本身——merge target 与集成机制可逆且属 ADR 0003 政策范围，写在 `design.md` 决策 1–2 即可，按 ADR 三门槛（难逆转 / 不知情会困惑 / 真实取舍）不单独立 ADR
- [ ] 5.2 `CONTEXT.md`：更新"定制基线"词条（v0.5.69 → v0.5.75，并说明可见版本号 0.1.0 与基线号解耦）；新增"上游同步"术语（定义：把上游新区间 merge 进根目录源码、保留本地定制的动作；_Avoid_: 升级、更新版本）
- [ ] 5.3 `CHANGELOG.md`：merge 带入上游 v0.5.70–v0.5.75 条目；在本项目条目区补一条说明可见版本号口径变更（面板版本号自此由构建期注入，来源 `desktop/package.json`）
- [ ] 5.4 清理：确认无临时分支与 trial-merge 残留；验证：`git branch` 不含 `tmp*`，`git status` 干净
- [ ] 5.5 并入 `main` 并打 tag；验证：`git tag` 出现 `v0.1.0`（desktop 产品号），且 `git describe` 能追溯到上游 `v0.5.75`
