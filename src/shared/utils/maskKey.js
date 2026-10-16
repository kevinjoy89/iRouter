/**
 * 敏感密钥脱敏工具函数集合
 *
 * @author iRouter
 * @since 2026-10-16
 */

/**
 * 对敏感 API Key 进行脱敏，保留前后各 5 位字符，中间使用掩码
 *
 * @param {string|null|undefined} key 原始待脱敏密钥
 * @return {string} 脱敏后的指纹字符串，若入参为空则返回空字符串
 */
export function maskApiKey(key) {
  if (!key || typeof key !== "string") {
    return "";
  }
  const trimmed = key.trim();
  if (trimmed.length < 10) {
    return "******";
  }
  const prefix = trimmed.slice(0, 5);
  const suffix = trimmed.slice(-5);
  return `${prefix}****${suffix}`;
}
