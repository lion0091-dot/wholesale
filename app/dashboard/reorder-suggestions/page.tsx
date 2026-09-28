import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { StockTabs } from "../section-tabs";
import { ReorderSuggestionsView, type SuggestionRow } from "./reorder-suggestions-view";

export const metadata = {
  title: "발주 추천 | 도매업체 통합관리시스템",
};

/** 최근 며칠 판매 속도로 볼지 — 너무 짧으면 하루 튐에 흔들리고, 너무 길면 최근 변화를 못 따라간다. */
const LOOKBACK_DAYS = 14;
/** 이보다 여유 있는 상품은 급하지 않으니 목록에서 뺀다. */
const MAX_DAYS_LEFT = 30;

export default async function ReorderSuggestionsPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let rows: SuggestionRow[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const { data } = await supabase.rpc("get_reorder_suggestions", {
      p_wholesaler_id: scope.wholesalerId,
      p_lookback_days: LOOKBACK_DAYS,
      p_max_days_left: MAX_DAYS_LEFT,
    });

    rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      productId: String(row.product_id),
      productName: String(row.product_name),
      category: (row.category as string | null) ?? null,
      unit: String(row.unit),
      stockQuantity: Number(row.stock_quantity),
      avgDailyOutbound: Number(row.avg_daily_outbound),
      daysLeft: Number(row.days_left),
    }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <StockTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>발주 추천</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          최근 {LOOKBACK_DAYS}일간 실제로 팔린 속도로 봤을 때, 지금 재고로 {MAX_DAYS_LEFT}일 안에 바닥날 것
          같은 상품입니다. 소진까지 남은 일수가 적은 순서로 보여줍니다.
        </p>
      </header>

      <ReorderSuggestionsView rows={rows} />
    </div>
  );
}
