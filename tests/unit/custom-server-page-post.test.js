// 页面路径上的 action 形态 POST（Next-Action 头 / multipart 体）必须在边缘层 404：
// 否则 Next 把它当 Server Action 处理，抛 "Failed to find Server Action" 或以
// "Error: ..." 形态写进网关控制台日志。
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const { isStrayActionPost, rewriteToAppPath, routeRegExp } = require("../../custom-server.js");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const req = (method, url, contentType) => ({
  method,
  url,
  headers: contentType ? { "content-type": contentType } : {},
});

describe("isStrayActionPost", () => {
  it("页面路径上的 multipart POST 拦截", () => {
    expect(isStrayActionPost(req("POST", "/login", "multipart/form-data; boundary=x"))).toBe(true);
    expect(isStrayActionPost(req("POST", "/dashboard/combo", "multipart/form-data"))).toBe(true);
    expect(isStrayActionPost(req("POST", "/login?next=/dashboard", "MULTIPART/FORM-DATA"))).toBe(true);
    // Next-Action 头（fetch action）：content-type 任意
    expect(isStrayActionPost({ method: "POST", url: "/dashboard/combo", headers: { "next-action": "abc", "content-type": "text/plain;charset=UTF-8" } })).toBe(true);
    expect(isStrayActionPost({ method: "POST", url: "/login", headers: { "next-action": "abc" } })).toBe(true);
  });

  it("/callback 的 action 形态 POST 同样拦截（OAuth 回跳是 GET，body 读不到）", () => {
    expect(isStrayActionPost(req("POST", "/callback?code=1", "multipart/form-data"))).toBe(true);
    expect(isStrayActionPost({ method: "POST", url: "/callback", headers: { "next-action": "abc" } })).toBe(true);
    // 表单式回跳（application/x-www-form-urlencoded）不受影响
    expect(isStrayActionPost(req("POST", "/callback?code=1", "application/x-www-form-urlencoded"))).toBe(false);
  });

  it("API / 网关 / 静态资源放行", () => {
    expect(isStrayActionPost(req("POST", "/api/v1/chat/completions", "multipart/form-data"))).toBe(false);
    expect(isStrayActionPost(req("POST", "/v1/chat/completions", "multipart/form-data"))).toBe(false);
    expect(isStrayActionPost(req("POST", "/v1beta/models", "multipart/form-data"))).toBe(false);
    expect(isStrayActionPost(req("POST", "/_next/static/chunk.js", "multipart/form-data"))).toBe(false);
    expect(isStrayActionPost({ method: "POST", url: "/api/auth/login", headers: { "next-action": "abc" } })).toBe(false);
  });

  it("非 multipart 或非 POST 不受影响", () => {
    expect(isStrayActionPost(req("POST", "/login", "application/json"))).toBe(false);
    expect(isStrayActionPost(req("POST", "/login", "application/x-www-form-urlencoded"))).toBe(false);
    expect(isStrayActionPost(req("GET", "/login"))).toBe(false);
  });

  // 真机案例：DSH 的 DeepSeek Files API 上传是 multipart POST /v1/files，
  // 网关没有该路由 → app-page 运行时抛 "Failed to find Server Action"（每轮两条）。
  it("只放行真正有 route handler 的路径（/v1/files 这类未实现端点 404）", () => {
    const routes = new Set([
      "/api/v1/chat/completions",
      "/api/v1/audio/transcriptions",
      "/api/v1/responses",
      "/api/v1beta/models",
    ]);
    const match = (p) => routes.has(p);
    expect(isStrayActionPost(req("POST", "/v1/files", "multipart/form-data; boundary=x"), match)).toBe(true);
    expect(isStrayActionPost(req("POST", "/v1/audio/transcriptions", "multipart/form-data"), match)).toBe(false);
    expect(isStrayActionPost(req("POST", "/v1/nope", "multipart/form-data"), match)).toBe(true);
    expect(isStrayActionPost(req("POST", "/api/v1/chat/completions", "multipart/form-data"), match)).toBe(false);
    expect(isStrayActionPost(req("POST", "/responses", "multipart/form-data"), match)).toBe(false);
    expect(isStrayActionPost(req("POST", "/codex/x", "multipart/form-data"), match)).toBe(false);
    expect(isStrayActionPost(req("POST", "/v1/v1/chat/completions", "multipart/form-data"), match)).toBe(false);
    // 页面路径没有 route handler
    expect(isStrayActionPost(req("POST", "/login", "multipart/form-data"), match)).toBe(true);
  });
});

describe("rewriteToAppPath", () => {
  it("按 next.config.mjs 的 rewrite 归一（含 /v1/v1 双前缀与无捕获的 /codex/*）", () => {
    expect(rewriteToAppPath("/v1/files")).toBe("/api/v1/files");
    expect(rewriteToAppPath("/v1")).toBe("/api/v1");
    expect(rewriteToAppPath("/v1/v1/chat/completions")).toBe("/api/v1/chat/completions");
    expect(rewriteToAppPath("/v1beta/models")).toBe("/api/v1beta/models");
    expect(rewriteToAppPath("/codex/anything")).toBe("/api/v1/responses");
    expect(rewriteToAppPath("/responses")).toBe("/api/v1/responses");
    expect(rewriteToAppPath("/login")).toBe("/login");
  });
});

describe("routeRegExp", () => {
  it("静态 / 动态 / catch-all 段", () => {
    expect(routeRegExp("/api/v1/audio/transcriptions").test("/api/v1/audio/transcriptions")).toBe(true);
    expect(routeRegExp("/api/v1/audio/transcriptions").test("/api/v1/audio/transcription")).toBe(false);
    expect(routeRegExp("/api/providers/[id]").test("/api/providers/abc")).toBe(true);
    expect(routeRegExp("/api/providers/[id]").test("/api/providers/abc/extra")).toBe(false);
    expect(routeRegExp("/api/v1/models/[...model]").test("/api/v1/models/a/b/c")).toBe(true);
    expect(routeRegExp("/api/v1/models/[...model]").test("/api/v1/models")).toBe(false);
  });
});

// 用真清单再跑一遍（未构建时自动跳过）
const hasManifest = existsSync(path.join(REPO_ROOT, ".next", "app-path-routes-manifest.json"));
describe.runIf(hasManifest)("构建清单驱动的默认判定", () => {
  it("/v1/files 拦截，/v1/audio/transcriptions 与 /api 处理器放行", () => {
    expect(isStrayActionPost(req("POST", "/v1/files", "multipart/form-data; boundary=x"))).toBe(true);
    expect(isStrayActionPost(req("POST", "/v1/audio/transcriptions", "multipart/form-data; boundary=x"))).toBe(false);
    expect(isStrayActionPost(req("POST", "/api/auth/saml/acs", "multipart/form-data"))).toBe(false);
  });
});
