// 响应缓存（`.next/server/route-cache`）必须随构建身份失效。
//
// 这条守卫的直接来由是一次**用户实测的静默事故**：面板顶栏新增的设置齿轮「装了没生效」。
// 根因不在面板而在缓存：Next 16 的 route-cache 是持久化的，key 里不含 BUILD_ID，
// 条目一旦从种子提升就不再读新种子（详见 custom-server.js 的注释与 ADR 0009）。
// 覆盖安装不删它 → 旧 HTML 外壳被一直返回 → 它引用上一版已不存在的 chunk → 新界面元素消失，
// 且全程零报错。所以「缓存有没有被清」必须是可执行断言，而不是靠人记得。
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const { purgeStaleRouteCache } = require("../../custom-server.js");

// 造一个「网关负载目录」：只放这套判定真正读的东西（.next/BUILD_ID + route-cache 条目）。
const roots = [];
function makeGateway({ buildId, cacheEntries = ["APP_PAGE/deadbeef/$/dashboard.html"], stamp } = {}) {
  const root = mkdtempSync(join(tmpdir(), "irouter-rc-"));
  roots.push(root);
  mkdirSync(join(root, ".next"), { recursive: true });
  if (buildId !== undefined) writeFileSync(join(root, ".next", "BUILD_ID"), buildId);
  const cacheDir = join(root, ".next", "server", "route-cache");
  for (const rel of cacheEntries) {
    const p = join(cacheDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "<html>stale shell</html>");
  }
  if (stamp !== undefined) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, ".build-id"), stamp);
  }
  return root;
}
const entryPath = (root) =>
  join(root, ".next", "server", "route-cache", "APP_PAGE", "deadbeef", "$", "dashboard.html");
const stampPath = (root) => join(root, ".next", "server", "route-cache", ".build-id");

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("purgeStaleRouteCache", () => {
  // 核心场景：无戳记的存量缓存 + 新构建身份 = 用户遇到的那次事故。
  // 正是这条断言在修复前为红（旧实现只看 `.next/route-cache.build-id`，与缓存不同生共死）。
  it("无戳记的存量缓存遇到新构建身份 → 清掉并写下戳记", () => {
    const root = makeGateway({ buildId: "build-new" });
    expect(existsSync(entryPath(root))).toBe(true);

    const r = purgeStaleRouteCache(root);

    expect(r).toEqual({ purged: true, reason: "purged" });
    expect(existsSync(entryPath(root))).toBe(false);
    expect(readFileSync(stampPath(root), "utf8").trim()).toBe("build-new");
  });

  // 戳记与它描述的缓存写在同一个目录里，两者同生共死；这条钉住「同构建不重复清」，
  // 否则每次重启都丢缓存（功能仍对，但白白损失缓存收益）。
  it("同一构建身份重复调用 → 幂等，不再清缓存", () => {
    const root = makeGateway({ buildId: "build-A", stamp: "build-A" });
    const r1 = purgeStaleRouteCache(root);
    const r2 = purgeStaleRouteCache(root);
    expect(r1).toEqual({ purged: false, reason: "same-build" });
    expect(r2).toEqual({ purged: false, reason: "same-build" });
    expect(existsSync(entryPath(root))).toBe(true);
  });

  it("戳记是旧构建身份 → 清掉（覆盖安装的常态）", () => {
    const root = makeGateway({ buildId: "build-B", stamp: "build-A" });
    expect(purgeStaleRouteCache(root)).toEqual({ purged: true, reason: "purged" });
    expect(existsSync(entryPath(root))).toBe(false);
    expect(readFileSync(stampPath(root), "utf8").trim()).toBe("build-B");
  });

  // 整个 .next 被替换（干净安装）：没有缓存也没有戳记，建目录写戳记即可，不该报「清了」。
  it("干净安装（无缓存）→ 建目录写戳记，不谎报清理", () => {
    const root = makeGateway({ buildId: "build-C", cacheEntries: [] });
    expect(purgeStaleRouteCache(root)).toEqual({ purged: false, reason: "initialized" });
    expect(readFileSync(stampPath(root), "utf8").trim()).toBe("build-C");
  });

  // 目录只剩戳记（上一轮已清、条目尚未重建）时同样不该谎报。
  // 「目录存在就报清理」的写法会在这里说谎，而日志一旦不可信就失去指示性。
  it("目录只剩戳记 → 不谎报清理", () => {
    const root = makeGateway({ buildId: "build-F", cacheEntries: [], stamp: "build-E" });
    expect(purgeStaleRouteCache(root)).toEqual({ purged: false, reason: "initialized" });
    expect(readFileSync(stampPath(root), "utf8").trim()).toBe("build-F");
  });

  // 未构建的仓库 / 裸 next dev：没有构建身份可比，什么都不做（交给 Next 自己报错）。
  it("没有 BUILD_ID → 不动任何东西", () => {
    const root = makeGateway({});
    expect(purgeStaleRouteCache(root)).toEqual({ purged: false, reason: "no-build-id" });
    expect(existsSync(stampPath(root))).toBe(false);
  });

  it("BUILD_ID 为空 → 不误判为构建变化", () => {
    const root = makeGateway({ buildId: "   ", stamp: "build-A" });
    expect(purgeStaleRouteCache(root)).toEqual({ purged: false, reason: "empty-build-id" });
  });

  // Fail-open：清理失败绝不能让网关起不来（最坏只是界面回退到旧版）。
  it("清理失败不抛异常（fail-open）", () => {
    const root = makeGateway({ buildId: "build-D", stamp: "build-C" });
    const realRm = require("node:fs").rmSync;
    let r;
    try {
      // 让 rmSync 抛错，模拟权限/占用导致的删除失败
      require("node:fs").rmSync = () => {
        throw new Error("EBUSY: 文件被占用");
      };
      r = purgeStaleRouteCache(root);
    } finally {
      require("node:fs").rmSync = realRm;
    }
    expect(r.purged).toBe(false);
    expect(r.reason).toMatch(/^purge-failed:/);
  });

  // 目录整体被换掉时戳记随之消失，方向安全：宁可多清一次，不可漏清。
  it("戳记随缓存目录一起消失 → 视为需要重建", () => {
    const root = makeGateway({ buildId: "build-E" });
    purgeStaleRouteCache(root); // 建立戳记
    rmSync(join(root, ".next", "server", "route-cache"), { recursive: true, force: true });
    expect(purgeStaleRouteCache(root)).toEqual({ purged: false, reason: "initialized" });
    expect(existsSync(stampPath(root))).toBe(true);
  });
});

