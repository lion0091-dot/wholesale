# Platform Admin Allowlist (feat/platform-admin-allowlist)

### 아키텍처
- `SUPER_ADMIN_EMAIL` env var는 **영구 유지**되는 break-glass root 계정. 제거 금지.
- 마이그레이션 파일 하나(`supabase/migrations/20260916000000_platform_admin_allowlist.sql`)를 단계별로 계속 수정하며 진행 — 단계마다 새 파일 만들지 않음. Supabase SQL Editor에 **수동 적용**(CLI/파이프라인 없음).
- 각 롤아웃 단계는 독립 커밋. git 명령(add/commit/push)은 텍스트로만 제공하고 사람이 직접 실행.

### 잠긴 설계 결정 (재검토 금지)
- **이메일 사전등록 미지원**: 가입 전 이메일로 관리자 초대하는 기능은 스코프 제외. `user_id` 기반의, 이미 존재하는 계정 승격만 지원.
- **`can_grant` 컬럼**: "다른 관리자를 관리할 수 있음"과 "일반 관리자"를 구분. 모든 관리자가 서로 승격/강등 못 하게 하려는 목적.
- **`revoke_platform_admin`**: allowlist revoke + `profiles.role` 강등을 한 트랜잭션에서 원자적으로 처리. lockout 가드(자가 revoke 불가, 마지막 `can_grant=true` 관리자 revoke 불가). ✅ 마지막 `can_grant` 관리자 가드(`PLATFORM_ADMIN_LAST_GRANTER`, 동시 회수 경쟁 상황까지 막는 전체 행 잠금 포함)는 구현/SQL Editor 적용/검증(공급사 계정으로 grant→revoke 왕복 테스트) 완료 — 커밋 `86a554c`.
- **`promote_platform_admin`의 `is_verified` 가드**: `is_verified = true`(이미 승인된 wholesaler/supplier) 계정은 승격 거부 — 승인된 공급사의 이해상충 방지.
  - `source = 'env_root'`는 이 가드에서 예외 (root 계정이 나중에 verified supplier가 돼도 복구 경로 막히면 안 됨).
  - `is_verified = false` 계정은 role/is_supplier 무관하게 승격 가능 — `handle_new_user()`가 신규 카카오 가입자를 전부 `role='wholesaler', is_supplier=true, is_verified=false`로 만들기 때문에, 이게 스태프 온보딩과 root 첫 로그인의 유일한 경로. **더 좁히면 안 됨.**
  - **`wholesalers` 테이블 row 존재 여부를 조건으로 쓰지 말 것** — 이전 초안에서 명시적으로 폐기된 접근.
  - 가드는 eligibility/idempotency 체크 **이후**, role write 직전에 위치 — 더 앞에 두면 이미 검증된 supplier의 일반 로그인마다 예외 발생.
  - reject 시 같은 트랜잭션 내 allowlist INSERT도 롤백(고아 grant row 없음).

### 핵심 DB 함수 (마이그레이션 정의, 참조용)
- **`is_self_admin_eligible()`** — 파라미터 없음, `auth.uid()`(현재 세션) 기준 `platform_admin_allowlist`에 `revoked_at IS NULL`인 행 존재 여부만 반환(EXISTS). `SECURITY DEFINER + STABLE + search_path` 고정 — RLS가 이 테이블 직접 SELECT를 막고 있는 상황(직접 열면 명단 전체 노출)을 우회하되, 행 자체는 노출 안 하고 불리언만 반환. `authenticated`에 EXECUTE 권한 부여됨.
- **`can_current_user_grant_admin()`** — 같은 블록에 정의, `can_grant=true` AND `role='super_admin'`까지 확인. UI 조건부 렌더링/액션 가드용. **Step 4의 `requireAdminGranter()`에서 쓸 예정.**
- **`promote_platform_admin(p_user_id UUID, p_bootstrap_email TEXT DEFAULT NULL)`** — `JSONB` 반환(`{user_id, email, role, promoted, source, can_grant, is_super_admin}`). `service_role` 전용(anon/authenticated REVOKE). `p_bootstrap_email`은 신뢰하지 않고 `auth.users`의 실제 이메일과 내부 재대조. 매칭 안 되면 예외 없이 `promoted=false, source='not_eligible'`로 조용히 반환(대부분의 로그인이 지나는 정상 경로). 이미 super_admin이면 쓰기 없이 멱등 반환. 예외: `PLATFORM_ADMIN_INVALID_INPUT` / `PLATFORM_ADMIN_USER_NOT_FOUND` / `PLATFORM_ADMIN_TARGET_ALREADY_VERIFIED`.
- **`bootstrap_super_admin(p_user_id, p_email)`** — **DEPRECATED** 호환 래퍼, 내부적으로 `promote_platform_admin`에 위임. Step 3 이전까지 `super-admin-bootstrap.ts`가 호출하던 구 이름 — 이제 직접 `promote_platform_admin` 호출로 대체됨.

### 관련 애플리케이션 파일
- `lib/auth/super-admin.ts:49-57` `isSuperAdminEmail()` — 순수 env 비교(`SUPER_ADMIN_EMAIL`), Edge 런타임(미들웨어)에서도 import되므로 Node 전용 API 의존 금지. 이것만으로 권한을 부여하면 안 된다는 게 파일 설계 의도(DB가 항상 근거).
- `middleware.ts:56-83` — `/admin` 라우트 가드. `profiles.role==='super_admin'` 1차 판정 → 아니면 `is_self_admin_eligible()` RPC OR `isSuperAdminEmail(user.email)` 폴백. RPC 에러 시 fail-closed(env-root 체크는 무관하게 항상 별도 평가). 통과해도 실제 role 재검증은 다운스트림 라우트(`app/admin/suppliers/page.tsx`)가 담당.
- `lib/auth/super-admin-bootstrap.ts` `ensureSuperAdminBootstrap()` — `app/auth/callback/route.ts:109`(로그인 콜백, 실패해도 로그인 안 막음)와 `app/admin/suppliers/page.tsx:59`(서버 컴포넌트 진입, Node 런타임 — 미들웨어에서 import 불가)에서 호출. 로그인마다 (아직 super_admin 아니면) `promote_platform_admin` 직접 호출.

