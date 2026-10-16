// 受支持的语言集合。收窄到三种是刻意的：面板此前声明 34 种而实际只有 6 份字典，
// 其余 28 种选中后 fetch 404 被吞掉、静默回落全英文——那是缺陷不是特性。
// 集合与 `public/i18n/literals/` 下实有的字典必须一致，由
// `tests/unit/i18n-locale-set.test.js` 断言守护（见 ADR 0008）。
export const LOCALES = ["en", "zh-CN", "zh-TW"];
export const DEFAULT_LOCALE = "en";
export const LOCALE_COOKIE = "locale";

export const LOCALE_NAMES = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

/**
 * 把任意语言标记归一化到受支持集合里的一个值。
 *
 * **不受支持的语言返回空串，表示「未选择」**——不是「显式选择了英文」。
 * 这个区分是优先级链（显式选择 > 系统语言 > 英文）的前提：只有受支持的语言
 * 才算一次选择，否则 `LOCALES` 与归一化会长期各说各话（见 ADR 0008）。
 *
 * `zh` 前缀的判定规则与壳层 `i18n.rs` 的 `normalize` 一致（含 tw/hk/hant 判繁体），
 * 两边必须给出同一结果，否则同一台机器上菜单与面板会显示不同语言。
 *
 * @param {string} locale 语言标记（cookie 值、navigator.language、壳层注入值）
 * @return {string} `en` / `zh-CN` / `zh-TW`，或空串（未选择/不受支持）
 */
export function normalizeLocale(locale) {
  if (typeof locale !== "string") return "";
  const s = locale.trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("zh")) {
    if (s.includes("tw") || s.includes("hk") || s.includes("hant")) return "zh-TW";
    return "zh-CN";
  }
  if (s === "en" || s.startsWith("en-")) return "en";
  return "";
}

export function isSupportedLocale(locale) {
  return LOCALES.includes(locale);
}

/**
 * 读取当前语言偏好选项值
 *
 * 显式选择的权威是壳层设置文件的 locale 字段（有壳层时）；浏览器形态下退回 cookie
 * 空串、null 或不受支持的值表示「未选择/跟随系统」
 *
 * @param {object} [shell] 壳层设置对象
 * @return {string} 偏好标识（system / en / zh-CN / zh-TW）
 * @author wei
 * @since 2026-10-16
 */
export function readLocalePreference(shell) {
  const isDesktop =
    typeof window !== "undefined" && Boolean(window.irouterShell || shell);
  if (isDesktop) {
    if (!shell) return "system";
    return normalizeLocale(shell.locale) || "system";
  }
  if (typeof document === "undefined") return "system";
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  if (!cookie) return "system";
  const raw = decodeURIComponent(cookie.split("=")[1] || "").trim();
  return normalizeLocale(raw) || "system";
}

