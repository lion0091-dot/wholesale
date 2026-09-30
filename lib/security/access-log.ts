/**
 * 접속기록(누가·언제·어디서·무엇을) 서버 기록 — 마이그레이션 171의 access_log.
 *
 * 개인정보의 안전성 확보조치 기준상 접속기록을 남기고 보관하기 위한 것이다. 기록 실패가 로그인·화면
 * 진입을 막으면 안 되므로 오류는 삼키고 서버 로그에만 남긴다. 쓰기는 service_role만 가능하다.
 *
 * 서버 전용 모듈(SUPABASE_SERVICE_ROLE_KEY 참조).
 */

import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";

export type AccessEvent = "login" | "admin_area_entry";

export async function recordAccess(userId: string | null | undefined, event: AccessEvent): Promise<void> {
  try {
    const supabase = createServiceRoleClient();

    if (!supabase) {
      return;
    }

    const requestHeaders = await headers();
    const forwarded = requestHeaders.get("x-forwarded-for");
    const ip = forwarded ? forwarded.split(",")[0]?.trim() : requestHeaders.get("x-real-ip");
    const userAgent = requestHeaders.get("user-agent");

    const { error } = await supabase.from("access_log").insert({
      user_id: userId ?? null,
      event,
      ip: ip || null,
      user_agent: userAgent ? userAgent.slice(0, 300) : null,
    });

    if (error) {
      console.error("[access-log] 기록 실패:", error.message);
    }
  } catch (error) {
    console.error("[access-log] 기록 중 예외:", error instanceof Error ? error.message : error);
  }
}
