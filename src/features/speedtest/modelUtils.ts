/**
 * 测速模型标识与路由前缀纯工具模块
 *
 * @author iRouter
 * @since 2026-10-19
 */

/**
 * 剥离提供商路由前缀，获取上游真实模型标识
 *
 * @param model 选中的模型标识
 * @param prefix 连接前缀
 * @param providerId 提供商标识
 * @return 纯净的上游模型标识
 */
export function resolveUpstreamModel(
  model: string,
  prefix?: string,
  providerId?: string
): string {
  if (!model) return "";
  const clean = model.trim();
  if (prefix) {
    const p = prefix.trim().toLowerCase();
    if (clean.toLowerCase().startsWith(`${p}/`)) {
      return clean.slice(p.length + 1);
    }
  }
  if (providerId) {
    const pid = providerId.trim().toLowerCase();
    if (clean.toLowerCase().startsWith(`${pid}/`)) {
      return clean.slice(pid.length + 1);
    }
  }
  return clean;
}

/**
 * 构造带路由前缀的全局模型标识（用于界面统一展示和网关路由）
 *
 * @param model 选中的模型标识
 * @param prefix 连接前缀
 * @return 带前缀的全局模型标识
 */
export function resolveFullModel(model: string, prefix?: string): string {
  if (!model) return "";
  const clean = model.trim();
  if (!prefix) return clean;
  const p = prefix.trim().toLowerCase();
  if (clean.toLowerCase().startsWith(`${p}/`)) {
    return clean;
  }
  return `${p}/${clean}`;
}
