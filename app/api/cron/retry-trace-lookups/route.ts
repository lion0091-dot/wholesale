import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { cacheTraceRecord } from "@/lib/livestock/master-cache";
import { fetchTraceRecord, isMtraceConfigured } from "@/lib/livestock/mtrace-client";

/**
 * 하루 1회(vercel.json의 crons) 이력조회에 실패한 채 남은 박스의 번호를 정부 이력조회로 다시 물어 공용 이력 캐시(master_livestock)에 채워 둔다.
 * 화면을 닫아 둔 밤 사이에 공급처가 번호를 등록했어도 아침에 입고 화면을 여는 순간 캐시에서 바로 읽혀, 정부 API를 또 부르지 않고
 * 상품 생성·재고 반영·전표 연결까지 이어진다(retryUnresolvedScansAction). 박스 자체는 여기서 바꾸지 않는다 —
 * 상품 생성·전표 연결·마감은 로그인한 직원 권한으로 도는 앱 경로에서만 한다.
 *
 * service_role로 전체 업체를 훑는다(크론은 RLS 경계를 넘는 배치). 같은 번호는 한 번만, 한 번에 30개까지 — 정부 API 호출 한도를 아낀다.
 */
export const runtime = "nodejs";

const BATCH = 30;
const RETRY_INTERVAL_HOURS = 20;

export async function GET(request: NextRequest) {
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

  if (!isMtraceConfigured()) {
    return NextResponse.json({ ok: true, skipped: "이력 조회 인증키가 없어 조회하지 않았습니다.", checked: 0, cached: 0 });
  }

  const supabase = createServiceRoleClient();

  if (!supabase) {
    return NextResponse.json({ error: "service_role 클라이언트를 생성할 수 없습니다." }, { status: 500 });
  }

  const cutoff = new Date(Date.now() - RETRY_INTERVAL_HOURS * 3_600_000).toISOString();

  const { data: rows, error } = await supabase
    .from("inbound_scans")
    .select("id, trace_no")
    .eq("status", "EXCEPTION")
    .or(`lookup_retried_at.is.null,lookup_retried_at.lt.${cutoff}`)
    .order("lookup_retried_at", { ascending: true, nullsFirst: true })
    .limit(BATCH * 3);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const scans = (rows ?? []) as Array<{ id: string; trace_no: string }>;
  const traceNos = [...new Set(scans.map((row) => row.trace_no))].slice(0, BATCH);
  const targetScanIds = scans.filter((row) => traceNos.includes(row.trace_no)).map((row) => row.id);

  let cached = 0;
  let failed = 0;

  for (const traceNo of traceNos) {
    try {
      const { data: existing } = await supabase.from("master_livestock").select("trace_no").eq("trace_no", traceNo).maybeSingle();

      if (existing) continue;

      const record = await fetchTraceRecord(traceNo);

      if (record) {
        await cacheTraceRecord(record);
        cached += 1;
      }
    } catch (fetchError) {
      failed += 1;
      console.error(`[cron/retry-trace-lookups] ${traceNo} 조회 실패:`, fetchError instanceof Error ? fetchError.message : fetchError);
    }
  }

  if (targetScanIds.length > 0) {
    await supabase.from("inbound_scans").update({ lookup_retried_at: new Date().toISOString() }).in("id", targetScanIds);
  }

  return NextResponse.json({ ok: true, checked: traceNos.length, cached, failed });
}
