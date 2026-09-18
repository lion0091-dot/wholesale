# 카카오 알림톡(AlimTalk) 실제 발송 연동

### 배경
기존엔 `ALIMTALK_API_KEY`라는 플랫폼 공용 환경변수를 전제로 한 스텁 코드만 있었고, 키가 있어도 실제 HTTP 발송 로직이 없어 항상 콘솔 로그(mock)만 남겼다. 하지만 사업 구조가 "플랫폼은 발송 연동만 대행하고, 알림톡 발송대행사(비즈뿌리오)와의 계약은 공급사 각자가 1:1로 체결"하는 방식으로 확정되어, 플랫폼 공용 키가 아니라 **공급사별 자격정보**를 저장하는 구조로 다시 설계했다.

### 잠긴 설계 결정 (재검토 금지)
- **대행사는 비즈뿌리오로 고정**: 여러 대행사를 고를 수 있게 하는 플러그인 구조는 지금 안 만든다. 대신 `wholesalers.alimtalk_provider` 컬럼을 미리 둬서(현재 값은 항상 `'bizppurio'`), 나중에 다른 대행사를 지원하게 되면 `dispatchAlimtalk` 안에 분기 하나만 추가하면 되게 해뒀다 — 스키마 재설계 불필요.
- **비밀번호는 절대 평문 저장 안 함**: 비즈뿌리오 인증이 계정+비밀번호(Basic auth)로 24시간짜리 토큰을 매번 재발급받는 방식이라 평문 저장 압박이 있었지만, 유출 시 그 공급사 명의로 메시지 발송/과금될 수 있어 AES-256-GCM으로 암호화한 값만 저장한다(`lib/security/credential-crypto.ts`, `CREDENTIAL_ENCRYPTION_KEY`). 단방향 해시는 못 쓴다 — 발송 시점에 원문이 다시 필요하기 때문.
- **플랫폼은 대행사 계정을 대신 관리하지 않는다**: 비밀번호 재설정 같은 기능은 만들 수 없다(우리 계정이 아니므로). 공급사가 비즈뿌리오에서 직접 재설정하고 우리 설정 화면에 새 비밀번호를 다시 입력하는 것으로 충분하다.
- **설정 화면(`/dashboard/invites`)은 owner/manager만**: 실제 메시지 발송 비용이 발생하는 자격정보라 여신 한도 수정과 같은 기준(`requireOrgRole(["owner","manager"])`)을 적용했다. 일반 staff는 조회/저장 둘 다 불가.
- **미설정은 에러가 아니라 정상 상태**: 아직 알림톡을 안 쓰는 공급사가 대부분일 수 있어, `dispatchAlimtalk`는 미설정을 `status: "not_configured"`로 조용히 반환하고 콘솔 에러를 남기지 않는다. 반대로 복호화 실패(키 분실 등 진짜 이상 상황)는 `status: "error"`로 구분하고 콘솔에 로그를 남긴다.

### 공급사 온보딩 절차 — "투스탑"이다 (비즈뿌리오 하나로 안 끝남)
IT에 어두운 공급사 사장님 기준으로 헷갈리기 가장 쉬운 지점이라 명시해둔다. **카카오 사이트와
비즈뿌리오 사이트, 두 곳을 순서대로 거쳐야 한다**:
1. **카카오 비즈니스 채널 관리자센터**(center-pf.kakao.com)에서 카카오톡 채널을 먼저 개설 —
   비즈뿌리오 가입 여부와 무관하게 카카오 사이트에서 직접 하는 절차.
2. **비즈뿌리오(bizppurio.com)** 가입 → 그 채널로 발신프로필 등록 → 알림톡 템플릿 4종 심사 신청
   (신청 자체는 비즈뿌리오 대시보드 안에서 하고, 실제 심사는 카카오가 뒤에서 진행, 영업일 1~2일).
3. 승인 완료되면 우리 플랫폼 설정 화면(`/dashboard/invites`)에 계정+템플릿 코드 입력.

이 순서를 설정 화면 안내문(`alimtalk-settings-form.tsx`)에도 명시해뒀다. "비즈뿌리오 하나면
다 된다"고 안내하면 공급사가 채널 개설 단계를 못 찾아서 헤맬 수 있다.

**템플릿 승인 상태를 API로 미리 확인할 방법 없음**: 비즈뿌리오 공식 개발자 API 문서(v3.5) 전체
목차를 확인했지만 템플릿 조회/상태확인 API 자체가 없다 — 템플릿 등록·조회는 비즈뿌리오 웹
대시보드에서만 가능하고, 우리 쪽에서 저장 시점에 "이 코드 진짜 승인됐어?"를 미리 검증할 수
없다. 그래서 문제는 항상 **실제 발송을 시도하는 순간에야** 드러난다(아래 에러 코드 참고).

