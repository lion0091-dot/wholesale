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
 * 사이드바 메뉴 — 관련 있는 항목끼리 묶어서 순서를 정한다(2026-09-19,
 * components/admin-shell.tsx의 ADMIN_NAV_GROUPS와 같은 원칙). 예전에는 순서에
 * 의미가 없어서 미수금 정산이 고객 관리와 팀원 관리 사이 아무 데나 있었다.
 * ① 개요 ② 상품/가격(같이 봐야 하는 카탈로그 작업) ③ 거래·매출(주문이 만들어낸 결과)
 * ④ 거래처(고객 접점 전부) ⑤ 조직/청구(일 운영이 아니라 계정 관리).
 * ready=false 항목은 아직 화면이 없어 '준비중'으로 표시한다.
 */
const NAV_GROUPS: DashboardNavItem[][] = [
  [{ label: "대시보드", href: "/dashboard", icon: "📊", ready: true, alsoActiveFor: ["/dashboard/stats"] }],
  [
    { label: "입고 스캔", href: "/dashboard/inbound", icon: "📦", ready: true },
    { label: "출고 스캔", href: "/dashboard/outbound", icon: "🚚", ready: true },
    {
      label: "재고 · 매입 내역",
      href: "/dashboard/stock-ledger",
      icon: "🔄",
      ready: true,
      alsoActiveFor: ["/dashboard/purchases"],
    },
    {
      label: "상품 관리",
      href: "/dashboard/products",
      icon: "🥩",
      ready: true,
      alsoActiveFor: ["/dashboard/market-prices"],
    },
  ],
  [{ label: "발주 관리", href: "/dashboard/orders", icon: "🧾", ready: true }],
  [
    {
      label: "고객 관리",
      href: "/dashboard/customers",
      icon: "👥",
      ready: true,
      alsoActiveFor: ["/dashboard/custom-prices", "/dashboard/receivables"],
    },
  ],
  // 설정 — 초대장·업체 설정 / 팀원 / 구독료는 한 메뉴의 탭이다(app/dashboard/settings-tabs.tsx, 2026-09-25).
  [
    {
      label: "설정",
      href: "/dashboard/invites",
      icon: "⚙️",
      ready: true,
      alsoActiveFor: ["/dashboard/team", "/dashboard/billing"],
    },
  ],
  // 이력관리 — 각 화면에 흩어져 있던 "이력보기" 버튼을 전용 메뉴로 모았다(2026-09-21).
  // 상품/맞춤단가/발주 3종은 한 메뉴의 탭이다(app/dashboard/history/layout.tsx, 2026-09-25).
  // 대상 찾기(검색) 후 기존 AuditLogPanel을 그대로 재사용해 이력을 보여준다.
  [{ label: "이력 관리", href: "/dashboard/history", icon: "📜", ready: true }],
];

const ORG_ROLE_LABELS: Record<string, string> = {
  owner: "대표",
  manager: "관리자",
  staff: "직원",
};

/**
 * 모바일(900px 이하)용 축약 메뉴 — 전체 메뉴 방대함 문제 때문에 도입 (2026-09-23).
 * 현장에서 채널 메시지로 오는 입고·출고·발주를 바로 처리할 수 있는 항목만 남긴다.
 * 발주 상태변경/배송의뢰서/수금확인/재고확인은 기존 PC 화면이 필터·이력 등으로
 * 무거워서 그대로 못 쓰고, /dashboard/quick/* 에 가벼운 전용 화면을 따로 뒀다.
 */
const MOBILE_FIELD_NAV: DashboardNavItem[] = [
  { label: "입고 스캔", href: "/dashboard/inbound", icon: "📦", ready: true },
  { label: "출고 스캔", href: "/dashboard/outbound", icon: "🚚", ready: true },
  { label: "발주 처리", href: "/dashboard/quick/orders", icon: "🧾", ready: true },
  { label: "배송의뢰서", href: "/dashboard/quick/delivery-request", icon: "📄", ready: true },
  { label: "수금 확인", href: "/dashboard/quick/settle", icon: "💰", ready: true },
  { label: "재고 확인", href: "/dashboard/quick/stock", icon: "🥩", ready: true },
];

const MOBILE_DASHBOARD_ITEM: DashboardNavItem = {
  label: "대시보드",
  href: "/dashboard",
  icon: "📊",
  ready: true,
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

  // super_admin 감독 열람이나 owner/manager는 대시보드(개요)까지, staff는 현장 처리만.
  const isOwnerOrManager =
    Boolean(context?.isSuperAdmin) || context?.orgRole === "owner" || context?.orgRole === "manager";

  const mobileNavGroups: DashboardNavItem[][] = isOwnerOrManager
    ? [[MOBILE_DASHBOARD_ITEM], MOBILE_FIELD_NAV]
    : [MOBILE_FIELD_NAV];

  return (
    <DashboardShell
      navGroups={NAV_GROUPS}
      mobileNavGroups={mobileNavGroups}
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
