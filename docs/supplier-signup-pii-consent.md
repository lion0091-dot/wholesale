# 가입 시 개인정보 수집·동의 시점 정렬

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

## 남은 과제 (별도 스코프)
- **바이어(구매 회원) 쪽엔 아직 이 서비스 자체의 약관/개인정보 동의 체크박스 화면이 없음.** `claim_shop_access()`는 이번 수정으로 PII 저장 자체는 지연됐지만, 그 이후 실제 동의를 받는 절차가 없어 공급사만큼 깔끔하게 해소되지 않았다. 별도 후속 작업으로 남겨둠.
- 온보딩 미완료(가입 후 이탈) 계정의 `profiles` 보유기간/파기 정책은 코드 레벨에서 아직 없음 — 필요성 검토 필요.
