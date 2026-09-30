import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";

/**
 * 하루 1회(vercel.json의 crons) 가입을 마치지 않고(약관·개인정보 동의 없이) 30일 넘게 이탈한
 * 계정을 삭제한다 — 개인정보처리방침 3조의 "미완료 계정 30일 뒤 삭제" 약속을 실제로 지키는 크론.
 *
 * 대상 판정은 DB 함수 list_stale_unconsented_accounts()(마이그레이션 165)가 한다 — 업체·고객·
 * 조직 직원·관리자 연결이 있는 계정은 애초에 대상이 아니다. 삭제는 Auth Admin API로만 한다
 * (auth 스키마를 SQL로 직접 지우지 않는다). profiles 행은 auth.users 삭제에 연쇄로 지워진다.
 *
 * 한 번에 지우는 수에 상한을 둔다 — 조건이 잘못됐을 때 피해가 한 번에 커지지 않게 하는 안전장치다.
 * 상한을 넘으면 그날은 상한만큼만 지우고 나머지는 다음 날로 넘어간다.
 */
export const runtime = "nodejs";

const MAX_DELETES_PER_RUN = 50;

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

  const supabase = createServiceRoleClient();

  if (!supabase) {
    return NextResponse.json({ error: "service_role 클라이언트를 생성할 수 없습니다." }, { status: 500 });
  }

  const { data, error } = await supabase.rpc("list_stale_unconsented_accounts");

  if (error) {
    console.error("[cron purge-unconsented-accounts] 대상 조회 실패:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 고객(소매) 미완료 계정 — 거래 흔적이 없는 것만(마이그레이션 166). 로그인과 동시에 만들어진
  // retailers 행이 auth.users 삭제를 막으므로(RESTRICT), 대상 재검증 후 그 행을 먼저 지운다.
  const { data: retailData, error: retailError } = await supabase.rpc("list_stale_unconsented_retail_accounts");

  if (retailError) {
    console.error("[cron purge-unconsented-accounts] 고객 대상 조회 실패:", retailError.message);
    return NextResponse.json({ error: retailError.message }, { status: 500 });
  }

  const supplierCandidates = ((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id);
  const retailCandidates = ((retailData ?? []) as Array<{ user_id: string }>).map((row) => row.user_id);
  const candidates = [...supplierCandidates, ...retailCandidates];
  const retailSet = new Set(retailCandidates);
  const targets = candidates.slice(0, MAX_DELETES_PER_RUN);
  let deleted = 0;
  let failed = 0;

  for (const userId of targets) {
    if (retailSet.has(userId)) {
      const { data: removed, error: rowError } = await supabase.rpc("delete_stale_retailer_rows", {
        p_user_id: userId,
      });

      if (rowError || !removed) {
        // 조회 이후 거래 흔적이 생겼으면 0을 돌려받는다 — 건드리지 않고 넘어간다.
        if (rowError) console.error("[cron purge-unconsented-accounts] 고객 행 삭제 실패:", userId, rowError.message);
        failed += 1;
        continue;
      }
    }

    const { error: deleteError } = await supabase.auth.admin.deleteUser(userId);

    if (deleteError) {
      // 외래키 RESTRICT 등으로 막힌 계정은 건너뛴다(사업 데이터가 걸려 있다는 뜻).
      console.error("[cron purge-unconsented-accounts] 삭제 실패:", userId, deleteError.message);
      failed += 1;
      continue;
    }

    deleted += 1;
  }

  return NextResponse.json({
    candidates: candidates.length,
    deleted,
    failed,
    deferred: candidates.length - targets.length,
  });
}
