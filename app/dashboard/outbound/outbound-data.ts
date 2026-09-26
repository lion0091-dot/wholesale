import { createClient } from "@/lib/supabase/server";
import type { SupplierScope } from "@/lib/supplier/scope";
import type { ShippableOrder } from "./outbound-scan-view";

/** 한 화면 선택 목록에 올리는 최대 발주서 수 — 이보다 많으면 오래 기다린 것부터 보인다. */
const ORDER_LIST_LIMIT = 300;

/**
 * 출고 화면의 발주서 목록.
 * 아직 마감 안 된 발주서(스캔·마감 가능)를 먼저, 마감돼 배송 대기 중인 것은 뒤에 둔다 — 마감된 발주서가 맨 위에 있으면
 * 기본 선택이 그것이 되어 첫 스캔이 "이미 마감됨"으로 거부되고, 마감 건이 쌓이면 새 발주서가 목록 밖으로 밀려난다.
 * 확정·배송중·재고 확보 대기 발주서만 나온다(접수대기는 확정 전, 완료·취소는 끝난 건).
 */
export async function loadOutboundOrders(scope: SupplierScope | null): Promise<ShippableOrder[]> {
  if (!scope?.wholesalerId) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("orders")
    .select("id, order_number, status, ordered_at, shipment_finalized_at, retailers ( restaurant_name )")
    .eq("wholesaler_id", scope.wholesalerId)
    .in("status", ["awaiting_stock", "confirmed", "shipping"])
    .order("shipment_finalized_at", { ascending: true, nullsFirst: true })
    .order("ordered_at", { ascending: true })
    .limit(ORDER_LIST_LIMIT);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;

    return {
      id: String(row.id),
      orderNumber: String(row.order_number),
      status: String(row.status),
      orderedAt: String(row.ordered_at),
      finalized: Boolean(row.shipment_finalized_at),
      retailerName: ((retailer as Record<string, unknown> | null)?.restaurant_name as string | null) ?? "거래처",
    };
  });
}
