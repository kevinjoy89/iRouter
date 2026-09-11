// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

// Credentials mẫu cố định (deterministic) — KHÔNG dùng Date.now/random.
const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "sk-test-APIKEY",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Provider cần executor riêng (buildUrl/buildHeaders không nằm ở DefaultExecutor) → bỏ qua ở golden này.
// Chúng được lock riêng ở 11-provider edge tests / unit test chuyên biệt.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
]);

// Sanitize header: khử token + field động (kimi X-Msh-Device-Id, phiên bản app).
// Phiên bản app là giá trị động: nó đổi theo mỗi lần sync upstream (package.json bump),
// nên phải khử đích danh 3 header mang nó — nếu không, mỗi lần sync lại vỡ snapshot
// cline/clinepass/kimi mà không phản ánh lỗi thật nào.
// Lưu ý: KHÔNG khử mọi header khớp /version/i — anthropic-version, X-Stainless-Package-Version
// là giá trị hợp đồng API thật, phải được lock nguyên trạng.
const APP_VERSION_HEADERS = new Set(["x-client-version", "x-core-version", "x-msh-version"]);

function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    let s = v
      .replace(/Bearer .+/, "Bearer <TOK>")
      .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
      .replace(/kimi-\d{10,}/g, "kimi-<TS>");
    // Chỉ 3 header mang phiên bản app (giá trị = package.json version) → <VER>
    if (APP_VERSION_HEADERS.has(k.toLowerCase())) s = "<VER>";
    // User-Agent dạng "9Router/<ver>" — giữ tên app, khử phần version
    s = s.replace(/^(9Router)\/[\d.]+$/i, "$1/<VER>");
    out[k] = s;
  }
  return out;
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}
