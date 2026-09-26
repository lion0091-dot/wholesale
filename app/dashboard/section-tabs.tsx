import { PillTabs } from "./pill-tabs";

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
  { label: "입출고 내역", href: "/dashboard/stock-ledger" },
  { label: "매입 정산", href: "/dashboard/purchases" },
] as const;

// 입고는 현장(입고 스캔)과 사무실(전표입력) 두 화면이다. 입고 스캔은 하위 경로(전표입력·대조 화면)까지
// 잡지 않도록 exact, 전표입력은 명세서 대조 화면(/documents/<id>)에서도 활성이다. 폰에는 전표입력 탭이 없다.
const INBOUND_TABS = [
  { label: "입고 스캔", href: "/dashboard/inbound", exact: true },
  {
    label: "전표입력",
    href: "/dashboard/inbound/statements",
    alsoActiveFor: ["/dashboard/inbound/documents"],
    desktopOnly: true,
  },
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

export function StockTabs() {
  return <PillTabs tabs={STOCK_TABS} ariaLabel="재고·매입 화면" />;
}

export function InboundTabs() {
  return <PillTabs tabs={INBOUND_TABS} ariaLabel="입고 화면 종류" />;
}