// 逻辑写对了但没接上，等于没修。这两条钉住「接线」本身。
describe("接线：入口真的会清、产物真的不带缓存", () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const entry = readFileSync(join(REPO, "custom-server.js"), "utf8");

  // 顺序也是断言的一部分：Next 一启动就读 route-cache，清理必须排在 require(standalone) 之前。
  //
  // ⚠️ 必须先剥掉注释再找：注释掉调用（`// purgeStaleRouteCache();`）时，子串依然在文件里，
  // 直接 indexOf 会让这条守卫**在真正断线时照样通过**——变异测试实测过这个假绿。
  it("custom-server.js 在 require(standalone) 之前调用清理", () => {
    const stripComments = (src) =>
      src
        .split("\n")
        .map((line) => {
          const t = line.trim();
          return t.startsWith("//") ? "" : line;
        })
        .join("\n");
    const mainBlock = stripComments(entry.slice(entry.indexOf("if (require.main === module)")));
    const purgeAt = mainBlock.search(/^\s*purgeStaleRouteCache\(\);/m);
    const requireAt = mainBlock.search(/^\s*require\(standalone\);/m);
    expect(purgeAt).toBeGreaterThan(-1);
    expect(requireAt).toBeGreaterThan(-1);
    expect(purgeAt).toBeLessThan(requireAt);
  });

  it("打包脚本剔除 route-cache 并留产物级守卫", () => {
    const build = readFileSync(join(REPO, "tools", "build-server.mjs"), "utf8");
    // 剔除：必须有 rmSync 作用在 route-cache 上
    expect(build).toMatch(/rmSync\(routeCacheOut/);
    // 守卫：清完之后还要再断言一次不存在（否则删漏了没人知道）
    expect(build).toMatch(/existsSync\(routeCacheOut\)/);
  });
});
