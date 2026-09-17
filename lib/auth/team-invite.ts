/**
 * 공급사(도매업체) 자체 직원 초대 수락 — 카카오 OAuth 전용 채널.
 *
 * 흐름: owner/manager가 초대 링크(/join-team/<token>) 생성 → 직원이 그 링크를 열고
 * [카카오로 시작하기] → /auth/callback?intent=team&invite_token=<token> →
 * claim_organization_staff_invite() RPC로 organization_staff에 자동 등록.
 *
 * 서버 전용 모듈(next/headers 의존, lib/auth/buyer-auth.ts의 resolveSiteOrigin 재사용).
 */

import { resolveSiteOrigin } from "@/lib/auth/buyer-auth";

export const TEAM_INVITE_INTENT = "team";

/** 초대 수락 성공 후 도착지 */
export const TEAM_INVITE_LANDING_PATH = "/dashboard";

export { resolveSiteOrigin };

export class TeamInviteError extends Error {
  readonly code: TeamInviteErrorCode;

  constructor(code: TeamInviteErrorCode, message: string) {
    super(message);
    this.name = "TeamInviteError";
    this.code = code;
  }
}

export type TeamInviteErrorCode = "auth_required" | "invalid_invite" | "not_eligible";

/** claim_organization_staff_invite() RPC가 올리는 예외 코드 → 사용자 안내 문구 */
const CLAIM_ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: "로그인이 필요합니다.",
  INVALID_OR_EXPIRED_INVITE: "유효하지 않거나 만료된 초대 링크입니다. 초대한 담당자에게 새 링크를 요청해주세요.",
  RETAILER_CANNOT_JOIN_STAFF:
    "이미 바이어(구매 회원)로 가입된 카카오 계정입니다. 다른 카카오 계정으로 다시 시도해주세요.",
  ALREADY_STAFF_ELSEWHERE: "이미 다른 업체의 직원으로 등록된 계정입니다.",
  WHOLESALER_OWNER_CANNOT_JOIN_AS_STAFF:
    "본인 명의로 가입된 업체가 있어 다른 업체의 직원으로 등록할 수 없습니다.",
};

export function toTeamInviteError(
  message: string | null | undefined,
  fallback: string
): TeamInviteError {
  const matched = Object.keys(CLAIM_ERROR_MESSAGES).find((code) =>
    (message ?? "").includes(code)
  );

  if (!matched) {
    return new TeamInviteError("not_eligible", fallback);
  }

  const code: TeamInviteErrorCode =
    matched === "AUTH_REQUIRED"
      ? "auth_required"
      : matched === "INVALID_OR_EXPIRED_INVITE"
        ? "invalid_invite"
        : "not_eligible";

  return new TeamInviteError(code, CLAIM_ERROR_MESSAGES[matched]);
}
