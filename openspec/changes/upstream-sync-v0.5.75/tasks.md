## 1. 同步准备

- [x] 1.1 建 `sync/v0.5.75` 分支：`git checkout -b sync/v0.5.75 main`；验证：`git log --oneline -1` 指向 `63063e7f`
- [x] 1.2 merge upstream HEAD `17c4cc76`（本地已 fetch，tag `v0.5.75` = `83af3f18`）；验证：`git merge --no-commit --no-ff 17c4cc76` 的冲突文件列表**恰好**为 `.gitignore` 一个；若出现其他冲突文件，停下核对（预跑实测无其他冲突）
- [x] 1.3 解 `.gitignore` 冲突：保留我们的中文分节块（`node_modules/`、`.next/`、`out/`、`desktop/build/`、`.pi/`、`*.log`、`*.dmg`、`*.AppImage`、`*.exe`、`.tmp-ocr/`）**并入**上游 `9router-*`，删冲突标记；验证：`grep -c '<<<<<<<\|>>>>>>>' .gitignore` 为 0，且 `git check-ignore -v desktop/build/gateway/server/x.js` 命中
- [x] 1.4 核对三个双改文件双方改动共存（预跑已确认，此处回归确认）：
  - `open-sse/handlers/chatCore.js`：`grep -c effortCap` = 3 且 `grep -c shouldDefaultClaudeToolType` ≥ 2
  - `src/app/(dashboard)/dashboard/providers/[id]/page.js`：`grep -c bg-surface-2` = 2 且 `grep -c handleImportClineModels` = 2
  - `src/lib/db/driver.js`：`grep -c 'nodeMajor >= 24'` = 1 且 `grep -c MODULE_NOT_FOUND` = 1
- [x] 1.5 确认未误摘上游 revert 提交：`git log --oneline -1 248d7da0` 存在但**不在**本次 merge 的独立变更清单里；验证：`git diff v0.5.69 17c4cc76 --stat -- open-sse/translator/response/openai-to-claude.js open-sse/utils/stream.js` 为净零
- [x] 1.6 commit merge（保留 merge commit 血缘，便于下次同步）；验证：`git log --oneline --graph -3` 显示两父提交

## 2. 版本号口径

- [x] 2.1 `src/shared/constants/config.js`：`version: "0.0.9"` → `version: process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0"`；同步更新文件顶部注释（当前写"上游基线见 docs/adr/0003，当前基于 v0.5.69"）；验证：`grep -n NEXT_PUBLIC_APP_VERSION src/shared/constants/config.js` 命中，且该文件不再硬编码 `0.0.9`
- [x] 2.2 `desktop/scripts/build-server.mjs`：读 `desktop/package.json` 的 `version`，在调用 `npm run build` 时以 `NEXT_PUBLIC_APP_VERSION` 注入（并入既有 `env: { JWT_SECRET, DATA_DIR }` 对象）；验证：run 时日志打印注入的版本号
- [x] 2.3 `desktop/package.json`：`version` `0.0.9` → `0.1.0`，`description` 基线描述 `v0.5.69` → `v0.5.75`；验证：`node -e "console.log(require('./desktop/package.json').version)"` 输出 `0.1.0`
- [x] 2.4 根 `package.json` 与 `cli/package.json` 保持 merge 带入的 `0.5.75`（上游基线号）；验证：两个文件 `"version"` 均为 `0.5.75`，且**不**改成 `0.1.0`（改则 UA/`X-Msh-Version` 偏离上游）
- [x] 2.5 全仓搜残留的可见 `0.0.9`：验证：`grep -rn "0\.0\.9" src/ desktop/*.js desktop/package.json src/shared/constants/config.js` 无输出（`desktop/build/` 产物与 `node_modules/` 排除在外）

## 3. i18n 补键

- [x] 3.1 `public/i18n/literals/zh-CN.json` 补 4 键：`Import from /models`、`Error fetching models`、`Please add an active Cline connection first`、`models`（措辞与既有键风格一致，如 `添加成功` / `获取模型失败`）
- [x] 3.2 `public/i18n/literals/zh-TW.json` 补 5 键：上述 4 键 + `Fetching...`（zh-TW 已有 `获取中...` 的简中写法缺失，按繁体措辞补齐）
- [x] 3.3 验证：脚本核对 merge 带入的 9 个 `translate()` 键在 zh-CN 与 zh-TW 中均存在；`node -e "JSON.parse(require('fs').readFileSync('public/i18n/literals/zh-CN.json'))"` 与 zh-TW 同样通过（JSON 合法）
- [x] 3.4 确认 32 个非中文语言未改动；验证：`git diff --name-only` 的 literals 路径仅含 zh-CN.json 与 zh-TW.json

## 4. 测试与验收

