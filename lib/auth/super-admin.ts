/**
 * 플랫폼 슈퍼관리자 허용 계정 판별 (환경변수).
 *
 * SUPER_ADMIN_EMAIL 은 "누가 슈퍼관리자가 될 수 있는가"만 정하는 부트스트랩 입력이고,
 * "누가 슈퍼관리자인가"의 근거는 언제나 DB(profiles.role)다. 권한 판정을 환경변수로
 * 하면 배포 설정을 만질 수 있는 사람이 곧 관리자가 되고, RLS(모든 정책이
 * get_current_role() = 'super_admin' 을 본다)와 앱 판정이 어긋난다.
 *
 * NEXT_PUBLIC_ 접두사가 없으므로 이 값은 브라우저 번들에 포함되지 않는다.
 *
 * 이 모듈은 Edge 런타임(middleware)에서도 import 되므로 next/headers 등
 * Node 전용 API에 의존해서는 안 된다. (순수 env 판별만 수행)
 * 실제 승격은 Node 런타임의 lib/auth/super-admin-bootstrap.ts 가 담당한다.
 */

/** .env.example 의 자리표시자를 실제 설정으로 오인하지 않게 걸러낸다. */
const PLACEHOLDER_FRAGMENTS = ["your-", "yourdomain", "example.com", "changeme"];

/**
 * 허용된 슈퍼관리자 이메일 (소문자 정규화). 미설정이면 null.
 * 미설정은 "부트스트랩 비활성"이며, 이미 DB에 있는 슈퍼관리자에는 영향이 없다.
 */
export function getSuperAdminEmail(): string | null {
  // Next.js는 process.env.X 형태의 정적 접근만 번들에 인라인하므로 리터럴로 읽는다.
  const raw = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();

  if (!raw || !raw.includes("@")) {
    return null;
  }

  if (PLACEHOLDER_FRAGMENTS.some((fragment) => raw.includes(fragment))) {
    return null;
  }

  return raw;
}

/** 환경변수 부트스트랩이 설정되어 있는지 */
export function isSuperAdminBootstrapConfigured(): boolean {
  return getSuperAdminEmail() !== null;
}

/**
 * 세션 이메일이 허용 목록과 일치하는지.
 *
 * 이것만으로 관리자 권한을 부여하면 안 된다. 승격 트리거로만 쓰고,
 * 실제 접근 허용은 DB 승격 이후의 profiles.role 검사로 판정한다.
 */
export function isSuperAdminEmail(email: string | null | undefined): boolean {
  const allowed = getSuperAdminEmail();

  if (!allowed || !email) {
    return false;
  }

  return email.trim().toLowerCase() === allowed;
}
