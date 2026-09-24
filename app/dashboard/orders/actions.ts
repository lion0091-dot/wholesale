"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { getSupplierScope } from "@/lib/supplier/scope";
import { ORDER_STATUS_TRANSITIONS, HISTORICAL_ORDER_STATUSES, isSupplierAssignableStatus } from "@/lib/orders/status";
import {
  ORDER_LIST_SELECT_COLUMNS,
  ORDER_LIST_SELECT_COLUMNS_RETAILER_INNER,
  mapOrderJoinRow,
  type OrderJoinRow,
  type OrderRow,
} from "@/lib/orders/order-row";
import { ORDER_HISTORY_PAGE_SIZE, ORDER_HISTORY_SEARCH_LIMIT } from "@/lib/orders/history-range";
import {
  KOREAN_COURIERS,
  fetchTrackingStatus,
  isSweetTrackerConfigured,
  type TrackingResult,
} from "@/lib/verification/sweettracker";
import { cancelPayment, TossPaymentsError } from "@/lib/payments/tosspayments-client";
import { decryptCredential, CredentialCryptoError } from "@/lib/security/credential-crypto";
import type { OrderStatus } from "@/types/database";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/orders";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 발주 처리는 staff까지 허용한다 (PRD: 직원은 발주 접수/출고 처리 담당) */
const ORDER_ROLES: OrgRole[] = ["owner", "manager", "staff"];

const VALID_STATUSES: OrderStatus[] = [
  "pending",
  "confirmed",
  "shipping",
  "delivered",
  "cancel_requested",
  "cancel_rejected",
  "cancelled",
];

/**
 * 주문 확정 시 재고가 모자라면 DB 트리거(sync_order_stock → apply_order_shipment)가
 * 'INSUFFICIENT_STOCK:<상품명>:<보유>:<주문>' 형태로 예외를 던져 상태 전이를 막는다.
 * 날것의 Postgres 오류 문자열이 공급사에게 그대로 보이지 않도록 사람이 읽을 문장으로 바꾼다.
 */
const INSUFFICIENT_STOCK_PATTERN = /INSUFFICIENT_STOCK:(.*?):([\d.]+):([\d.]+)/;

function translateStockError(message: string): string | null {
  const stockMatch = message.match(INSUFFICIENT_STOCK_PATTERN);

  if (stockMatch) {
    const [, productName, available, requested] = stockMatch;
    const trim = (value: string) => String(Number(value));

    return `재고가 부족해 확정할 수 없습니다 — ${productName}: 보유 ${trim(available)}, 주문 ${trim(requested)}. 입고를 먼저 등록하거나 상품 재고를 조정해주세요.`;
  }

  return null;
}

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  if (error instanceof Error) {
    return { success: false, error: translateStockError(error.message) ?? error.message };
  }

  return { success: false, error: "알 수 없는 오류가 발생했습니다." };
}

/** 주문도 상품과 동일하게 레거시 wholesalers.id로 스코프된다. */
async function resolveOrderScope() {
  const context = await requireOrgRole(ORDER_ROLES);
  const supabase = await createClient();

  let wholesalerId: string | null = null;

  if (context.organizationId) {
    const { data: organization } = await supabase
      .from("organizations")
      .select("wholesaler_id")
      .eq("id", context.organizationId)
      .maybeSingle();

    wholesalerId = (organization?.wholesaler_id as string | null) ?? null;
  }

  if (!wholesalerId) {
    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("id")
      .eq("profile_id", context.userId)
      .maybeSingle();

    wholesalerId = (wholesaler?.id as string | null) ?? null;
  }

  if (!wholesalerId) {
    throw new RbacError("공급사 업체 정보가 없어 발주를 처리할 수 없습니다.");
  }

  return { supabase, context, wholesalerId };
}

/**
 * 주문 상태 변경.
 * 소유 공급사 검증 + 상태 전이 규칙(ORDER_STATUS_TRANSITIONS) 검증을 함께 수행한다.
 */
