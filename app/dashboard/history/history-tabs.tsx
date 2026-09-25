import { PillTabs } from "../pill-tabs";

const TABS = [
  { label: "상품", href: "/dashboard/history/products" },
  { label: "맞춤단가", href: "/dashboard/history/custom-prices" },
  { label: "발주", href: "/dashboard/history/orders" },
] as const;

export function HistoryTabs() {
  return <PillTabs tabs={TABS} ariaLabel="이력 종류" />;
}
