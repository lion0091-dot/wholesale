import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import {
  DEFAULT_DEV_BUSINESS_NUMBER,
  DEFAULT_DEV_ORGANIZATION_NAME,
  isDevOrgBypassEnabled,
} from "@/lib/auth/dev-mode";

/**
 * 개발/테스트 환경에서 조직 미소속 계정을 기본 테스트 조직에 자동 연결한다.
 * (Node 런타임 전용 — 로그인 서버 액션 및 온보딩 화면에서 호출)
 *
 * 프로덕션 빌드에서는 isDevOrgBypassEnabled()가 항상 false이므로 즉시 no-op이다.
 */

export type DevOrgStatus =
  /** 프로덕션 빌드 또는 플래그 비활성 */
  | "disabled"
  /** Supabase 미설정(데모 모드) 또는 미인증 */
  | "skipped"
  /** 이미 조직에 소속되어 있음 */
  | "already-linked"
  /** 기본 테스트 조직에 새로 연결 완료 */
  | "linked"
  /** 연결 시도했으나 실패 (권한/RLS 등) */
  | "failed";

export interface DevOrgResult {
  status: DevOrgStatus;
  organizationId: string | null;
  /** 실패/스킵 사유 (개발자에게 노출할 안내 문구) */
  reason?: string;
}

// 기본 테스트 조직은 RLS(소속 직원만 조회 가능, 직원 없는 조직에만 self-bootstrap 허용)에
// 걸리기 때문에, service_role 키가 있으면 이를 경유해야 여러 테스트 계정을 같은 조직에
// 붙일 수 있다. 클라이언트 생성 자체는 lib/supabase/service-role-client.ts 공용 헬퍼를 쓴다.

export async function ensureDevDefaultOrganization(): Promise<DevOrgResult> {
  if (!isDevOrgBypassEnabled()) {
    return { status: "disabled", organizationId: null };
  }

  if (!isSupabaseConfigured()) {
    return {
      status: "skipped",
      organizationId: null,
      reason: "Supabase 환경변수가 설정되지 않았습니다 (데모 모드).",
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { status: "skipped", organizationId: null, reason: "로그인 세션이 없습니다." };
  }

  const { data: existingStaff } = await supabase
    .from("organization_staff")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingStaff?.organization_id) {
    return {
      status: "already-linked",
      organizationId: String(existingStaff.organization_id),
    };
  }

  // RLS를 우회할 수 있으면 admin, 아니면 사용자 클라이언트로 best-effort 시도
  const admin = createServiceRoleClient();
  const writer: SupabaseClient = admin ?? (supabase as unknown as SupabaseClient);

  // 1) 기본 테스트 조직 조회
  const { data: existingOrg } = await writer
    .from("organizations")
    .select("id")
    .eq("business_number", DEFAULT_DEV_BUSINESS_NUMBER)
    .maybeSingle();

  let organizationId = existingOrg?.id ? String(existingOrg.id) : null;

  // 2) 없으면 생성 — 이 계정의 레거시 wholesalers 레코드가 있으면 함께 연결해
  //    /dashboard/products 등이 실제 스코프 데이터를 읽을 수 있게 한다.
  if (!organizationId) {
    const { data: wholesaler } = await writer
      .from("wholesalers")
      .select("id")
      .eq("profile_id", user.id)
      .maybeSingle();

    const { data: created, error: createError } = await writer
      .from("organizations")
      .insert({
        wholesaler_id: wholesaler?.id ?? null,
        name: DEFAULT_DEV_ORGANIZATION_NAME,
        business_number: DEFAULT_DEV_BUSINESS_NUMBER,
        representative_name: "개발 테스트",
        subscription_tier: "pro",
      })
      .select("id")
      .maybeSingle();

    if (createError || !created?.id) {
      return {
        status: "failed",
        organizationId: null,
        reason: admin
          ? `기본 테스트 조직 생성 실패: ${createError?.message ?? "알 수 없는 오류"}`
          : "기본 테스트 조직을 만들 권한이 없습니다. SUPABASE_SERVICE_ROLE_KEY를 설정하거나 온보딩 화면에서 조직을 직접 생성하세요.",
      };
    }

    organizationId = String(created.id);
  }

  // 3) 본인을 owner로 등록
  const { error: staffError } = await writer.from("organization_staff").insert({
    organization_id: organizationId,
    user_id: user.id,
    role: "owner",
  });

  if (staffError) {
    return {
      status: "failed",
      organizationId,
      reason: admin
        ? `기본 테스트 조직 연결 실패: ${staffError.message}`
        : "기본 테스트 조직에 이미 다른 계정이 소속되어 있어 RLS로 연결이 차단되었습니다. SUPABASE_SERVICE_ROLE_KEY를 설정하세요.",
    };
  }

  return { status: "linked", organizationId };
}
