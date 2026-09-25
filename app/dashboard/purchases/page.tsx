import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import {
  PurchaseSettlementView,
  type PurchaseRow,
  type PurchaseSummary,
  type PurchaseProduct,
} from "./purchase-settlement-view";
import { StockTabs } from "../section-tabs";

export const metadata = {
  title: "매입 정산 | 도매업체 통합관리시스템",
};

/** 매입 정산은 보통 "이번 주/이번 달 들어온 것"을 본다. */
const DEFAULT_DAYS = 30;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 입고된 박스별 실중량·표기중량 차이와 매입금액을 한 화면에 모은다.
 *
 * 입고 화면은 현장에서 찍는 데 집중하는 화면이라 정산을 섞지 않는다(10단계
 * 입출고 내역과 같은 판단). 여기서는 "얼마를 줘야 하나"와 "어디서 자꾸 덜 오나"
 * 두 가지만 본다.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const params = await searchParams;
  const pick = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]);

  const today = new Date();
  const from = pick("from") || isoDate(new Date(today.getTime() - DEFAULT_DAYS * 86_400_000));
  const to = pick("to") || isoDate(today);
  const productId = pick("product") || "";
  const supplier = pick("supplier") || "";
  const onlyGap = pick("gap") === "1";

  let rows: PurchaseRow[] = [];
  let summary: PurchaseSummary = {
    boxCount: 0,
    labeledTotal: 0,
    actualTotal: 0,
    varianceTotal: 0,
    purchaseTotal: 0,
    unpricedCount: 0,
    overGapCount: 0,
    varianceAmount: 0,
  };
  let products: PurchaseProduct[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: listRows }, { data: summaryRows }, { data: productRows }] = await Promise.all([
      supabase.rpc("list_inbound_purchases", {
        p_from: from,
        p_to: to,
        p_product_id: productId || null,
        p_supplier: supplier || null,
        p_only_gap: onlyGap,
        p_limit: 200,
      }),
      supabase.rpc("summarize_inbound_purchases", {
        p_from: from,
        p_to: to,
        p_product_id: productId || null,
        p_supplier: supplier || null,
      }),
      supabase
        .from("products")
        .select("id, name")
        .eq("wholesaler_id", scope.wholesalerId)
        .is("archived_at", null)
        .order("name", { ascending: true }),
    ]);

    rows = ((listRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      scanId: String(row.scan_id),
      scannedAt: String(row.scanned_at),
      traceNo: String(row.trace_no),
      productId: (row.product_id as string | null) ?? null,
      productName: (row.product_name as string | null) ?? null,
      labeledWeight: row.labeled_weight === null ? null : Number(row.labeled_weight),
      actualWeight: Number(row.actual_weight),
      weightVariance: row.weight_variance === null ? null : Number(row.weight_variance),
      varianceRatio: row.variance_ratio === null ? null : Number(row.variance_ratio),
      unitPrice: row.unit_price === null ? null : Number(row.unit_price),
      purchaseAmount: row.purchase_amount === null ? null : Number(row.purchase_amount),
      purchaseSupplier: (row.purchase_supplier as string | null) ?? null,
      status: String(row.status),
      scannedBy: (row.scanned_by as string | null) ?? null,
      updatedAt: String(row.updated_at),
    }));

    const summaryRow = (summaryRows ?? [])[0] as Record<string, unknown> | undefined;

    summary = {
      boxCount: Number(summaryRow?.box_count ?? 0),
      labeledTotal: Number(summaryRow?.labeled_total ?? 0),
      actualTotal: Number(summaryRow?.actual_total ?? 0),
      varianceTotal: Number(summaryRow?.variance_total ?? 0),
      purchaseTotal: Number(summaryRow?.purchase_total ?? 0),
      unpricedCount: Number(summaryRow?.unpriced_count ?? 0),
      overGapCount: Number(summaryRow?.over_gap_count ?? 0),
      varianceAmount: Number(summaryRow?.variance_amount ?? 0),
    };

    products = (productRows ?? []) as PurchaseProduct[];
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <StockTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>매입 정산</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          입고된 박스마다 표기중량과 실중량의 차이, 그리고 실중량 기준 매입금액을 보여줍니다.
          매입금액은 언제나 저울에 찍힌 실중량으로 계산합니다.
        </p>
      </header>

      <PurchaseSettlementView
        rows={rows}
        summary={summary}
        products={products}
        filters={{ from, to, productId, supplier, onlyGap }}
      />
    </div>
  );
}
