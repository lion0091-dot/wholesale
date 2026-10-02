import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { FeatureNotice } from "@/components/feature-notice";
import { fetchStockMismatches, fetchStockRepairs } from "@/lib/supplier/stock-repair";
import { StockTabs } from "../section-tabs";
import { RepairView } from "./repair-view";

export const metadata = {
  title: "장부 불일치 | 도매업체 통합관리시스템",
};

/**
 * 장부 불일치 — 상품 재고·박스 잔량 숫자가 장부(입출고 기록)와 다른 항목만 보여주고, 대표님이 장부 기준 / 실물 기준을 골라 고친다.
 * 창고에 실제로 있는 양을 점검하는 화면이 아니다 — 전산 숫자끼리 안 맞는 것만 다룬다(실물 차이는 실사로 확인).
 * 입출고 기록은 고치지 않고 사유가 붙은 보정 기록만 쌓는다(마이그레이션 215, docs/stock-integrity.md).
 */
export default async function StockIntegrityPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const supabase = await createClient();
  const mismatches = scope?.wholesalerId ? await fetchStockMismatches(supabase) : null;

  if (!mismatches) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <StockTabs />
        <FeatureNotice screenName="장부 불일치">
          장부 불일치 보정은 대표님만 할 수 있어요. 재고 숫자가 입출고 기록과 다르다고 느껴지면 대표님께 알려 주세요.
        </FeatureNotice>
      </div>
    );
  }

  const repairs = await fetchStockRepairs(supabase);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <StockTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>장부 불일치</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0", lineHeight: 1.6 }}>
          전산의 재고·박스 잔량 숫자가 입출고 기록(장부)과 다른 항목만 보여줍니다. <strong>창고에 실제로 있는 양과 비교하는 화면은 아니에요</strong> — 실물과의
          차이는 직접 세어 봐야 알 수 있습니다. 입출고 기록은 고치지 않고, 고친 내용은 사유와 함께 따로 남습니다. 입고·출고는 이 화면과 상관없이 계속 받을 수 있어요.
        </p>
      </header>

      <RepairView mismatches={mismatches} repairs={repairs} />
    </div>
  );
}
