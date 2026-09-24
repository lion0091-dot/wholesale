/**
 * 공급사 외부연동 자격정보(알림톡 계정·암호화 비밀번호, 토스 시크릿키 등) 접근.
 *
 * 마이그레이션 110부터 이 컬럼들은 anon/authenticated가 못 읽는다(연결 거래처·직원에게 노출되던 구멍).
 * 그래서 서버 코드는 호출 전에 권한(소유 공급사·역할)을 직접 확인한 뒤 이 모듈로 service_role로 읽고 쓴다.
 * 서버 전용 — 클라이언트 번들에 포함되면 안 된다.
 */

import { createServiceRoleClient } from "@/lib/supabase/service-role-client";

const NO_SERVICE_ROLE = "서버 설정(SUPABASE_SERVICE_ROLE_KEY)이 없어 처리할 수 없습니다.";

export async function readWholesalerCredentials(
  wholesalerId: string,
  columns: string
): Promise<{ data: Record<string, unknown> | null; error: string | null }> {
  const supabase = createServiceRoleClient();

  if (!supabase) {
    return { data: null, error: NO_SERVICE_ROLE };
  }

  const { data, error } = await supabase
    .from("wholesalers")
    .select(columns)
    .eq("id", wholesalerId)
    .maybeSingle();

  return { data: (data as unknown as Record<string, unknown> | null) ?? null, error: error?.message ?? null };
}

export async function updateWholesalerCredentials(
  wholesalerId: string,
  updates: Record<string, unknown>
): Promise<{ error: string | null }> {
  const supabase = createServiceRoleClient();

  if (!supabase) {
    return { error: NO_SERVICE_ROLE };
  }

  const { data, error } = await supabase
    .from("wholesalers")
    .update(updates)
    .eq("id", wholesalerId)
    .select("id");

  if (error) {
    return { error: error.message };
  }

  if (!data || data.length === 0) {
    return { error: "업체 정보를 찾을 수 없습니다." };
  }

  return { error: null };
}

export async function loadPgSecretEncrypted(wholesalerId: string): Promise<string | null> {
  const { data } = await readWholesalerCredentials(wholesalerId, "pg_secret_key_encrypted");

  return (data?.pg_secret_key_encrypted as string | null | undefined) ?? null;
}
