import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { OutboundScanView, type ShippableOrder } from "./outbound-scan-view";

export const metadata = {
  title: "출고 스캔 | 도매업체 통합관리시스템",
};

export default async function OutboundPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let orders: ShippableOrder[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    // 확정·배송중인 발주서만 출고 대상이다. 접수대기는 아직 확정 전이고,
    // 완료·취소는 끝난 건이다.
    const { data } = await supabase
      .from("orders")
      .select("id, order_number, status, ordered_at, retailers ( restaurant_name )")
      .eq("wholesaler_id", scope.wholesalerId)
      .in("status", ["awaiting_stock", "confirmed", "shipping"])
      .order("ordered_at", { ascending: true })
      .limit(50);

    orders = ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
      const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;

      return {
        id: String(row.id),
        orderNumber: String(row.order_number),
        status: String(row.status),
        orderedAt: String(row.ordered_at),
        retailerName:
          ((retailer as Record<string, unknown> | null)?.restaurant_name as string | null) ?? "거래처",
      };
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>출고 스캔</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          나갈 박스를 찍으면 실제로 집은 박스로 배정이 정정됩니다. 거래명세서에도 그 이력번호가 찍힙니다.
        </p>
      </header>

      <OutboundScanView orders={orders} />
    </div>
  );
}
