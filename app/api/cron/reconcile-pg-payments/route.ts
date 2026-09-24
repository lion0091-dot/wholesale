import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { reconcilePendingPgPayment, type PendingPgPaymentRow } from "@/lib/payments/pg-reconcile";

/**
 * 하루 1회(vercel.json의 crons) 대기 중인 PG 결제를 전부 훑어 토스 실제 상태와
 * 대조한다. 고객이 결제 후 미니샵에 다시 안 들어와도(loadShopOrderHistoryPageAction의
 * 즉시 확인을 안 타는 경우) 결국은 이 크론이 잡는다 — lib/payments/pg-reconcile.ts
 * 상단 설명 참고. Vercel Hobby 플랜은 크론 최소 주기가 1일이라 최악의 경우 최대
 * 하루 정도 지연될 수 있다.
 *
 * service_role로 전체 공급사의 pg_pending_payments를 훑는다 — RLS는 거래처
 * 본인/해당 공급사로만 좁혀주므로 크론처럼 경계를 넘는 배치에는 못 쓴다.
 */
export const runtime = "nodejs";

const PENDING_ROW_SELECT =
  "id, pg_order_id, wholesaler_id, retailer_id, total_amount, cart_snapshot, restaurant_name, contact_phone, delivery_address, delivery_notes, negotiation_note, expires_at";

export async function GET(request: NextRequest) {
  // CRON_SECRET이 없으면 누구나 호출할 수 있는 상태라 실행 자체를 거부한다(2026-09-24 점검 3).
  // Vercel은 이 환경변수가 있으면 크론 호출에 Authorization: Bearer <CRON_SECRET>을 자동으로 붙인다.
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET 환경변수가 설정되지 않아 크론 실행을 거부합니다. Vercel 환경변수에 등록해주세요." },
      { status: 500 }
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  if (!supabase) {
    return NextResponse.json({ error: "service_role 클라이언트를 생성할 수 없습니다." }, { status: 500 });
  }

  const { data, error } = await supabase.from("pg_pending_payments").select(PENDING_ROW_SELECT);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as PendingPgPaymentRow[];
  const counts = { recovered: 0, abandoned: 0, still_processing: 0, skipped: 0, refunded: 0 };

  for (const row of rows) {
    try {
      const result = await reconcilePendingPgPayment(supabase, row);
      counts[result.outcome] += 1;
    } catch (unexpected) {
      console.error("[cron reconcile-pg-payments]", row.pg_order_id, unexpected);
      counts.skipped += 1;
    }
  }

  return NextResponse.json({ total: rows.length, ...counts });
}
