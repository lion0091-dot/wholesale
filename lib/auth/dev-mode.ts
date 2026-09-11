/**
 * 개발/테스트 환경 전용 조직 가드 우회 플래그.
 *
 * 이 모듈은 Edge 런타임(middleware)에서도 import되므로 next/headers 등
 * Node 전용 API에 의존해서는 안 된다. (순수 env 판별만 수행)
 */

/** 개발 환경에서 자동 생성/연결하는 기본 테스트 조직 식별 정보 */
export const DEFAULT_DEV_ORGANIZATION_NAME = "Default Organization";

/** 실제 사업자번호와 충돌하지 않는 더미 10자리 (체크섬 무효 — 운영 데이터와 구분됨) */
export const DEFAULT_DEV_BUSINESS_NUMBER = "0000000000";

/**
 * 조직(organization_staff) 미소속 계정에게 백오피스 접근을 허용할지 여부.
 *
 * - 프로덕션 빌드(NODE_ENV=production)에서는 플래그 값과 무관하게 항상 false.
 *   → 운영 환경에서는 조직 세션 바인딩 가드가 절대 느슨해지지 않는다.
 * - 개발/테스트에서는 기본 활성. `DEV_ALLOW_ORG_BYPASS=0`으로 끌 수 있다.
 */
export function isDevOrgBypassEnabled(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  // Next.js는 process.env.X 형태의 정적 접근만 번들에 인라인하므로 리터럴로 읽는다.
  const flag = process.env.DEV_ALLOW_ORG_BYPASS?.trim().toLowerCase();

  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }

  return true;
}
