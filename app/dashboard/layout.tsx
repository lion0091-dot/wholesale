import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getOrgStaffContext } from "@/lib/auth/rbac";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { FALLBACK_DISPLAY_NAME, resolveDisplayName } from "@/lib/auth/display-name";
import { DashboardShell, type DashboardNavItem } from "./dashboard-shell";
import type { SubscriptionStatus } from "@/types/database";

export const metadata: Metadata = {
  title: "도매업체 통합관리시스템 | 미트 파트너스",
  description: "상품·맞춤 단가·발주·고객 관리를 위한 도매(공급사) 관리자 화면",
};

/**
 * 사이드바 메뉴.
 * ready=false 항목은 아직 화면이 없어 '준비중'으로 표시한다.
 */
const NAV_ITEMS: DashboardNavItem[] = [
  { label: "대시보드", href: "/dashboard", icon: "📊", ready: true },
  { label: "상품 관리", href: "/dashboard/products", icon: "🥩", ready: true },
  { label: "맞춤 단가 관리", href: "/dashboard/custom-prices", icon: "🏷️", ready: true },
  { label: "주문 관리", href: "/dashboard/orders", icon: "🧾", ready: true },
  { label: "판매 통계", href: "/dashboard/stats", icon: "📈", ready: true },
  { label: "고객 관리", href: "/dashboard/customers", icon: "👥", ready: true },
  { label: "미수금 정산", href: "/dashboard/receivables", icon: "💰", ready: true },
  { label: "영업 · 초대장", href: "/dashboard/invites", icon: "💬", ready: true },
  { label: "팀원 관리", href: "/dashboard/team", icon: "🧑‍🤝‍🧑", ready: true },
];

const ORG_ROLE_LABELS: Record<string, string> = {
  owner: "대표 (Owner)",
  manager: "관리자 (Manager)",
  staff: "직원 (Staff)",
};

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const context = await getOrgStaffContext();

  let organizationName = "마장동 태양축산 (테스트 도매)";
  let roleLabel = "데모 열람 모드";
  let displayName = FALLBACK_DISPLAY_NAME;
  // 슈퍼관리자(조직 미소속 감독 열람)나 아직 업체 레코드가 없는 계정은 null —
  // 배지 자체를 숨긴다(관리자 전용 화면과 달리 여기선 "해당 없음"을 굳이 안 보여줌).
  let subscriptionStatus: SubscriptionStatus | null = null;

  if (context) {
    roleLabel = context.isSuperAdmin
      ? "플랫폼 최고 관리자"
      : ORG_ROLE_LABELS[context.orgRole ?? ""] ?? "조직 미소속";

    const supabase = await createClient();

    // 표시 이름: profiles.name → 카카오 닉네임(user_metadata) → "사용자".
    // 이메일 없는 카카오 계정도 정상 로그인이므로 이메일은 판단에 쓰지 않는다.
    const [{ data: profile }, { data: auth }] = await Promise.all([
      supabase.from("profiles").select("name").eq("id", context.userId).maybeSingle(),
      supabase.auth.getUser(),
    ]);

    displayName = resolveDisplayName(
      profile?.name as string | null | undefined,
      auth.user?.user_metadata
    );

    if (context.organizationId) {
      const { data: organization } = await supabase
        .from("organizations")
        .select("name, wholesalers ( subscription_status )")
        .eq("id", context.organizationId)
        .maybeSingle();

      if (organization?.name) {
        organizationName = organization.name;
      }

      const wholesaler = Array.isArray(organization?.wholesalers)
        ? organization.wholesalers[0]
        : organization?.wholesalers;

      subscriptionStatus = (wholesaler?.subscription_status as SubscriptionStatus | undefined) ?? null;
    } else {
      // 조직 생성 전 단계 — Phase 1의 wholesalers 업체명을 사용한다.
      const { data: wholesaler } = await supabase
        .from("wholesalers")
        .select("business_name, subscription_status")
        .eq("profile_id", context.userId)
        .maybeSingle();

      organizationName = wholesaler?.business_name ?? "도매업체 통합관리시스템";
      subscriptionStatus = (wholesaler?.subscription_status as SubscriptionStatus | undefined) ?? null;
    }
  }

  return (
    <DashboardShell
      navItems={NAV_ITEMS}
      organizationName={organizationName}
      displayName={displayName}
      roleLabel={roleLabel}
      subscriptionStatus={subscriptionStatus}
      isDemoMode={!context || !isSupabaseConfigured()}
    >
      {children}
    </DashboardShell>
  );
}
