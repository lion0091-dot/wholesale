# 내부 스태프 로그인 분리 (signup_channel)

[platform-admin-allowlist.md](./platform-admin-allowlist.md) 롤아웃 작업 중, 플랫폼 운영사 직원을 어드민 후보로 올리는 흐름을 테스트하다가 발견한 문제: `/admin/admins` 후보 검색과 `/admin/suppliers` 승인 대기 목록이 **같은 신호**(`profiles.is_verified = false`)를 근거로 삼아서, 실제 입점 심사 대기 중인 외부 공급사가 관리자 승격 후보 검색에도 같이 뜰 수 있었다(반대로 스태프가 실수로 온보딩을 끝내면 승인 대기 목록에도 섞임). platform-admin-allowlist 롤아웃의 5단계와는 별개 문제이지만 같은 브랜치에서 같이 해결함.

- **진입점 분리**: `/login`(공급사, `intent=supplier`) vs `/staff-login`(내부 스태프, `intent=staff`) — `app/auth/callback/route.ts`가 쿼리스트링으로 분기. **URL 분리는 보안 경계가 아니다** — `intent` 값은 클라이언트가 보내는 값이라 위조 가능, 아무나 `/staff-login`으로 들어와도 얻는 권한은 없음(실제 승격은 여전히 `/admin/admins`에서 사람이 수동으로). 필요시 공유 암호(작은 작업)나 개인별 초대코드(큰 작업, 새 테이블+CRUD UI 필요) 게이트를 얹을 수 있음 — **아직 미착수**.
- **구조적 가드**: `signup_channel='staff'`로 마킹된 계정은 `complete_supplier_signup()`이 온보딩 자체를 거절(`STAFF_ACCOUNT_CANNOT_ONBOARD`) — `wholesalers` row를 원천적으로 못 만들게 해서 승인 대기 목록에 절대 안 들어감. 반대 방향(실제 신청자가 후보 검색에 뜨는 것)은 `searchAdminCandidatesAction`의 `wholesalers` row 제외 필터가 막음. 양쪽 다 막아야 "절대 안 섞임"이 성립.
- **마이그레이션**: `supabase/migrations/20260921000000_staff_signup_channel.sql` — `20260916000000`과 별개 파일(다른 기능, 이미 적용된 함수(`complete_supplier_signup`, 20260914 정의)에 `CREATE OR REPLACE`). `profiles.signup_channel` 컬럼 + 가드 추가. SQL Editor 적용 완료, 컬럼/가드 존재 확인됨. 기존 3개 계정은 이 마이그레이션 이전에 생성돼 `signup_channel IS NULL`이라 영향 없음 — 함수 diff로 기존 로직 무변경 확인(라이브 온보딩 리그레션 테스트는 새 카카오 계정 없어서 미실시).
- **파일**: `lib/auth/staff-auth.ts`, `app/actions/staff-auth.ts`, `app/staff-login/{page.tsx,staff-kakao-login-panel.tsx,pending/page.tsx}`, `app/auth/callback/route.ts`(intent=staff 분기 + `signup_channel` service_role 기록), `lib/auth/supplier-auth.ts`(`STAFF_ACCOUNT_CANNOT_ONBOARD` 메시지).
- **커밋**: `01ad2ad`(진입점 분리), `df9e7cf`(온보딩 차단 + 후보 필터). 둘 다 완료.
