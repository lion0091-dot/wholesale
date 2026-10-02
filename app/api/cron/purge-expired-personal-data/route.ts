import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { withCronHeartbeat } from "@/lib/cron/heartbeat";

/**
 * 주 1회(vercel.json의 crons) 탈퇴 후 보관기간(5년, DB의 withdrawn_data_retention())이 지난
 * 공급사·고객의 개인정보를 파기한다. 파기 범위·제외(명세서 파일, 주문번호·금액·품목·이력번호)는
 * 마이그레이션 167의 purge_expired_withdrawn_personal_data()가 정한다 — 이 라우트는 호출하고,
 * DB가 돌려준 사업자등록증 파일을 Storage에서 함께 지운다.
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

  const { data, error } = await supabase.rpc("purge_expired_withdrawn_personal_data");

  if (error) {
    console.error("[cron purge-expired-personal-data] 파기 실패:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // DB에서는 이미 경로가 지워졌다 — Storage 삭제가 실패해도 다음 실행이 다시 찾을 방법이 없으므로 로그로 남긴다.
  const paths = ((data ?? []) as Array<{ license_path: string }>).map((row) => row.license_path);
  let storageFailed = 0;

  if (paths.length > 0) {
    const { error: removeError } = await supabase.storage.from("business-licenses").remove(paths);

    if (removeError) {
      console.error("[cron purge-expired-personal-data] 사업자등록증 파일 삭제 실패:", paths, removeError.message);
      storageFailed = paths.length;
    }
  }

  // 접속기록은 2년(DB의 access_log_retention())이 지나면 지운다.
  const { data: purgedLogs, error: logError } = await supabase.rpc("purge_old_access_logs");

  if (logError) {
    console.error("[cron purge-expired-personal-data] 접속기록 정리 실패:", logError.message);
  }

  return NextResponse.json({ licenseFiles: paths.length, storageFailed, accessLogsPurged: purgedLogs ?? 0 });
}

export const GET = withCronHeartbeat("purge-expired-personal-data", handler);
