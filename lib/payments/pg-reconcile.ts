/**
 * PG 결제 승인 콜백이 끊겼을 때의 안전망 (2026-09-24).
 *
 * checkout/pg/success/route.ts는 "결제 확정 후에만 주문 생성" 원칙의 핵심 라우트지만,
 * 이 라우트 자체가 끝까지 실행되지 못하면(브라우저 강제종료, 서버 일시 오류 등) 토스는
 * 결제를 잡았는데(paymentKey는 몰라도 우리가 만든 orderId로 조회 가능) 우리 쪽엔 주문이
 * 전혀 안 남는다 — pg_pending_payments 마이그레이션 주석의 "방치해도 무해" 판단은
 * 이 경우를 놓쳤다(row 자체는 무해해도 결제 자체가 방치되면 안 됨).
 *
 * 두 지점에서 이 모듈을 쓴다:
 *   1. 고객이 자기 미니샵 주문내역을 다시 열 때(loadShopOrderHistoryPageAction) —
 *      대부분의 경우를 빠르게 잡는다.
 *   2. 매일 1회 크론(app/api/cron/reconcile-pg-payments) — 고객이 아예 다시 안 들어와도
 *      결국은 잡는다(Vercel Hobby가 크론 최소 주기 1일이라 이게 한계).
 */

import type { createClient } from "@/lib/supabase/server";
import { cancelPayment, getPaymentByOrderId, TossPaymentsError } from "./tosspayments-client";
import { decryptCredential, CredentialCryptoError } from "@/lib/security/credential-crypto";
import { loadPgSecretEncrypted } from "@/lib/security/wholesaler-credentials";
import { createOrderWithItems, buildOrderNumber } from "@/lib/orders/create-order";
import { sendOrderNotificationToWholesaler } from "@/lib/notifications/alimtalk";
import { composeProductDisplayName } from "@/lib/products/display-name";
import type { CartLine } from "@/lib/shop/order-policy";

// success/route.ts(쿠키 기반 세션 클라이언트)와 크론(service_role 클라이언트) 양쪽에서
// 쓰므로 둘의 공통 구조(.from/.rpc)만 필요하다 — 어느 한쪽 타입에 묶지 않는다.
type AnySupabase = Awaited<ReturnType<typeof createClient>>;

export interface PendingPgPaymentRow {
  id: string;
  pg_order_id: string;
  wholesaler_id: string;
  retailer_id: string;
  total_amount: number;
  cart_snapshot: CartLine[];
  restaurant_name: string;
  contact_phone: string;
  delivery_address: string;
  delivery_notes: string | null;
  negotiation_note: string | null;
  expires_at: string;
}

const PENDING_ROW_SELECT =
  "id, pg_order_id, wholesaler_id, retailer_id, total_amount, cart_snapshot, restaurant_name, contact_phone, delivery_address, delivery_notes, negotiation_note, expires_at";

export type FinalizePaidOrderResult =
  | { orderNumber: string }
  /** 주문을 못 만들었다. refunded=true면 결제는 자동 환불까지 끝난 상태(핫딜 매진). */
  | { error: string; refunded: boolean };

/** 같은 결제(pg_order_id)로 이미 만든 주문이 있으면 그 번호. 멱등 처리의 근거다. */
async function findOrderNumberByPgOrderId(supabase: AnySupabase, pgOrderId: string): Promise<string | null> {
  const { data } = await supabase
    .from("orders")
    .select("order_number")
    .eq("pg_order_id", pgOrderId)
    .maybeSingle();

  return (data?.order_number as string | undefined) ?? null;
}

/**
 * 결제 완료가 확인된 뒤 주문 생성 + 알림톡 발송까지 — success 콜백과 복구 경로가 공유한다.
 *
 * 멱등이다(2026-09-24 점검 3): 같은 결제로 이미 주문이 있으면 다시 만들지 않고 대기 행만
 * 치운다. 콜백이 주문을 만든 직후 대기 행 삭제만 실패하거나, 크론과 주문내역 재방문이
 * 같은 대기 행을 동시에 집는 경우가 실제로 있다. 그 검사 사이를 뚫는 동시 실행은
 * orders(pg_order_id) 유니크 인덱스(20260930000101)가 막고, 그 위반도 같은 방식으로 흡수한다.
 *
 * 핫딜 매진(reserve_hot_deal_quota 초과)이면 직접정산과 달리 이미 돈을 받은 뒤라 그냥
 * 실패로 둘 수 없다 — 즉시 자동 환불하고 대기 행을 지운다(사장님 확정, A안). 환불까지
 * 실패하면 대기 행을 남겨 재대조가 다음에 다시 시도하게 한다.
 */