- [x] 4.1 回归门禁：`cd tests && npx vitest run --reporter=json --outputFile=__baseline__/current.json` 后 `node tests/__baseline__/verify-no-regression.mjs tests/__baseline__/current.json` 输出 ✅；验证：命令退出码 0。**执行中的发现**：①门禁脚本原本用 `split("/app/")` 推导文件名（上游 Docker layout 假设），在本仓库下所有名字都变成 `undefined`，于是把每一个失败都报成回归——已改为从脚本自身位置推导仓库根；②`known-fails.txt` 原与上游 v0.5.69 逐字节相同（24 条），但本仓库真实基线是 105 条，原文件在本仓库从未成立——已按 merge 前实测重新生成。**已证明 merge 前 105 失败 == merge 后 105 失败（集合逐条相等）**，故新基线不含本次 merge 噪声
- [x] 4.2 上游新增测试全绿：video-providers 13/13、claude-cache-budget-single-object 13/13、qoder-context-tier 20/20、antigravity-weekly-quota 23/23、cline-free-models-envelope 14/14、deepseek-claude-tools 8/8、codex-tool-normalization 7/7、bugs-3905-deepseek-tool-type 3/3、antigravity-weekly-dashboard 6/6、api-airforce-free-models 5/5、kiro-minimal-wire-payload 2/2。**两处例外**（均非缺陷）：`db-sqlite-vs-lowdb` 的 `requestDetails save → query with paging` 1 例在 merge 前即失败（上游既有红）；`cline-auth.test.js` 用 `node:test` 语法，vitest 无法收集（`No test suite found`），与既有的 `kimchi*.test.js`、`tests/auth/saml.test.js` 同一情况——用 `node --test tests/unit/cline-auth.test.js` 验证为 4/4 通过
- [x] 4.3 本地定制回归：全套 2501 例；merge 后出现的 5 处 pass→fail 已逐一归因并修复（见 e373cb1c）：3 处为 golden 快照硬编码 app 版本串（已改为按 header 名精确脱敏，且刻意不脱敏 `anthropic-version`/`X-Stainless-*-Version` 等真实契约值）、1 处为上游 Node≥24 守卫使我们的告警分支不可达（测试改为按版本断言 + 新增守卫用例）、1 处为上游漏改自己的 kiro 期望值（`q.*` 已改为所有 auth 方法下优先）
- [x] 4.4 基线快照：`verify-providers`（81 providers 逐字节相等）、`verify-alias`（117 tokens）、`verify-oauth-urls` 三个脚本全过。无需手工重跑 `snapshot-providers.mjs`——上游在改动的同一提交里同步更新了 `tests/__baseline__/providers-baseline.json`（如 `a7047a07` 随 cliVersion 一起改），merge 已带入自洽版本
- [x] 4.5 构建：`npm run build` 退出码 0；`.next/standalone/custom-server.js` 由 postbuild 复制完成
- [x] 4.6 桌面打包与冒烟：`npm run dist:mac` 产出 `build/dist/iRouter-0.1.0.dmg`（版本注入生效），`npm run smoke:packaged` **PASS**，其中「品牌名iRouter Proxy=true」「版本号v0.1.0=true」
- [x] 4.7 会话 cookie（隔离端到端验证，`scripts/verify-sync-v0.5.75.mjs`）：登录 Set-Cookie 带 `max-age=86400`；登出后 `auth_token=; Expires=Thu, 01 Jan 1970`。未触碰用户正在运行的实例与真实数据库
- [x] 4.8 配额与定价隔离：定价接口 `/api/pricing` 不含 `gemini_weekly`/`claude_gpt_weekly`；静态核对确认定价数据源为 `pricingRepo`（KV + `open-sse/providers/pricing.js`），与 `quotas` 无交集，故新增周窗口键不可能进入计费模型行。新键在 `parseQuotaData` 中由 `weeklyKeys` 分支单独处理并按周窗口行渲染
- [x] 4.9 `/v1/messages` 主路径（同一隔离脚本）：mock 上游实收 4 条消息 `["system","user","assistant","user"]`，其中含裸对象 content 的那一轮在场（`hasPriorTurn=true`），证明 `claude-to-openai` 归一与 effort 钳制在真实链路共存；响应以 Claude 事件流回传 `"text":"MOCK_OK"`

## 5. 文档与收尾

- [x] 5.1 新增 `docs/adr/0004-version-number-decoupling.md`：只记录**版本号口径**（上游基线号 vs 产品号，`desktop/package.json` 为产品号唯一真源，构建期经 `NEXT_PUBLIC_APP_VERSION` 注入面板；被否决的"统一成单一版本号"与"config.js 回到 pkg.version"两个选项及其代价）。不记录本次同步本身——merge target 与集成机制可逆且属 ADR 0003 政策范围，写在 `design.md` 决策 1–2 即可，按 ADR 三门槛（难逆转 / 不知情会困惑 / 真实取舍）不单独立 ADR
- [x] 5.2 `CONTEXT.md`：更新"定制基线"词条（v0.5.69 → v0.5.75，并说明可见版本号 0.1.0 与基线号解耦）；新增"上游同步"术语（定义：把上游新区间 merge 进根目录源码、保留本地定制的动作；_Avoid_: 升级、更新版本）
- [x] 5.3 `CHANGELOG.md`：**决定不改**（原计划作废）。核查发现该文件在本仓库从未被本地提交修改过（`git log eb712ca8..HEAD -- CHANGELOG.md` 仅含 merge 带入的上游提交），当前与上游 HEAD 逐字节相同；在文件顶部插入本产品条目会永久破坏这一等价关系，从此每次上游同步都在此处冲突。版本号口径改由 `docs/adr/0004`（决策与理由）+ `CONTEXT.md` 的"产品版本号"词条 + 本变更目录三处记录——都在我们自有文件里，零同步成本。上游 v0.5.70–v0.5.75 条目已随 merge 自然带入
- [ ] 5.4 清理：确认无临时分支与 trial-merge 残留；验证：`git branch` 不含 `tmp*`，`git status` 干净
- [ ] 5.5 并入 `main` 并打 tag；验证：`git tag` 出现 `v0.1.0`（desktop 产品号），且 `git describe` 能追溯到上游 `v0.5.75`
