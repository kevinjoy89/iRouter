"use client";

// 安全设置：登录要求、密码、单点登录（OIDC / SAML）。
//
// 这几张卡原本在 /dashboard/profile 里，与提供商、路由、定价混在一页；但它们回答的
// 是「谁能进这个面板」，与「网关怎么路由」不是一回事，所以拆成与「网关设置」平级的
// 独立分段（用户要求）。
//
// 复用同一个页面组件 + groups 过滤，而不是把这些卡搬成新组件：那一页的状态
//（settings、密码、OIDC/SAML 表单…）是一整块，硬拆要搬三十来个 useState 与十几个
// handler。面板一次只挂载一个分段（renderSection 是 switch），因此不会出现两份状态。
import dynamic from "next/dynamic";
import { SectionBody, SectionHeader } from "./parts";

const SecuritySettingsPanel = dynamic(
  () =>
    import("@/app/(dashboard)/dashboard/profile/page").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <p className="py-8 text-center text-[12px] text-text-muted">
        Loading security settings...
      </p>
    ),
  },
);

/**
 * 安全设置段
 *
 * @return {JSX.Element} 登录、密码与单点登录
 * @author wei
 * @since 2026-09-30
 */
export default function SecuritySettings() {
  return (
    <>
      <SectionHeader
        title="Security"
        description="Who can open this dashboard: login requirement, password and single sign-on"
      />
      <SectionBody>
        <SecuritySettingsPanel
          groups={["security"]}
          showAppInfo={false}
        />
      </SectionBody>
    </>
  );
}