export async function updateOrderStatusAction(
  orderId: string,
  nextStatus: OrderStatus
): Promise<ActionResult<{ status: OrderStatus }>> {
  try {
    const { supabase, context, wholesalerId } = await resolveOrderScope();

    if (!UUID_PATTERN.test(orderId)) {
      throw new RbacError("올바른 발주 식별자가 아닙니다.");
    }

    if (!VALID_STATUSES.includes(nextStatus)) {
      throw new RbacError("변경할 수 없는 발주 상태입니다.");
    }

    // 취소 '요청'은 바이어만 생성할 수 있고, 공급사는 승인/반려만 한다.
    if (!isSupplierAssignableStatus(nextStatus)) {
      throw new RbacError("취소 요청은 고객(소매)만 생성할 수 있습니다.");
    }

    const { data: order } = await supabase
      .from("orders")
      .select("id, wholesaler_id, status, payment_method, payment_status, pg_payment_key")
      .eq("id", orderId)
      .maybeSingle();

    if (!order) {
      throw new RbacError("해당 발주서를 찾을 수 없습니다.");
    }

    if (!context.isSuperAdmin && order.wholesaler_id !== wholesalerId) {
      throw new RbacError("다른 공급사의 발주서는 처리할 수 없습니다.");
    }

    const currentStatus = order.status as OrderStatus;

    if (currentStatus === nextStatus) {
      return { success: true, data: { status: nextStatus } };
    }

    if (!ORDER_STATUS_TRANSITIONS[currentStatus].includes(nextStatus)) {
      throw new RbacError("현재 상태에서는 해당 처리를 진행할 수 없습니다.");
    }

    const updates: Record<string, unknown> = { status: nextStatus, updated_at: new Date().toISOString() };
    // 아래 환불이 실제로 나갔는지 — 나갔다면 상태 변경이 어떻게 되든 결제 상태는 반드시 남겨야 한다.
    let refunded = false;

    // PG로 결제 완료된 주문을 취소하는 경우, 상태만 바꾸는 게 아니라 실제로
    // 환불까지 성공해야 한다 — 환불이 실패하면 상태 전이 자체를 막는다(돈은
    // 안 돌려주고 취소 처리만 되는 사고 방지).
    if (
      nextStatus === "cancelled" &&
      order.payment_method === "pg" &&
      order.payment_status === "paid" &&
      order.pg_payment_key
    ) {
      const { data: orderWholesaler } = await supabase
        .from("wholesalers")
        .select("pg_secret_key_encrypted")
        .eq("id", order.wholesaler_id as string)
        .maybeSingle();

      const encryptedSecret = orderWholesaler?.pg_secret_key_encrypted as string | null;

      if (!encryptedSecret) {
        throw new RbacError("PG 연동 설정을 찾을 수 없어 환불을 진행할 수 없습니다. 공급사 설정을 확인해주세요.");
      }

      try {
        const secretKey = decryptCredential(encryptedSecret);

        await cancelPayment({
          secretKey,
          paymentKey: order.pg_payment_key as string,
          cancelReason: "구매자 취소 요청 승인",
        });

        updates.payment_status = "refunded";
        refunded = true;
      } catch (refundError) {
        if (refundError instanceof TossPaymentsError) {
          throw new RbacError(`환불 처리에 실패해 취소를 진행할 수 없습니다: ${refundError.message}`);
        }
        if (refundError instanceof CredentialCryptoError) {
          throw new RbacError("PG 연동 설정 오류로 환불을 진행할 수 없습니다.");
        }
        throw refundError;
      }
    }

    // 읽은 상태 그대로일 때만 바꾼다(낙관적 조건). 그 사이 다른 직원이 상태를 옮겼으면
    // 0건으로 끝나고, 위에서 검증한 전이 규칙이 새 상태에는 맞지 않을 수 있으므로
    // 덮어쓰지 않고 새로고침을 안내한다 — 취소 요청 액션(app/shop)과 같은 방식.
    const { data: updatedRows, error } = await supabase
      .from("orders")
      .update(updates)
      .eq("id", orderId)
      .eq("status", currentStatus)
      .select("id");

    if (error) {
      // 재고 부족은 사용자가 고칠 수 있는 상황이므로 RbacError(=그대로 노출되는 문구)로 올린다.
      const stockMessage = translateStockError(error.message);

      if (stockMessage) {
        throw new RbacError(stockMessage);
      }

      throw new Error(error.message);
    }

    if (!updatedRows || updatedRows.length === 0) {
      if (refunded) {
        // 환불은 이미 나갔는데 그 사이 상태가 바뀌어 취소 처리를 못 했다. 돈이 돌아간 사실은
        // 상태와 무관하게 기록해야 한다 — 안 그러면 '결제됨'으로 남아 이중 환불·정산 오류가 난다.
        await supabase
          .from("orders")
          .update({ payment_status: "refunded", updated_at: new Date().toISOString() })
          .eq("id", orderId);

        throw new RbacError(
          "환불은 완료됐지만 그 사이 발주 상태가 다른 사람에 의해 바뀌어 취소 처리는 되지 않았습니다. 결제 상태는 '환불됨'으로 기록했습니다. 새로고침 후 발주 상태를 확인해주세요."
        );
      }

      throw new RbacError("발주 상태가 방금 다른 사람에 의해 변경되었습니다. 새로고침 후 다시 확인해주세요.");
    }

    revalidatePath(REVALIDATE_PATH);
    revalidatePath(`${REVALIDATE_PATH}/${orderId}`);

    return { success: true, data: { status: nextStatus } };
  } catch (error) {
    return toResult(error);
  }
}

