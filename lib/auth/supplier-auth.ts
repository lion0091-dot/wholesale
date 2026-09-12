/**
 * 공급사(도매) 인증 — 바이어와 동일한 카카오 OAuth 단일 채널.
 *
 * 인증 흐름:
 *   /login 진입 → [카카오로 3초 시작하기]
 *     → Supabase Auth 카카오 OAuth
 *     → auth.users 생성 시 DB 트리거(handle_new_user)가 profiles 기본 레코드를
 *        (is_supplier = true, is_verified = false) 로 즉시 생성
 *     → /auth/callback?intent=supplier 에서 세션 확립
 *     → 최소 정보(약관 동의 + 연락처 + 상호) 미입력이면 /onboarding
 *     → 입력 완료 시 즉시 백오피스 사용 시작 (승인 대기 없음)
 *
 * 이메일/비밀번호 가입은 폐기했다. 공급사와 바이어가 서로 다른 인증 채널을 쓰면
 * 계정 관리 비용이 두 배가 되고, 비밀번호 재설정 문의가 현장 이탈의 1순위였다.
 *
 * 서버 전용 모듈(next/headers 의존).
 */

import { resolveSiteOrigin } from "@/lib/auth/buyer-auth";

export const KAKAO_PROVIDER = "kakao";

/** OAuth 왕복 후 되돌아올 콜백 경로 (바이어와 공용) */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/** 콜백에서 공급사 경로임을 구분하는 값 (?intent=supplier) */
export const SUPPLIER_INTENT = "supplier";

/** 최소 정보 입력 화면 */
export const SUPPLIER_ONBOARDING_PATH = "/onboarding";

/** 최소 정보 입력을 마친 공급사의 기본 도착지 */
export const SUPPLIER_LANDING_PATH = "/dashboard";

export { resolveSiteOrigin };

/** 사용자에게 그대로 보여줄 안내 문구를 담은 공급사 인증/권한 오류 */
export class SupplierAuthError extends Error {
  readonly code: SupplierAuthErrorCode;

  constructor(code: SupplierAuthErrorCode, message: string) {
    super(message);
    this.name = "SupplierAuthError";
    this.code = code;
  }
}

export type SupplierAuthErrorCode =
  | "auth_required"
  | "not_a_supplier"
  | "not_verified"
  | "invalid_input"
  | "signup_failed";

/**
 * 로그인 후 복귀 경로 검증.
 * 오픈 리다이렉트와 리다이렉트 루프를 막기 위해 내부 절대 경로만 허용하고,
 * 바이어 미니샵(/shop/*)은 공급사 세션으로 들어갈 수 없으므로 제외한다.
 */
export function sanitizeSupplierReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/")) {
    return null;
  }

  // "//host", "/\host" → 프로토콜 상대 URL(외부 도메인)로 해석될 수 있다.
  if (raw.startsWith("//") || raw.includes("\\")) {
    return null;
  }

  const path = raw.split("?")[0].split("#")[0];

  if (path === "/login" || path.startsWith("/login/")) {
    return null;
  }

  if (path === "/shop" || path.startsWith("/shop/")) {
    return null;
  }

  if (path === "/auth" || path.startsWith("/auth/")) {
    return null;
  }

  return raw;
}

/** DB 함수가 올리는 예외 코드 → 사용자 안내 문구 */
const SIGNUP_ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: "로그인이 필요합니다. 카카오 로그인을 다시 시도해주세요.",
  NOT_A_SUPPLIER_ACCOUNT:
    "이미 바이어(구매 회원)로 가입된 카카오 계정입니다. 공급사 가입은 다른 카카오 계정으로 진행해주세요.",
  INVALID_BUSINESS_NAME: "상호(업체명)를 2자 이상 입력해주세요.",
  INVALID_REPRESENTATIVE_NAME: "담당자(대표자) 성명을 입력해주세요.",
  INVALID_PHONE: "연락처를 숫자 9자리 이상으로 정확히 입력해주세요.",
  INVALID_BUSINESS_NUMBER: "사업자등록번호 10자리를 정확히 입력해주세요.",
  DUPLICATE_BUSINESS_NUMBER: "이미 등록된 사업자등록번호입니다. 플랫폼 운영팀에 문의해주세요.",
  SUPPLIER_NOT_FOUND: "공급사 정보가 아직 등록되지 않았습니다. 최소 정보 입력을 먼저 완료해주세요.",
  ALREADY_VERIFIED: "이미 승인이 완료된 업체입니다. 사업자 정보 변경은 운영팀에 문의해주세요.",
  SUPER_ADMIN_REQUIRED: "플랫폼 슈퍼관리자만 수행할 수 있는 작업입니다.",
};

/** RPC 오류 메시지에서 코드를 찾아 안내 문구로 바꾼다. */
export function toSupplierAuthError(
  message: string | null | undefined,
  fallback: string
): SupplierAuthError {
  const matched = Object.keys(SIGNUP_ERROR_MESSAGES).find((code) =>
    (message ?? "").includes(code)
  );

  if (!matched) {
    return new SupplierAuthError("signup_failed", fallback);
  }

  const code: SupplierAuthErrorCode =
    matched === "AUTH_REQUIRED"
      ? "auth_required"
      : matched === "NOT_A_SUPPLIER_ACCOUNT"
        ? "not_a_supplier"
        : "invalid_input";

  return new SupplierAuthError(code, SIGNUP_ERROR_MESSAGES[matched]);
}
