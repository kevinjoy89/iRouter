"use client";

// 网关设置：把 dashboard 的 /dashboard/profile 整页**原生嵌入**面板。
//
// 为什么能直接嵌：那一页本身就是 `max-w-2xl`（672px）的竖排卡片列，与面板右栏
// 的可用宽度（896 - 196 导航 - 48 内边距 ≈ 652px）基本吻合，不需要改它的布局。
//
// 为什么不用 iframe：iframe 会把 dashboard 的侧栏与头部一起装进来（那是路由级
// layout），面板里就会出现第二套导航；而且嵌套文档各自一份滚动与 i18n 观察器，
// 主题/语言的联动要重新做一遍。原生嵌入没有这些问题。
//
// 为什么动态 import：面板挂在 root layout 上，静态 import 会把这 1567 行的页面
// 连同它的 PricingModal 打进**每个路由**（含登录页）的首屏 chunk；改成按需加载后，
// 只有真的切到这一段才下载对应 chunk。
import dynamic from "next/dynamic";
import { SectionBody, SectionHeader } from "./parts";

const GatewaySettingsPanel = dynamic(
  () => import("@/app/(dashboard)/dashboard/profile/page"),
  {
    ssr: false,
    loading: () => (
      <p className="py-8 text-center text-[12px] text-text-muted">
        Loading gateway settings...
      </p>
    ),
  },
);

/**
 * 网关设置段（嵌入的 dashboard 配置页）
 *
 * @return {JSX.Element} 嵌入页
 * @author wei
 * @since 2026-09-30
 */
export default function GatewaySettingsSection() {
  return (
    <>
      <SectionHeader
        title="Gateway Settings"
        description="Providers, routing, security and the rest of the gateway options, embedded from the dashboard"
      />
      <SectionBody>
        {/* groups：安全/单点登录已拆到平级的「安全设置」分段，这里只渲染其余三组；
            showAppInfo=false：页尾那两行（应用名+版本 / 本地或远程模式）由面板页脚承担 */}
        <GatewaySettingsPanel
          groups={["routing", "retry", "redaction", "pricing"]}
          showAppInfo={false}
        />
      </SectionBody>
    </>
  );
}