/** 주문 소유권만 확인하고 반환한다 — 상태 전이 검증이 필요 없는 부가 필드용. */
async function loadOwnedOrder(orderId: string, wholesalerId: string, isSuperAdmin: boolean) {
  const supabase = await createClient();

  if (!UUID_PATTERN.test(orderId)) {
    throw new RbacError("올바른 발주 식별자가 아닙니다.");
  }

  const { data: order } = await supabase
    .from("orders")
    .select("id, wholesaler_id, courier_code, tracking_number, status")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) {
    throw new RbacError("해당 발주서를 찾을 수 없습니다.");
  }

  if (!isSuperAdmin && order.wholesaler_id !== wholesalerId) {
    throw new RbacError("다른 공급사의 발주서는 처리할 수 없습니다.");
  }

  return { supabase, order };
}

export type TrackingVerification = "verified" | "skipped_not_configured";

/**
 * 배송 조회 정보(택배사/운송장번호) 저장 — 정산은 관여하지 않는 순수 조회용 메타데이터다.
 *
 * 스위트트래커 API 키가 설정돼 있으면 저장 전에 실제로 조회 가능한 번호인지 검증한다
 * (오타로 잘못된 번호가 저장 + 자동 배송중 전환되는 걸 막기 위함). 키가 없으면 검증을
 * 건너뛰고 그대로 저장한다 — UI(`TrackingPanel`)가 `verification` 값으로 "검증 없이
 * 저장됨" 사유를 보여준다.
 *
 * 운송장번호를 입력한다는 건 실질적으로 이미 상차/출고했다는 뜻이라, 현재 상태가
 * `confirmed`(확정)일 때는 저장과 동시에 `shipping`으로 자동 전환한다. ORDER_STATUS_TRANSITIONS
 * 가드를 그대로 재사용해서 confirmed가 아닌 상태(예: pending, 이미 shipping/delivered)에서는
 * 건드리지 않는다 — "출고/배송 시작" 수동 버튼(updateOrderStatusAction)은 그대로 남겨둔다.
 */
export async function updateOrderTrackingAction(
  orderId: string,
  courierCode: string,
  trackingNumber: string
): Promise<
  ActionResult<{
    courierCode: string;
    trackingNumber: string;
    status: OrderStatus;
    verification: TrackingVerification;
  }>
