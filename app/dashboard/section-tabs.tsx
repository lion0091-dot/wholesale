import { PillTabs } from "./pill-tabs";
import { FEATURE_KEYS, getMyUsableFeatures } from "@/lib/features/my-features";
import { getOrgStaffContext } from "@/lib/auth/rbac";

/**
 * 사이드바 메뉴 하나로 묶인 화면들의 공통 탭(2026-09-25 메뉴 통합).
 * 각 화면은 예전 주소를 그대로 쓰고, 이 탭만 위에 붙는다. 사이드바에서 어느 탭에서든
 * 묶음 메뉴가 활성으로 보이게 하는 설정은 app/dashboard/layout.tsx의 alsoActiveFor.
 */

const DASHBOARD_TABS = [
  { label: "개요", href: "/dashboard", exact: true },
  { label: "판매 통계", href: "/dashboard/stats" },
] as const;

const CUSTOMER_TABS = [
  { label: "고객 관리", href: "/dashboard/customers" },
  { label: "맞춤 단가", href: "/dashboard/custom-prices" },
  { label: "미수금 정산", href: "/dashboard/receivables" },
] as const;

const PRODUCT_TABS = [
  { label: "상품 관리", href: "/dashboard/products" },
  { label: "공공 시세", href: "/dashboard/market-prices" },
] as const;

const STOCK_TABS = [
  { label: "재고 보기", href: "/dashboard/stock-boxes" },
  { label: "입출고 내역", href: "/dashboard/stock-ledger" },
  { label: "소비기한", href: "/dashboard/stock-expiring" },
  { label: "매입 정산", href: "/dashboard/purchases" },
  { label: "발주 추천", href: "/dashboard/reorder-suggestions" },
] as const;

// 입고는 현장이 쓰는 입고 스캔 화면 하나다. 보류함(발주서에 없거나 초과로 받은 박스)은 사무실 전용.
const INBOUND_TABS = [
  { label: "입고 스캔", href: "/dashboard/inbound", exact: true },
  { label: "보류함", href: "/dashboard/inbound/holds", desktopOnly: true },
  { label: "쪼개기", href: "/dashboard/inbound/split" },
  { label: "명세서 보관", href: "/dashboard/inbound/statements", desktopOnly: true },
] as const;

export function DashboardTabs() {
  return <PillTabs tabs={DASHBOARD_TABS} ariaLabel="대시보드 종류" />;
}

export function CustomerTabs() {
  return <PillTabs tabs={CUSTOMER_TABS} ariaLabel="고객 관련 화면" />;
}

export function ProductTabs() {
  return <PillTabs tabs={PRODUCT_TABS} ariaLabel="상품 관련 화면" />;
}

// "원가 관리" 탭은 이 업체에서 기능이 켜져 있고, 대표이거나 대표가 허용한 사람에게만 보인다(마이그레이션 210).
// "장부 불일치"(전산 숫자가 입출고 기록과 다른 항목 보정, 마이그레이션 215)는 대표에게만 보인다. 창고 실물과 비교하는 화면이 아니다.
export async function StockTabs() {
  const [features, context] = await Promise.all([getMyUsableFeatures(), getOrgStaffContext()]);
  const tabs = [
    ...STOCK_TABS,
    ...(features.has(FEATURE_KEYS.costManagement) ? [{ label: "원가 관리", href: "/dashboard/stock-valuation" }] : []),
    ...(context?.orgRole === "owner" ? [{ label: "장부 불일치", href: "/dashboard/stock-integrity" }] : []),
  ];

  return <PillTabs tabs={tabs} ariaLabel="재고·매입 화면" />;
}

export function InboundTabs() {
  return <PillTabs tabs={INBOUND_TABS} ariaLabel="입고 화면 종류" />;
}
