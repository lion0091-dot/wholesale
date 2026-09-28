/**
 * 접수대기(pending) 발주서의 품목/총액/배송정보 교체 — 바이어의 "발주 수정".
 *
 * 실제 삭제·재삽입·미수금 조정은 단일 트랜잭션인 SQL 함수(replace_pending_order_items,
 * 20260930000150)가 원자적으로 처리한다. 이 모듈은 그 RPC 호출과 DB 오류 메시지를
 * 화면에 보여줄 한국어 문구로 옮기는 역할만 한다.
 */

import type { createClient } from "@/lib/supabase/server";
import type { CartLine } from "@/lib/shop/order-policy";
import { lineSubtotal } from "@/lib/shop/order-policy";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type EditOrderErrorCode =
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_PENDING"
  | "PG_ORDER_NOT_EDITABLE"
  | "ORDER_HAS_STOCK_MOVEMENT"
  | "CREDIT_LIMIT_EXCEEDED"
  | "HOT_DEAL_QUOTA_EXCEEDED"
  | "UNKNOWN";

export type EditOrderResult = { ok: true } | { ok: false; error: string; code: EditOrderErrorCode };

/** 핫딜 매진 사유 파싱 — create-order.ts의 패턴과 동일. */
const HOT_DEAL_QUOTA_EXCEEDED_PATTERN = /HOT_DEAL_QUOTA_EXCEEDED:(.+):([\d.]+):([\d.]+):([\d.]+)/;

function classifyEditOrderError(message: string): EditOrderErrorCode {
  if (message.includes("ORDER_NOT_FOUND")) return "ORDER_NOT_FOUND";
  if (message.includes("ORDER_NOT_PENDING")) return "ORDER_NOT_PENDING";
  if (message.includes("PG_ORDER_NOT_EDITABLE")) return "PG_ORDER_NOT_EDITABLE";
  if (message.includes("ORDER_HAS_STOCK_MOVEMENT")) return "ORDER_HAS_STOCK_MOVEMENT";
  if (message.includes("CREDIT_LIMIT_EXCEEDED")) return "CREDIT_LIMIT_EXCEEDED";
  if (HOT_DEAL_QUOTA_EXCEEDED_PATTERN.test(message)) return "HOT_DEAL_QUOTA_EXCEEDED";

  return "UNKNOWN";
}

const EDIT_ORDER_ERROR_MESSAGES: Record<EditOrderErrorCode, string> = {
  ORDER_NOT_FOUND: "해당 발주서를 찾을 수 없습니다.",
  ORDER_NOT_PENDING: "이미 공급사가 확인한 발주서라 직접 수정할 수 없습니다. 공급사에 유선으로 문의해주세요.",
  PG_ORDER_NOT_EDITABLE: "카드(PG) 결제 발주서는 직접 수정할 수 없습니다. 공급사에 문의해주세요.",
  ORDER_HAS_STOCK_MOVEMENT: "이미 처리가 시작된 발주서라 수정할 수 없습니다.",
  CREDIT_LIMIT_EXCEEDED: "여신 한도를 초과하여 수정할 수 없습니다. 미수금 정산 후 다시 시도해주세요.",
  HOT_DEAL_QUOTA_EXCEEDED: "핫딜 한도가 그 사이 바뀌었습니다. 수량을 확인 후 다시 시도해주세요.",
  UNKNOWN: "발주 수정에 실패했습니다. 잠시 후 다시 시도해주세요.",
};

export interface ReplacePendingOrderItemsParams {
  orderId: string;
  lines: CartLine[];
  totalAmount: number;
  deliveryAddress: string;
  deliveryNotes: string | null;
}

export async function replacePendingOrderItems(
  supabase: SupabaseServerClient,
  params: ReplacePendingOrderItemsParams
): Promise<EditOrderResult> {
  const items = params.lines.map((line) => ({
    productId: line.productId,
    productName: line.name,
    category: line.category,
    subcategory: line.subcategory,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    subtotalAmount: lineSubtotal(line),
    requestedUnitPrice: line.requestedUnitPrice ?? null,
    isHotDeal: line.isHotDeal,
  }));

  const { error } = await supabase.rpc("replace_pending_order_items", {
    p_order_id: params.orderId,
    p_items: items,
    p_new_total: params.totalAmount,
    p_delivery_address: params.deliveryAddress,
    p_delivery_notes: params.deliveryNotes,
  });

  if (error) {
    const code = classifyEditOrderError(error.message);

    return { ok: false, error: EDIT_ORDER_ERROR_MESSAGES[code], code };
  }

  return { ok: true };
}
