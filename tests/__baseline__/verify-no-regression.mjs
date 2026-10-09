// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve, relative, isAbsolute } from "path";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

// known-fails.txt ghi path dạng "tests/unit/foo.test.js :: <tên test>".
// Trước đây gate hardcode split("/app/") — đúng với layout Docker của upstream
// (repo mount tại /app) nhưng sai ở mọi checkout khác: mọi tên file thành
// "undefined" nên TOÀN BỘ fail đều bị báo là regression. Suy path từ vị trí
// thật của repo thay vì giả định "/app/".
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 将测试文件绝对路径或任意环境路径转换为统一的相对路径键名
 *
 * @param {string} absPath 测试文件路径
 * @return {string} 标准化后的相对路径，以 tests/ 开头
 */
function toRelKey(absPath) {
  const normalized = absPath.split("\\").join("/");
  const testIdx = normalized.indexOf("tests/");
  if (testIdx !== -1) {
    return normalized.slice(testIdx);
  }
  const rel = relative(REPO_ROOT, absPath);
  return (isAbsolute(rel) ? absPath : rel).split("\\").join("/");
}

// ⚠️ 文件级「加载/收集期失败」过去**完全不可见**。
//
// 只看 `assertionResults` 的话，整文件在收集期就炸掉时那个数组是空的 —— 于是它既不算 pass
// 也不算 fail，**门禁全绿而它是红的**。2026-10-08 实测踩到：Phase 6 Step 1 漏改两条
// `require("./asset")`，JS 参照实现在收集期即炸，CI 全绿，Lead 以为搬迁完成了。
//
// 但**不能把所有空 assertionResults 都当失败**：本仓库有 6 个用 `node:test` 写的文件
// （`import { describe, it } from "node:test"`），vitest 收集不到它们，报
// "No test suite found in file ..." —— 那是"这个文件本来就不是给 vitest 跑的"，不是"它坏了"。
// 所以按 vitest 的具体信息区分（而不是靠启发式猜）：
//   "No test suite found in file ..." → 非 vitest 文件，不计入本门禁
//   其它任何信息                      → 真·加载失败，按**文件级失败**计入（如 Cannot find module）
const NOT_A_VITEST_FILE = "No test suite found in file ";
const COLLECTION_FAIL_KEY = "(file-level: 加载/收集期失败)";

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const nowFails = r.testResults.flatMap(f => {
  const asserts = f.assertionResults || [];
  if (asserts.length > 0) {
    return asserts.filter(a => a.status === "failed")
      .map(a => toRelKey(f.name) + " :: " + a.fullName);
  }
  const msg = String(f.message || "");
  if (msg.includes(NOT_A_VITEST_FILE)) return []; // node:test 文件，非本门禁范围
  return [toRelKey(f.name) + " :: " + COLLECTION_FAIL_KEY];
});

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
