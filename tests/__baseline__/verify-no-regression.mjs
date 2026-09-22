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

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => toRelKey(f.name) + " :: " + a.fullName)
);

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