### 롤아웃 상태 (5단계)
1. ✅ 마이그레이션 (테이블 + RPC 3종 + `is_verified` 가드) — 완료, 프로덕션 적용/검증됨.
2. ✅ `middleware.ts:75`의 `isSuperAdminEmail` 폴백 → `is_self_admin_eligible` RPC(env-root와 OR) 전환. fail-closed 에러 처리 포함. 타입체크/빌드/env-root 수동 로그인 테스트 통과.
3. ✅ `super-admin-bootstrap.ts` → `promote_platform_admin` 직접 호출로 전환.
   - **중요한 수정**: 최초 계획대로 기존 `isSuperAdminEmail(user.email)` 불일치 시 조기 반환(`not_eligible`)하는 게이트를 그대로 두면, env-root가 아닌 일반 allowlist 스태프 관리자는 RPC 호출 자체가 안 일어나 영원히 승격되지 않는 버그가 됨. → `"disabled"`/이메일 조기 게이트 두 분기를 **삭제**하고, 로그인마다(아직 super_admin 아니면) 무조건 `promote_platform_admin` 호출 → 자격 판정을 RPC 응답에 위임하는 구조로 변경.
   - `SuperAdminBootstrapResult`에 `source` 필드 추가(optional, `string | null`).
   - 상태 재판정: `promoted===true`→`"promoted"`, `promoted===false && role==='super_admin'`→`"already_admin"`, 그 외→`"not_eligible"`.
   - RPC 호출 try/catch — `PLATFORM_ADMIN_TARGET_ALREADY_VERIFIED` 등 예외 시 `"failed"` + reason에 메시지.
   - 미사용 코드(`isSuperAdminEmail` import, `missingEmailNoticeLogged`) 제거.
   - 타입체크/빌드/env-root 재로그인(멱등 케이스 포함) 테스트 통과.
4. ✅ `/admin/admins` UI 구축 (`requireAdminGranter()` → `can_current_user_grant_admin()` RPC로 게이팅) — **완료**.
   - `lib/auth/admin-granter.ts` `requireAdminGranter()` — 페이지 가드, fail-closed.
   - `app/admin/admins/actions.ts` — `searchAdminCandidatesAction`/`promoteAdminAction`/`revokeAdminAction`/`listAdminsAction`. `is_verified = true` 계정, `wholesalers` row 보유 계정(= 실제 입점 신청자)은 후보 검색에서 제외 — [staff-login-separation.md](./staff-login-separation.md) 참고.
     - **주의(PostgREST 임베드 함정)**: `platform_admin_allowlist.user_id`와 `profiles.id`는 둘 다 `auth.users(id)`를 각자 참조하는 형제 관계라 테이블 간 직접 FK가 없다. `.select("...profiles:user_id(...)")` 같은 임베드 조인은 relationship을 못 찾아 실패한다 — `listAdminsAction`/`searchAdminCandidatesAction`처럼 두 번 조회해서 JS에서 `Map`으로 합치는 패턴을 써야 한다.
   - `app/admin/admins/active-admins-list.tsx` — 관리자 목록 + 회수 버튼(자기 자신 행은 버튼 숨김).
   - `app/admin/admins/admin-candidate-search.tsx` — 이름/전화 검색 + 승격(명단 편집 권한 체크박스 포함).
   - `app/admin/admins/admin-admins-client.tsx` — 두 컴포넌트가 공유하는 `admins` state 래퍼(승격/회수 시 전체 재조회 없이 로컬 갱신). `/admin/suppliers`의 `SupplierApprovalList` 패턴(초기 데이터 서버 로드 → 클라이언트 컴포넌트 prop 전달)을 참고해 구성.
   - `page.tsx` — `listAdminsAction()` 서버 호출 후 위 클라이언트 래퍼에 배선.
   - typecheck + `next build` 통과 확인 — 커밋 `6d81a3a`.
5. (안정화 후) `enforce_profile_role_immutable()` 트리거 강화 — 활성 allowlist 항목을 통해서만 `profiles.role`을 `super_admin`으로 직접 UPDATE 허용.

### 검증 관련
- DB 함수는 로컬 Docker Postgres stub 컨테이너에서 31개 테스트(신규 8개)로 검증됨. **실제 Supabase RLS 정책과의 상호작용은 아직 미검증** — 함수/트리거 로직만 검증됨.
- 마이그레이션 수정 후에는 매번 env-root 계정으로 로그인해서 `/admin` 접근이 정상인지(가드가 막지 않는지) 수동 재검증할 것.
- **알려진 툴링 이슈**: 이 프로젝트는 ESLint v9인데 `eslint.config.js`(flat config)가 없어서 `next build`의 lint 단계가 조용히 스킵됨 — `no-unused-vars` 등 미사용 코드가 tsc(`noUnusedLocals` 꺼짐)나 ESLint 어느 쪽으로도 안 잡힘. 죽은 코드 확인은 당분간 수동 grep 필요. (별도 스코프 이슈, 이 롤아웃과 무관하게 언젠가 config 추가 필요.)