> {
  try {
    const { context, wholesalerId } = await resolveOrderScope();

    if (!KOREAN_COURIERS.some((courier) => courier.code === courierCode)) {
      throw new RbacError("지원하지 않는 택배사입니다.");
    }

    const trimmedNumber = trackingNumber.trim();

    if (!trimmedNumber) {
      throw new RbacError("운송장번호를 입력해주세요.");
    }

    let verification: TrackingVerification = "skipped_not_configured";

    if (isSweetTrackerConfigured()) {
      const lookup = await fetchTrackingStatus(courierCode, trimmedNumber);

      if (lookup.status === "error") {
        throw new RbacError(
          `${lookup.message} 운송장번호나 택배사를 다시 확인해주세요.`
        );
      }

      verification = "verified";
    }

    const { supabase, order } = await loadOwnedOrder(orderId, wholesalerId, context.isSuperAdmin);

    const currentStatus = order.status as OrderStatus;
    const shouldAutoShip =
      currentStatus === "confirmed" && ORDER_STATUS_TRANSITIONS.confirmed.includes("shipping");
    const nextStatus: OrderStatus = shouldAutoShip ? "shipping" : currentStatus;

    const { error } = await supabase
      .from("orders")
      .update({
        courier_code: courierCode,
        tracking_number: trimmedNumber,
        ...(shouldAutoShip ? { status: "shipping", updated_at: new Date().toISOString() } : {}),
      })
      .eq("id", orderId);

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    revalidatePath(`${REVALIDATE_PATH}/${orderId}`);

    return {
      success: true,
      data: { courierCode, trackingNumber: trimmedNumber, status: nextStatus, verification },
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 배송완료/취소 목록의 조회 구간을 바꾸거나("최근 30일"→"전체 기간") "다음"으로
 * 더 불러올 때 호출한다. "전체 기간"을 고르면 그 자체로도 수백~수천 건이 될 수 있어서
 * ORDER_HISTORY_PAGE_SIZE(30)개씩 끊어서 가져오고, PostgREST의 count: "exact"로
 * 같은 요청 안에서 전체 개수도 함께 받는다(별도 count 쿼리 불필요).
 *
 * 접수대기~취소반려 같은 진행 중 상태는 페이지 최초 로드 때 항상 전체를 가져오므로
 * 여기서 다루지 않는다.
 */
export async function getHistoricalOrdersAction(
  rangeDays: number | null,
  offset = 0
): Promise<ActionResult<{ entries: OrderRow[]; totalCount: number; hasMore: boolean }>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const supabase = await createClient();

    let query = supabase
      .from("orders")
      .select(ORDER_LIST_SELECT_COLUMNS, { count: "exact" })
      .eq("wholesaler_id", scope.wholesalerId)
      .in("status", HISTORICAL_ORDER_STATUSES);

    if (rangeDays !== null) {
      const cutoff = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("ordered_at", cutoff);
    }

    const { data, count, error } = await query
      .order("ordered_at", { ascending: false })
      .range(offset, offset + ORDER_HISTORY_PAGE_SIZE - 1);

    if (error) {
      return { success: false, error: "발주서 조회에 실패했습니다." };
    }

    const entries = ((data ?? []) as OrderJoinRow[]).map(mapOrderJoinRow);
    const totalCount = count ?? 0;

    return {
      success: true,
      data: { entries, totalCount, hasMore: offset + entries.length < totalCount },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "조회 중 오류가 발생했습니다.",
    };
  }
}

/**
 * 배송완료/취소 목록에서 발주번호 또는 거래처(소매) 상호로 검색한다.
 * 조회 구간(30일/3개월)에 갇히면 예전 발주를 못 찾으므로, 검색은 전체 기간을
 * 대상으로 하되 결과가 무한정 커지는 걸 막기 위해 ORDER_HISTORY_SEARCH_LIMIT으로
 * 상한만 둔다(페이지네이션 없음 — 특정 건을 찾는 용도이지 목록 훑어보기가 아니라서).
 *
 * 거래처 상호는 retailers 조인 테이블 컬럼이라 order_number 검색과 한 쿼리의
 * or()로 묶기 까다로워(임베디드 리소스 필터는 inner join을 요구) 두 번 쿼리해서
 * 합친다.
 */
export async function searchHistoricalOrdersAction(
  keyword: string
): Promise<ActionResult<{ entries: OrderRow[] }>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const trimmed = keyword.trim();

    if (!trimmed) {
      return { success: true, data: { entries: [] } };
    }

    const supabase = await createClient();
    const pattern = `%${trimmed.replace(/[%_]/g, (char) => `\\${char}`)}%`;

    const [byOrderNumber, byRetailerName] = await Promise.all([
      supabase
        .from("orders")
        .select(ORDER_LIST_SELECT_COLUMNS)
        .eq("wholesaler_id", scope.wholesalerId)
        .in("status", HISTORICAL_ORDER_STATUSES)
        .ilike("order_number", pattern)
        .order("ordered_at", { ascending: false })
        .limit(ORDER_HISTORY_SEARCH_LIMIT),
      supabase
        .from("orders")
        .select(ORDER_LIST_SELECT_COLUMNS_RETAILER_INNER)
        .eq("wholesaler_id", scope.wholesalerId)
        .in("status", HISTORICAL_ORDER_STATUSES)
        .ilike("retailers.restaurant_name", pattern)
        .order("ordered_at", { ascending: false })
        .limit(ORDER_HISTORY_SEARCH_LIMIT),
    ]);

    if (byOrderNumber.error || byRetailerName.error) {
      return { success: false, error: "발주서 검색에 실패했습니다." };
    }

    const merged = new Map<string, OrderJoinRow>();

    for (const row of [
      ...((byOrderNumber.data ?? []) as OrderJoinRow[]),
      ...((byRetailerName.data ?? []) as OrderJoinRow[]),
    ]) {
      merged.set(row.id, row);
    }

    // 발주번호 일치와 거래처명 일치를 각각 이미 ORDER_HISTORY_SEARCH_LIMIT개로 캡한
    // 상태라 합친 결과를 여기서 다시 자르지 않는다 — 합친 뒤 자르면 거래처명 일치가
    // 많을 때 발주번호로 정확히 찾은 진짜 결과가 뒤로 밀려 조용히 빠질 수 있다
    // (app/dashboard/history/orders/actions.ts의 searchOrdersForHistoryAction과 동일한
    // 버그였고 2026-09-21에 그쪽만 먼저 고쳐졌던 것을 여기도 맞춤, 2026-09-23).
    const entries = Array.from(merged.values())
      .sort((a, b) => (a.ordered_at < b.ordered_at ? 1 : -1))
      .map(mapOrderJoinRow);

    return { success: true, data: { entries } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "검색 중 오류가 발생했습니다.",
    };
  }
}

