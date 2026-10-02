import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { CostAccessNotice } from "@/components/cost-access-notice";
import { resolveCostAccess } from "@/lib/supplier/cost-access";
import { fetchSubcategoriesByCategory } from "../products/get-subcategories";
import { loadProductOptions } from "@/lib/purchase-orders/load-product-options";
import type { ProductOption } from "@/lib/purchase-orders/product-match";
import { PurchaseOrderView, type PurchaseOrderRow, type SupplierRow } from "./purchase-order-view";

export const metadata = {
  title: "전표관리 | 도매업체 통합관리시스템",
};

const RECENT_LIMIT = 60;

/** 공급사가 공급처에 내는 발주서 — 화면에서 적거나 엑셀 양식을 내려받아 채워 올린다. */
export default async function PurchaseOrdersPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  // 전표에는 단가(원가)가 있어 대표 + 전표 담당 직원만 연다(209). 아니면 이유만 안내한다.
  const canViewCost = scope?.wholesalerId ? await resolveCostAccess(await createClient(), scope) : false;

  if (scope?.wholesalerId && !canViewCost) {
    return <CostAccessNotice screenName="전표관리" />;
  }

  let orders: PurchaseOrderRow[] = [];
  let suppliers: SupplierRow[] = [];
  let categories: string[] = [];
  let subcategoriesByCategory: Record<string, string[]> = {};
  let products: ProductOption[] = [];
  let heldCount = 0;
  let overdueRows: Array<{ id: string; supplier_id: string; supplier_name: string; expected_on: string }> = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const kstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [{ data: orderRows }, { data: categoryRows }, subcategories, { data: supplierRows }, productOptions, { count: heldRows }, { data: overdueData }] = await Promise.all([
      supabase
        .from("purchase_orders")
        .select(
          "id, supplier_id, supplier_name, ordered_on, expected_on, note, status, auto_closed_at, purchase_order_lines ( line_no, product_id, category, breed, subcategory, grade, sex, bms, storage_state, origin, quantity, unit, purchase_order_line_scans ( weight, inbound_scans ( status ) ) )"
        )
        .eq("wholesaler_id", scope.wholesalerId)
        .order("ordered_on", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT),
      supabase.from("product_categories").select("name").order("sort_order", { ascending: true }),
      fetchSubcategoriesByCategory(supabase),
      supabase
        .from("suppliers")
        .select("id, name, phone, note, aliases, is_active")
        .eq("wholesaler_id", scope.wholesalerId)
        .order("name", { ascending: true }),
      loadProductOptions(supabase, scope.wholesalerId),
      // 보류함에 정리할 물건(전표에 없음·초과로 받아 둔 박스) 수 — 카드가 보류함으로 안내하는 데 쓴다.
      supabase
        .from("inbound_scans")
        .select("id", { count: "exact", head: true })
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("status", "NORMAL")
        .in("po_state", ["UNLISTED_HELD", "OVER_HELD"]),
      // 도착 예정일이 지났는데 아직 진행 중인 전표 — 최근 전표 창(RECENT_LIMIT) 밖의 오래된 전표도 놓치지 않게 따로 조회한다.
      supabase
        .from("purchase_orders")
        .select("id, supplier_id, supplier_name, expected_on")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("status", "OPEN")
        .lt("expected_on", kstToday)
        .order("expected_on", { ascending: true })
        .limit(50),
    ]);
    heldCount = heldRows ?? 0;
    overdueRows = (overdueData ?? []) as typeof overdueRows;

    // 줄 단가는 컬럼 직접 조회가 막혀 있어(209) get_po_line_prices로 따로 읽는다 — 여기까지 왔으면 대표·전표 담당이다.
    const priceByLine = new Map<string, number | null>();
    const orderIds = ((orderRows ?? []) as Array<{ id: string }>).map((row) => row.id);

    if (orderIds.length > 0) {
      const { data: priceRows } = await supabase.rpc("get_po_line_prices", { p_order_ids: orderIds });

      // 전표 한 건당 한 행(줄번호 → 단가) — 줄 단위로 받으면 API 응답 상한(1,000행)에 걸린다.
      ((priceRows ?? []) as Array<{ order_id: string; prices: Record<string, number | string | null> }>).forEach((row) => {
        Object.entries(row.prices ?? {}).forEach(([lineNo, price]) => {
          priceByLine.set(`${row.order_id}:${lineNo}`, price === null ? null : Number(price));
        });
      });
    }

    type RawLine = Omit<PurchaseOrderRow["purchase_order_lines"][number], "received"> & {
      purchase_order_line_scans?: Array<{ weight: number | string; inbound_scans: { status: string } | null }>;
    };

    orders = ((orderRows ?? []) as unknown as Array<Omit<PurchaseOrderRow, "purchase_order_lines"> & { purchase_order_lines: RawLine[] }>).map((order) => ({
      ...order,
      purchase_order_lines: [...(order.purchase_order_lines ?? [])]
        .sort((a, b) => a.line_no - b.line_no)
        .map(({ purchase_order_line_scans, ...line }) => ({
          ...line,
          unit_price: priceByLine.get(`${order.id}:${line.line_no}`) ?? null,
          // 받은 양 = 이 줄에 채워진 박스 무게(취소 제외)의 합 — DB 판정(judge_scan_purchase_order)과 같은 계산.
          received: (purchase_order_line_scans ?? []).reduce(
            (sum, link) => (link.inbound_scans && link.inbound_scans.status !== "VOIDED" ? sum + Number(link.weight) : sum),
            0
          ),
        })),
    }));
    categories = ((categoryRows ?? []) as Array<{ name: string }>).map((row) => row.name);
    subcategoriesByCategory = subcategories;
    products = productOptions;
    suppliers = ((supplierRows ?? []) as unknown as SupplierRow[]).map((row) => ({ ...row, aliases: row.aliases ?? [] }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>전표관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          공급처에 발주한 품목과 수량(예: 소 등심 1++ 국내산 50kg)을 적어 둡니다. 공급처는 아래 거래처 목록에서 고르고,
          품목은 축종부터 부위·등급·원산지까지 차례로 골라서 정합니다(이미 등록된 상품이면 자동으로 연결되고, 없으면 그 자리에서 새로 등록됩니다) — 엑셀 양식을 내려받아 채워 올려도 됩니다. 물건이 도착하면 입고 스캔에서 고른 거래처를 보고 이 전표와 자동으로 맞춰집니다.
        </p>
      </header>

      <PurchaseOrderView
        canManage={canViewCost}
        categories={categories}
        subcategoriesByCategory={subcategoriesByCategory}
        suppliers={suppliers}
        orders={orders}
        products={products}
        heldCount={heldCount}
        overdueRows={overdueRows}
      />
    </div>
  );
}
