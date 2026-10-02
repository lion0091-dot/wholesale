import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { withCronHeartbeat } from "@/lib/cron/heartbeat";

/**
 * 매일(vercel.json의 crons) 재고·박스·원장이 서로 맞는지 점검한다 — 마이그레이션 213의 stock_integrity_violations().
 * 상품 재고 ≠ 원장 합계, 박스 잔량 ≠ 박스 원장 합계, 입고 확정인데 원장 없음, 잔량 > 입고 중량, 취소 박스에 잔량,
 * 남은 박스 합계 > 상품 재고를 센다. 정상이면 전부 0이다.
 * 어긋남이 한 건이라도 있으면 500으로 끝내 크론 실행이 실패로 표시되고(자동 작업 상태 화면에 빨갛게 보임), 로그에 어느 점검인지 남는다.
 * 이 라우트는 읽기만 한다 — 입출고를 막지 않고, 고치는 일은 사람이 판단한다(docs/stock-integrity.md).
 */
export const runtime = "nodejs";

async function handler(request: NextRequest) {
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

  const { data, error } = await supabase.rpc("stock_integrity_violations");

  if (error) {
    console.error("[cron check-stock-integrity] 점검 실패:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ check_key: string; label: string; violations: number | string; sample_ids: string[] | null }>;
  const violated = rows
    .filter((row) => Number(row.violations) > 0)
    .map((row) => ({ check: row.check_key, label: row.label, violations: Number(row.violations), samples: row.sample_ids ?? [] }));

  if (violated.length > 0) {
    console.error("[cron check-stock-integrity] 재고·박스·원장 어긋남 감지:", JSON.stringify(violated));

    return NextResponse.json({ ok: false, checked: rows.length, violated }, { status: 500 });
  }

  return NextResponse.json({ ok: true, checked: rows.length });
}

export const GET = withCronHeartbeat("check-stock-integrity", handler);