### 비즈뿌리오 API 스펙 (2026-09-18, 공식 문서 화면 캡처 기준 — 실계정 미검증)
- 토큰 발급: `POST https://api.bizppurio.com/v1/token`, `Authorization: Basic base64(계정:비밀번호)` → `{accesstoken, type:"Bearer", expired}` (24시간 유효)
- 발송: `POST https://api.bizppurio.com/v3/message`, `Authorization: Bearer {accesstoken}` → body `{account, type:"at", from, to, refkey, content:{senderkey, templatecode, message}}` → 응답 `{code, description, refkey, messagekey}` (`code:1000`은 API 호출 성공일 뿐 실제 수신 성공을 보장 안 함 — 발송 결과 리포트 조회는 별도 과제)
- 토큰 캐싱은 하지 않는다 — 서버리스라 프로세스 간 캐시 공유가 어렵고, 발송 빈도가 낮아 매번 재발급해도 무리 없다고 판단. 발송량이 늘면 최적화 고려.
- 상태코드(AT/AI/FT) 중 템플릿 관련 10개(7204/7315/7327/7328/7330/7331/7333/7336/7338/7342)는 `lib/notifications/alimtalk.ts`의 `KNOWN_BIZPPURIO_ERROR_CODES`에서 사람이 읽기 쉬운 한국어 문구로 변환한다. 특히 `7315`(템플릿 없음/미승인), `7204`(문구 불일치)가 설정 실수로 가장 흔히 날 조합.

### 아키텍처
- `supabase/migrations/20260930000032_wholesaler_alimtalk_settings.sql` — `wholesalers`에 `alimtalk_provider/account/password_encrypted/sender_key/sender_phone/template_codes(jsonb)` 추가. 새 RLS 정책 불필요(기존 "Wholesalers updatable by self or admin" 정책이 신규 컬럼에도 적용됨), 미니샵 카탈로그 select가 컬럼을 명시적으로 나열해서 바이어에게 노출될 일도 없음.
- `lib/security/credential-crypto.ts` — `encryptCredential`/`decryptCredential`, AES-256-GCM, `CREDENTIAL_ENCRYPTION_KEY`(64자리 hex) 미설정 시 예외를 던진다(다른 외부 API처럼 조용히 스킵하면 안 되는 보안 데이터라 fail-closed).
- `lib/notifications/bizppurio-client.ts` — 저수준 API 클라이언트(`fetchAccessToken`, `sendAlimtalk`).
- `lib/notifications/alimtalk.ts` — 재설계된 디스패치. `wholesalerId`로 `service_role` 조회 → 복호화 → 비즈뿌리오 호출. 4개 발송 함수(`sendOrderNotificationToWholesaler` 등) 시그니처에 `wholesalerId` 추가.
- `app/actions/alimtalk-settings.ts` — 설정 조회(`getAlimtalkSettingsAction`, 비밀번호는 절대 안 내려줌)/저장(`saveAlimtalkSettingsAction`, 빈 비밀번호 제출 시 기존 값 유지).
- `app/dashboard/invites/alimtalk-settings-form.tsx` — 설정 화면, `/dashboard/invites` 페이지에 배치(기존 사업자정보/주소/썸네일 폼과 같은 자리).
- `app/dashboard/receivables/receivables-view.tsx` — "리마인드 발송" 버튼은 계정+비밀번호+발신프로필키+발신번호+`receivablesReminder` 템플릿 코드가 전부 등록된 경우에만 보이고, 아니면 설정 화면으로 가는 링크로 대체(스위트트래커 배송조회 버튼과 동일 패턴).

### 검증 상태
- `tsc --noEmit`, `next build` 통과.
- **실제 비즈뿌리오 계정으로 발송해본 적 없음** — API 스펙 자체가 문서 화면 캡처 기준 추정이라, 계정 발급 후 토큰 발급/발송 엔드포인트·필드명·에러 코드를 실호출로 재검증 필요.
- 설정 화면 실계정 클릭 확인 안 함.

### 남은 과제
- 실계정 발급 후 API 재검증 (특히 `content.message`가 카카오 승인 템플릿과 정확히 일치해야 발송이 통과되는지 — 현재 4개 알림 문구를 "이 문구 그대로 템플릿 등록하세요" 기준 텍스트로 취급하고 있음).
- 발송 결과 리포트 조회(비즈뿌리오 `/v2/report` 등) — 지금은 "API 호출 성공"까지만 확인, 실제 수신 성공/실패는 추적 안 함.
- 토큰 캐싱 최적화 (발송량이 늘어날 경우).
- 공급사 온보딩 가이드 문서(비즈뿌리오 가입 → 카카오 채널/발신프로필 → 템플릿 승인 → 우리 설정 화면 입력, 전체 흐름 안내) — 아직 안 만듦.