export async function finalizePaidOrder(
  supabase: AnySupabase,
  pending: PendingPgPaymentRow,
  payment: { paymentKey: string; totalAmount: number; secretKey: string }
): Promise<FinalizePaidOrderResult> {
  // 0) 멱등: 이 결제로 만든 주문이 이미 있으면 대기 행만 정리하고 끝낸다(알림톡도 다시 안 보낸다).
  const existingOrderNumber = await findOrderNumberByPgOrderId(supabase, pending.pg_order_id);

  if (existingOrderNumber) {
    await supabase.from("pg_pending_payments").delete().eq("id", pending.id);
    return { orderNumber: existingOrderNumber };
  }

  const { data: wholesaler } = await supabase
    .from("wholesalers")
    .select("business_name, profile_id")
    .eq("id", pending.wholesaler_id)
    .maybeSingle();

  const orderNumber = buildOrderNumber();
  const lines = pending.cart_snapshot;

  const createResult = await createOrderWithItems(supabase, {
    wholesalerId: pending.wholesaler_id,
    retailerId: pending.retailer_id,
    orderNumber,
    totalAmount: payment.totalAmount,
    deliveryAddress: pending.delivery_address,
    deliveryNotes: pending.delivery_notes,
    paymentMethod: "pg",
    lines,
    negotiationNote: pending.negotiation_note,
    paymentStatus: "paid",
    pgPaymentKey: payment.paymentKey,
    pgOrderId: pending.pg_order_id,
  });

  if ("error" in createResult) {
    if (createResult.code === "DUPLICATE_PG_ORDER") {
      // 0)의 검사와 지금 사이에 다른 경로가 먼저 만들었다 — 유니크 인덱스가 막아줬다.
      const raced = await findOrderNumberByPgOrderId(supabase, pending.pg_order_id);

      if (raced) {
        await supabase.from("pg_pending_payments").delete().eq("id", pending.id);
        return { orderNumber: raced };
      }
    }

    if (createResult.code === "HOT_DEAL_QUOTA_EXCEEDED") {
      try {
        await cancelPayment({
          secretKey: payment.secretKey,
          paymentKey: payment.paymentKey,
          cancelReason: "핫딜 매진으로 자동 환불",
        });
      } catch (refundError) {
        console.error(
          "[pg] 핫딜 매진 자동 환불 실패 — 수동 환불 필요",
          pending.pg_order_id,
          payment.paymentKey,
          refundError instanceof Error ? refundError.message : refundError
        );

        // 대기 행을 남겨 재대조가 다음 기회에 환불을 다시 시도하게 한다.
        return {
          error:
            "핫딜이 방금 매진돼 발주를 접수하지 못했고, 자동 환불도 실패했습니다. 결제는 공급사가 확인 후 환불해드립니다. 공급사에 문의해주세요.",
          refunded: false,
        };
      }

      await supabase.from("pg_pending_payments").delete().eq("id", pending.id);

      return {
        error: "핫딜이 방금 매진돼 발주를 접수하지 못했습니다. 결제하신 금액은 자동으로 환불 처리됐습니다(카드사 사정에 따라 며칠 걸릴 수 있습니다).",
        refunded: true,
      };
    }

    return { error: createResult.error, refunded: false };
  }

  await supabase.from("pg_pending_payments").delete().eq("id", pending.id);

  const { data: profile } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", (wholesaler?.profile_id as string) ?? "")
    .maybeSingle();

  const [firstLine] = lines;
  const firstLineDisplayName = composeProductDisplayName(firstLine.category, firstLine.name);
  const itemsSummary =
    lines.length > 1
      ? `${firstLineDisplayName} ${firstLine.quantity}${firstLine.unit} 외 ${lines.length - 1}건`
      : `${firstLineDisplayName} ${firstLine.quantity}${firstLine.unit}`;

  await sendOrderNotificationToWholesaler({
    wholesalerId: pending.wholesaler_id,
    wholesalerName: (wholesaler?.business_name as string) ?? "",
    wholesalerPhone: (profile?.phone as string | undefined) ?? undefined,
    restaurantName: pending.restaurant_name,
    orderNumber,
    itemsSummary,
    totalAmount: payment.totalAmount,
    deliveryAddress: pending.delivery_address,
    deliveryNotes: pending.delivery_notes,
  });

  return { orderNumber };
}

