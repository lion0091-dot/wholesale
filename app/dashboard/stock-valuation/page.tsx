import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { FeatureNotice } from "@/components/feature-notice";
import { FEATURE_KEYS, getMyUsableFeatures } from "@/lib/features/my-features";
import { fetchInventoryValuation, summarizeValuation } from "@/lib/supplier/inventory-valuation";
import { AccountingTabs } from "../section-tabs";
import { ValuationView } from "./valuation-view";

export const metadata = {
  title: "원가 관리 | 도매업체 통합관리시스템",
};

/**
 * 원가 관리 — 지금 창고에 남은 재고가 원가로 얼마인지. 주문별 마진은 고객 주문 상세에 같은 이름의 박스로 있다.
 * 업체에서 "원가 관리"가 켜져 있고, 대표이거나 대표가 허용한 사람만 열린다(마이그레이션 210, docs/wholesaler-features.md).
 */
export default async function StockValuationPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const features = scope?.wholesalerId ? await getMyUsableFeatures() : new Map<string, Record<string, unknown>>();
  const rows = features.has(FEATURE_KEYS.costManagement) ? await fetchInventoryValuation(await createClient()) : null;

  if (!rows) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <AccountingTabs />
        <FeatureNotice screenName="원가 관리" />
      </div>
    );
  }

  const summary = summarizeValuation(rows);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <AccountingTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>원가 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          지금 창고에 남은 재고가 매입 원가로 얼마인지 보여줍니다. 박스는 오래된 순으로 나오고, 박스마다 입고 후 며칠 됐는지와 소비기한이 같이 보입니다.
          나간 주문의 마진은 고객 주문 상세의 &quot;원가 관리&quot; 박스에서 봅니다.
        </p>
      </header>

      <ValuationView summary={summary} />
    </div>
  );
}
