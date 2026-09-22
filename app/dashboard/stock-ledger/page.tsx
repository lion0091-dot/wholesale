import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { StockLedgerView, type LedgerRow, type LedgerSummary, type LedgerProduct } from "./stock-ledger-view";

export const metadata = {
  title: "입출고 내역 | 도매업체 통합관리시스템",
};

/** 기본 조회 구간 — 원장은 계속 쌓이기만 하므로 화면을 열 때 전체를 끌고 오지 않는다. */
const DEFAULT_DAYS = 30;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function StockLedgerPage({
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
  const eventType = pick("event") || "";

  let rows: LedgerRow[] = [];
  let summary: LedgerSummary = { inbound: 0, outbound: 0, adjustment: 0, loss: 0 };
  let products: LedgerProduct[] = [];
  let totalCount = 0;

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: ledgerRows }, { data: summaryRows }, { data: productRows }] = await Promise.all([
      supabase.rpc("list_stock_ledger", {
        p_wholesaler_id: scope.wholesalerId,
        p_from: from,
        p_to: to,
        p_product_id: productId || null,
        p_event_types: eventType ? [eventType] : null,
        p_limit: 200,
        p_offset: 0,
      }),
      supabase.rpc("summarize_stock_ledger", {
        p_wholesaler_id: scope.wholesalerId,
        p_from: from,
        p_to: to,
        p_product_id: productId || null,
      }),
      supabase
        .from("products")
        .select("id, name")
        .eq("wholesaler_id", scope.wholesalerId)
        .order("name", { ascending: true }),
    ]);

    rows = ((ledgerRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      createdAt: String(row.created_at),
      eventType: String(row.event_type),
      qtyDelta: Number(row.qty_delta),
      reason: (row.reason as string | null) ?? null,
      productName: (row.product_name as string | null) ?? null,
      productUnit: (row.product_unit as string | null) ?? "kg",
      traceNo: (row.trace_no as string | null) ?? null,
      orderNumber: (row.order_number as string | null) ?? null,
      actorName: (row.actor_name as string | null) ?? null,
    }));

    totalCount = ledgerRows && ledgerRows.length > 0 ? Number((ledgerRows[0] as Record<string, unknown>).total_count) : 0;

    const summaryRow = (summaryRows ?? [])[0] as Record<string, unknown> | undefined;

    summary = {
      inbound: Number(summaryRow?.inbound_qty ?? 0),
      outbound: Number(summaryRow?.outbound_qty ?? 0),
      adjustment: Number(summaryRow?.adjustment_qty ?? 0),
      loss: Number(summaryRow?.loss_qty ?? 0),
    };

    products = (productRows ?? []) as LedgerProduct[];
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>입출고 내역</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          입고·출고·조정·손실이 한 곳에 시간순으로 쌓입니다. 재고 숫자가 왜 그렇게 됐는지 여기서 추적합니다.
        </p>
      </header>

      <StockLedgerView
        rows={rows}
        summary={summary}
        products={products}
        totalCount={totalCount}
        filters={{ from, to, productId, eventType }}
      />
    </div>
  );
}
