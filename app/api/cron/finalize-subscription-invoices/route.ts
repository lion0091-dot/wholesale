import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { computeInvoicesForMonth } from "@/lib/supplier/subscription-invoices";

/**
 * 매달 1일 새벽(vercel.json의 crons) "방금 끝난 달"의 구독료 청구서를 확정(스냅샷)해서
 * platform_subscription_invoices에 저장하는 배치. 한 번 저장된 청구서는 이 크론이
 * 다시 건드리지 않는다(멱등 — 이미 그 달 행이 있는 공급사는 건너뜀) 관리자가 화면에서
 * 수납 처리한 내역을 재실행이 덮어쓰지 않게 하기 위함이다.
 */
export const runtime = "nodejs";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** "지금"이 속한 달의 바로 전 달 키('YYYY-MM', KST 기준). 매월 1일 실행 전용. */
function previousMonthKeyKst(): string {
  const kstNow = new Date(Date.now() + KST_OFFSET_MS);
  const prevMonth = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth() - 1, 1));

  return `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function GET(request: NextRequest) {
  // CRON_SECRET이 없으면 누구나 호출할 수 있는 상태라 실행 자체를 거부한다(2026-09-24 점검 3).
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

  const billingMonth = previousMonthKeyKst();
  const billingMonthDate = `${billingMonth}-01`;

  const [{ data: wholesalers, error: wholesalersError }, { data: existing, error: existingError }] =
    await Promise.all([
      supabase.from("wholesalers").select("id, billing_starts_at"),
      supabase.from("platform_subscription_invoices").select("wholesaler_id").eq("billing_month", billingMonthDate),
    ]);

  if (wholesalersError) {
    return NextResponse.json({ error: wholesalersError.message }, { status: 500 });
  }

  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }

  const alreadyFinalized = new Set(
    ((existing ?? []) as Array<{ wholesaler_id: string }>).map((row) => row.wholesaler_id)
  );

  const targets = ((wholesalers ?? []) as Array<{ id: string; billing_starts_at: string | null }>).filter(
    (wholesaler) => !alreadyFinalized.has(wholesaler.id)
  );

  const computed = await computeInvoicesForMonth(supabase, targets, billingMonth);

  if (computed.length === 0) {
    return NextResponse.json({ billingMonth, finalized: 0, skippedAlreadyFinalized: alreadyFinalized.size });
  }

  const { error: insertError } = await supabase.from("platform_subscription_invoices").insert(
    computed.map((invoice) => ({
      wholesaler_id: invoice.wholesalerId,
      billing_month: billingMonthDate,
      billed_retailer_count: invoice.billedRetailerCount,
      full_month_fee: invoice.fullMonthFee,
      amount: invoice.amount,
    }))
  );

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ billingMonth, finalized: computed.length, skippedAlreadyFinalized: alreadyFinalized.size });
}
