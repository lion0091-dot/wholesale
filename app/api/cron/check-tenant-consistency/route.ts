import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { withCronHeartbeat } from "@/lib/cron/heartbeat";

/**
 * 매일(vercel.json의 crons) 공급사 간 데이터 섞임을 점검한다 — 마이그레이션 200의 tenant_consistency_violations().
 * 상품·박스·재고 원장·맞춤단가·발주 줄 등이 다른 공급사 소유 행을 가리키는 경우를 센다. 정상이면 전부 0이다.
 * 섞임이 한 건이라도 있으면 500으로 끝내 Vercel 크론 실행이 실패로 표시되고, 로그에 어느 참조인지 남는다.
 * 이 라우트는 읽기만 한다 — 고치는 일은 사람이 판단한다(docs/tenant-isolation-runbook.md).
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

  const { data, error } = await supabase.rpc("tenant_consistency_violations");

  if (error) {
    console.error("[cron check-tenant-consistency] 점검 실패:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ ref: string; violations: number | string }>;
  const violated = rows.filter((row) => Number(row.violations) > 0).map((row) => ({ ref: row.ref, violations: Number(row.violations) }));

  if (violated.length > 0) {
    console.error("[cron check-tenant-consistency] 공급사 간 데이터 섞임 감지:", JSON.stringify(violated));

    return NextResponse.json({ ok: false, checked: rows.length, violated }, { status: 500 });
  }

  return NextResponse.json({ ok: true, checked: rows.length });
}

export const GET = withCronHeartbeat("check-tenant-consistency", handler);