/** 저장된 택배사/운송장번호로 스위트트래커 배송 상태를 라이브 조회한다. */
export async function fetchOrderTrackingStatusAction(
  orderId: string
): Promise<ActionResult<TrackingResult>> {
  try {
    const { context, wholesalerId } = await resolveOrderScope();
    const { order } = await loadOwnedOrder(orderId, wholesalerId, context.isSuperAdmin);

    if (!order.courier_code || !order.tracking_number) {
      throw new RbacError("아직 등록된 운송장번호가 없습니다.");
    }

    const result = await fetchTrackingStatus(order.courier_code, order.tracking_number);

    return { success: true, data: result };
  } catch (error) {
    return toResult(error);
  }
}

export interface OrderItemPriceUpdateResult {
  unitPrice: number;
  subtotalAmount: number;
  orderTotalAmount: number;
}

/**
 * 전화로 흥정한 단가를 발주 품목에 실제로 반영한다(네고 32단계 완성).
 * 매출 단가라 매입단가와 동일하게 owner/manager만 고칠 수 있다.
 */
export async function updateOrderItemPriceAction(
  orderItemId: string,
  unitPrice: number
): Promise<ActionResult<OrderItemPriceUpdateResult>> {
  try {
    await requireOrgRole(["owner", "manager"]);

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new RbacError("단가를 올바르게 입력해주세요.");
    }

    const supabase = await createClient();

    const { data, error } = await supabase.rpc("update_order_item_price", {
      p_order_item_id: orderItemId,
      p_unit_price: unitPrice,
    });

    if (error) {
      if (error.message.includes("ITEM_NOT_FOUND")) {
        throw new RbacError("해당 발주 품목을 찾을 수 없습니다.");
      }

      if (error.message.includes("ORDER_LOCKED")) {
        throw new RbacError("이미 마감되었거나 확정 전 단계가 지난 발주서는 단가를 고칠 수 없습니다.");
      }

      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);

    const row = (data ?? {}) as Record<string, unknown>;

    return {
      success: true,
      data: {
        unitPrice: Number(row.unit_price ?? unitPrice),
        subtotalAmount: Number(row.subtotal_amount ?? 0),
        orderTotalAmount: Number(row.order_total_amount ?? 0),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}
