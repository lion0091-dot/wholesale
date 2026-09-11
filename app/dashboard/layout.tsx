import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getOrgStaffContext } from "@/lib/auth/rbac";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { DashboardShell, type DashboardNavItem } from "./dashboard-shell";

export const metadata: Metadata = {
  title: "공급사 백오피스 | B2B 육류 도매 발주 시스템",
  description: "상품·맞춤 단가·발주·고객 관리를 위한 도매(공급사) 관리자 화면",
};

/**
 * 사이드바 메뉴.
 * ready=false 항목은 아직 화면이 없어 '준비중'으로 표시한다.
 * 주문 관리는 기존 Phase 1~4 화면(/wholesaler/orders)으로 연결하며, 이후 /dashboard 하위로 이관한다.
 */
const NAV_ITEMS: DashboardNavItem[] = [
  { label: "대시보드", href: "/dashboard", icon: "📊", ready: true },
  { label: "상품 관리", href: "/dashboard/products", icon: "🥩", ready: true },
  { label: "맞춤 단가 관리", href: "/dashboard/custom-prices", icon: "🏷️", ready: true },
  { label: "주문 관리", href: "/wholesaler/orders", icon: "🧾", ready: true },
  { label: "고객 관리", href: "/dashboard/customers", icon: "👥", ready: false },
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

  if (context) {
    roleLabel = context.isSuperAdmin
      ? "플랫폼 최고 관리자"
      : ORG_ROLE_LABELS[context.orgRole ?? ""] ?? "조직 미소속";

    const supabase = await createClient();

    if (context.organizationId) {
      const { data: organization } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", context.organizationId)
        .maybeSingle();

      if (organization?.name) {
        organizationName = organization.name;
      }
    } else {
      // 조직 생성 전 단계 — Phase 1의 wholesalers 업체명을 사용한다.
      const { data: wholesaler } = await supabase
        .from("wholesalers")
        .select("business_name")
        .eq("profile_id", context.userId)
        .maybeSingle();

      organizationName = wholesaler?.business_name ?? "공급사 백오피스";
    }
  }

  return (
    <DashboardShell
      navItems={NAV_ITEMS}
      organizationName={organizationName}
      userEmail={context?.email ?? null}
      roleLabel={roleLabel}
      isDemoMode={!context || !isSupabaseConfigured()}
    >
      {children}
    </DashboardShell>
  );
}
