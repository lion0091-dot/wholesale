# 가입 시 개인정보 수집·동의 시점 정렬 (공급사 + 바이어)

## 문제
카카오 로그인 완료 즉시 `handle_new_user()` 트리거가 카카오가 제공한 실제 이름/전화번호를 `profiles`에 저장했다. 이 시점은 사용자가 이 서비스 자체의 이용약관/개인정보 수집·이용에 동의(공급사는 `/onboarding`의 체크박스 → `complete_supplier_signup()` 호출)하기 **전**이라, 동의 없이 개인정보가 저장되는 구간이 있었다. 온보딩을 완료하지 않고 이탈해도 그 값은 동의 없이 그대로 남았다.

카카오 OAuth 자체의 동의 화면("이 앱에 정보 제공")은 카카오와 사용자 사이의 동의이지, 이 서비스의 개인정보처리방침에 대한 동의가 아니다 — 별개로 봐야 한다.

## 해결 방향 (검토한 대안)
- **A안 (기각)**: `/login`에서 체크박스를 먼저 받고 동의 토큰을 OAuth 콜백까지 실어 보내 콜백에서 검증. 간극을 좁히지만 없애진 못하고, 토큰 왕복 구조가 복잡함.
- **B안 (채택)**: 트리거가 카카오의 실제 개인정보를 애초에 저장하지 않음 — 동의 시점(`complete_supplier_signup()`)에만 실제 값을 씀. 화면 표시는 `resolveDisplayName()`이 `profiles.name` 공백 시 세션의 카카오 닉네임(`user_metadata`)으로 이미 폴백하도록 설계돼 있어 UX 영향 없음.

## 적용한 변경
1. **`supabase/migrations/20260922000000_defer_new_user_pii_until_consent.sql`** (커밋 `bc3fb85`)
   - `handle_new_user()`: `profiles` INSERT 시 이름/전화를 카카오 메타데이터 대신 빈 문자열로 채움. 실제 값은 여전히 `complete_supplier_signup()`이 동의 직후 기록(이 함수는 무변경, [Step 3](#검증-단계) 참고).
   - `claim_shop_access()` (바이어 가입 경로) 동반 수정: 위 변경으로 `profiles.name`이 항상 `''`로 시작하게 되면서, 기존 `COALESCE(v_name, '카카오 회원')`가 `NULL`만 대체하고 빈 문자열은 통과시켜 신규 바이어의 `retailers.restaurant_name`/`representative_name`이 빈 문자열로 저장되는 회귀가 발생함을 발견 → `COALESCE(NULLIF(v_name, ''), '카카오 회원')`로 두 지점 수정.
2. **`lib/supplier/verification.ts` / `app/onboarding/page.tsx`** (커밋 `62278b2`)
   - `SupplierAccount`에 `kakaoName`/`kakaoPhone` 추가 — 세션의 `user_metadata`에서만 읽고 DB에는 저장하지 않음.
   - 온보딩 폼(`SupplierSignupForm`) 프리필을 `account?.name || account?.kakaoName`, `account?.phone || account?.kakaoPhone` 우선순위로 변경 — Step 1 이후 `profiles.name/phone`이 동의 전엔 항상 비어있어 폼이 빈칸으로 뜨던 것을 보완.

## 검증 단계
- `complete_supplier_signup()` 재확인: 동의 시각(`terms_agreed_at`/`privacy_agreed_at`)과 이름/전화를 같은 UPDATE 문에서 함께 쓰고 있음을 확인 — **변경 불필요**.
- 기존 데이터 백필 필요 여부: `profiles WHERE is_supplier=true AND terms_agreed_at IS NULL AND (name<>'' OR phone<>'')` 조회 결과 **0건** — 정리할 레거시 데이터 없음.
- `pg_get_functiondef`로 SQL Editor 적용 후 두 함수(`handle_new_user`, `claim_shop_access`) 정의를 직접 대조 확인함(실 카카오 로그인 단말 없이 진행).

## 바이어(구매 회원) 쪽 후속 작업 — 완료
당초 "남은 과제"였던 바이어 동의 화면 부재를 같은 브랜치에서 이어서 처리했다.

- **`supabase/migrations/20260923000000_buyer_consent.sql`** (커밋 `3c4c0c2`): `record_buyer_consent(p_marketing_agreed)` RPC 추가. `role='retailer'` 계정 본인의 `profiles`에 `terms_agreed_at`/`privacy_agreed_at`/`marketing_agreed_at`만 기록(멱등, role/is_supplier/is_verified는 안 건드려서 `enforce_profile_role_immutable()` 권한 우회 플래그 불필요).
- **동의 화면 + 배선** (커밋 `f0017c2`):
  - `app/shop/[shop_token]/buyer-consent-gate.tsx` — 신규 동의 화면(공급사 온보딩 체크박스와 톤 통일).
  - `app/actions/buyer-auth.ts`의 `recordBuyerConsentAction()` — 필수 체크박스 서버 재검증 후 RPC 호출.
  - `app/shop/[shop_token]/page.tsx` — 로그인 후 `role='retailer' && terms_agreed_at IS NULL`이면 카탈로그 대신 동의 화면 표시.
  - `lib/auth/buyer-auth.ts`의 `requireBuyerConsent()` — `cart`/`checkout`/`orders` 하위 경로를 직접 북마크·재방문해 동의 화면을 건너뛰는 경로를 막고 루트로 되돌려보냄.
- **PII 저장 자체**: 별도 조치 불필요했음 — `20260922000000`(handle_new_user 지연 저장)이 바이어 가입 경로(`claim_shop_access`)에도 그대로 적용돼, 신규 바이어의 `retailers.restaurant_name`도 이미 실제 카카오 닉네임이 아니라 자리표시자("카카오 회원")로 저장되고 있었음.

## 남은 과제 (별도 스코프, 보류)
- **서버 액션(`app/shop/[shop_token]/actions.ts`) 레벨 방어 없음**: 페이지 렌더링은 다 막았지만, 장바구니 담기/발주 제출 액션 자체는 동의 여부를 직접 체크하지 않는다. 정상 UI 경로로는 도달 불가능하지만, 요청을 직접 조작하는 우회까지 막으려면 별도 작업 필요 — 우선순위 낮음 판단, 보류.
- 온보딩 미완료(가입 후 이탈) 계정의 `profiles` 보유기간/파기 정책은 코드 레벨에서 아직 없음 — 필요성 검토 필요.
