import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { withCronHeartbeat } from "@/lib/cron/heartbeat";

/**
 * 하루 1회(vercel.json의 crons) 유효기간(30일)이 지났는데 아직 소진되지 않은
 * retailer_invites 행을 지운다 — 개인정보(손님 전화번호) 목적 달성 후
 * 보관 금지 원칙([[retailer-invite-espionage-risk]]).
 *
 * service_role로 전체 공급사의 초대를 훑는다 — RLS는 발부한 공급사 본인으로만
 * 좁혀주므로 크론처럼 경계를 넘는 배치에는 못 쓴다.
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

  const { data, error } = await supabase
    .from("retailer_invites")
    .delete()
    .lt("expires_at", new Date().toISOString())
    .is("consumed_at", null)
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: data?.length ?? 0 });
}

export const GET = withCronHeartbeat("expire-retailer-invites", handler);
