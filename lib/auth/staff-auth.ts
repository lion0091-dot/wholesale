/**
 * 내부 스태프 로그인 — 공급사와 같은 카카오 OAuth 채널을 쓰되, 온보딩(업체 등록)으로
 * 보내지 않는 별도 진입점.
 *
 * 인증 흐름:
 *   /staff-login 진입 (공개 UI에 노출 안 함 — 사내에만 링크 공유)
 *     → Supabase Auth 카카오 OAuth
 *     → auth.users 생성 시 DB 트리거(handle_new_user)가 profiles 기본 레코드를
 *        (role='wholesaler', is_supplier=true, is_verified=false) 로 생성한다.
 *        트리거는 auth.users INSERT 시점에만 반응하고 intent 를 알 방법이 없으므로
 *        이 값 자체는 공급사 가입과 동일하다 — 바꿀 수 없고, 바꾸려 하지 않는다.
 *     → /auth/callback?intent=staff 는 이 계정을 SUPPLIER_ONBOARDING_PATH로 보내지
 *        않는다. 그 결과 wholesalers row가 생기지 않는데, 이게 핵심이다:
 *        "wholesalers row 없음 + is_verified=false" = 실제 입점 신청자가 아니라
 *        관리자 승격 후보라는 신호로 app/admin/admins/actions.ts 검색 쿼리가 사용한다.
 *     → STAFF_PENDING_PATH(중립 안내 화면)에서 대기. 실제 관리자 승격은 여전히
 *        /admin/admins 에서 can_grant 보유자가 수행해야 한다 — 이 흐름 자체는
 *        아무 권한도 주지 않는다.
 *
 * CLAUDE.md의 "이메일 사전등록 미지원" 결정과 충돌하지 않는다 — 이 흐름은 가입을
 * 앞당기지 않고, 가입 "이후" 도착 화면만 공급사 온보딩과 다르게 바꿀 뿐이다.
 */

export const STAFF_INTENT = "staff";

/** 카카오 OAuth provider 식별자. buyer-auth.ts/supplier-auth.ts와 동일 값을 그대로 둔다
 *  (기존 두 파일도 서로 재수출하지 않고 각자 상수를 복제해 둔 것과 같은 관례). */
export const KAKAO_PROVIDER = "kakao";

/** OAuth 왕복 후 되돌아올 콜백 경로 */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/** 요청 접수 후 도착하는 중립 안내 화면. 승인 전엔 이 밖으로 안 내보낸다. */
export const STAFF_PENDING_PATH = "/staff-login/pending";