export type ReconcileOutcome =
  | { outcome: "recovered"; orderNumber: string }
  | { outcome: "abandoned" }
  | { outcome: "still_processing" }
  | { outcome: "skipped" }
  /** 결제는 됐지만 핫딜 매진으로 주문을 못 만들어 자동 환불로 끝냈다. */
  | { outcome: "refunded" };

/**
 * 대기 중인 결제 한 건을 실제 토스 상태와 대조한다.
 *
 * - 토스가 "결제완료(DONE)"라고 하는데 우리 쪽엔 주문이 없으면 지금이라도 만든다(recovered).
 * - 결제 시도 자체가 없었거나 실패/만료였는데, 우리 쪽 만료시각(30분)도 지났으면
 *   대기 행만 치운다(abandoned) — 아직 30분 안이면 다른 탭에서 결제가 진행 중일 수
 *   있으니 건드리지 않는다(still_processing).
 * - 토스 조회 자체가 실패하거나(네트워크 등) 자격정보를 못 읽으면 다음 기회로 미룬다(skipped).
 */
export async function reconcilePendingPgPayment(
  supabase: AnySupabase,
  pending: PendingPgPaymentRow
): Promise<ReconcileOutcome> {
  const encryptedSecret = await loadPgSecretEncrypted(pending.wholesaler_id);

  if (!encryptedSecret) {
    return { outcome: "skipped" };
  }

  let secretKey: string;

  try {
    secretKey = decryptCredential(encryptedSecret);
  } catch (error) {
    if (error instanceof CredentialCryptoError) {
      return { outcome: "skipped" };
    }
    throw error;
  }

  let payment;

  try {
    payment = await getPaymentByOrderId({ secretKey, orderId: pending.pg_order_id });
  } catch (error) {
    if (error instanceof TossPaymentsError) {
      console.error("[pg-reconcile] 토스 결제조회 실패", pending.pg_order_id, error.message);
      return { outcome: "skipped" };
    }
    throw error;
  }

  if (payment === null || payment.status !== "DONE") {
    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await supabase.from("pg_pending_payments").delete().eq("id", pending.id);
      return { outcome: "abandoned" };
    }

    return { outcome: "still_processing" };
  }

  // 승인 콜백과 같은 원칙 — 토스가 말하는 금액이 아니라 우리가 저장해둔 기대 금액이 기준이다.
  // 다르다는 건 정상 흐름에서 생길 수 없는 신호라, 주문을 만들지 않고 기록만 남긴다.
  if (payment.totalAmount !== Number(pending.total_amount)) {
    console.error(
      "[pg-reconcile] 결제 금액 불일치 — 주문 생성 보류",
      pending.pg_order_id,
      { expected: Number(pending.total_amount), toss: payment.totalAmount }
    );
    return { outcome: "skipped" };
  }

  const result = await finalizePaidOrder(supabase, pending, {
    paymentKey: payment.paymentKey,
    totalAmount: payment.totalAmount,
    secretKey,
  });

  if ("error" in result) {
    if (result.refunded) {
      return { outcome: "refunded" };
    }

    // 돈은 이미 잡혔는데 주문 생성이 또 실패 — 대기 행은 남겨서 다음 기회에 재시도한다.
    console.error("[pg-reconcile] 복구 중 주문 생성 실패", pending.pg_order_id, result.error);
    return { outcome: "skipped" };
  }

  return { outcome: "recovered", orderNumber: result.orderNumber };
}

/**
 * 특정 거래처의 대기 결제 중 "3분 넘게 그대로인 것"만 골라 대조한다.
 *
 * 3분은 정식 만료시각(30분)보다 훨씬 짧다 — 페이지를 열 때마다 확인하되, 이제 막
 * 결제창을 연 다른 탭까지 건드리지 않기 위한 여유 시간이다(실제로 방치할지 여부는
 * reconcilePendingPgPayment 내부의 30분 기준이 따로 지킨다).
 */
const RECONCILE_STALE_AFTER_MS = 3 * 60 * 1000;

export async function reconcileStalePgPaymentsForRetailer(
  supabase: AnySupabase,
  wholesalerId: string,
  retailerId: string
): Promise<void> {
  const staleBefore = new Date(Date.now() - RECONCILE_STALE_AFTER_MS).toISOString();

  const { data } = await supabase
    .from("pg_pending_payments")
    .select(PENDING_ROW_SELECT)
    .eq("wholesaler_id", wholesalerId)
    .eq("retailer_id", retailerId)
    .lt("created_at", staleBefore);

  const rows = (data ?? []) as unknown as PendingPgPaymentRow[];

  for (const row of rows) {
    await reconcilePendingPgPayment(supabase, row);
  }
}
