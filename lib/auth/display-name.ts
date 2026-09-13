/**
 * 화면에 표시할 계정 이름 해석.
 *
 * 카카오 계정은 이메일 동의항목을 주지 않을 수 있어 auth.users.email 이 비어 있다.
 * 따라서 표시 라벨은 이메일이 아니라 아래 우선순위로만 결정한다.
 *
 *   1) profiles.name        — 앱이 보유한 정식 이름 (가입 트리거가 항상 채운다)
 *   2) 카카오 닉네임        — user_metadata (프로바이더 페이로드)
 *   3) "사용자"             — 일반 폴백
 *
 * 이메일은 어떤 단계에서도 참조하지 않는다. 이메일 부재를 '미인증'이나 '데모 모드'로
 * 표시하면 정상 로그인한 이메일 없는 카카오 사용자가 미인증으로 보인다.
 *
 * Edge/클라이언트 어디서든 쓸 수 있는 순수 함수다 (런타임 의존 없음).
 */

/**
 * 카카오 닉네임 후보 키.
 *
 * Supabase 의 카카오 프로바이더가 실제로 어느 키를 채우는지는 계정/동의항목에 따라
 * 갈리므로(GoTrue 는 nickname 을 name 계열로 매핑한다) 관측되는 키를 모두 훑는다.
 * 없는 키는 그냥 건너뛰므로 후보를 늘려도 부작용이 없다.
 */
const NICKNAME_KEYS = [
  "nickname",
  "name",
  "full_name",
  "preferred_username",
  "user_name",
] as const;

/** 이름을 전혀 알 수 없을 때 쓰는 라벨 */
export const FALLBACK_DISPLAY_NAME = "사용자";

/** 공백만 있는 값은 이름이 아니다 — 다음 후보로 넘긴다. */
function firstNonBlank(...candidates: Array<unknown>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();

    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

/** user_metadata 에서 카카오 닉네임을 꺼낸다. 없으면 null. */
export function resolveKakaoNickname(
  userMetadata: Record<string, unknown> | null | undefined
): string | null {
  if (!userMetadata) {
    return null;
  }

  return firstNonBlank(...NICKNAME_KEYS.map((key) => userMetadata[key]));
}

/**
 * 표시 이름을 해석한다. 항상 비어 있지 않은 문자열을 반환한다.
 *
 * @param profileName  profiles.name (없거나 공백이면 다음 후보로 넘어간다)
 * @param userMetadata Supabase user.user_metadata
 */
export function resolveDisplayName(
  profileName: string | null | undefined,
  userMetadata?: Record<string, unknown> | null
): string {
  return (
    firstNonBlank(profileName) ??
    resolveKakaoNickname(userMetadata) ??
    FALLBACK_DISPLAY_NAME
  );
}
