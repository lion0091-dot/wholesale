# 카카오 알림톡(AlimTalk) 실제 발송 연동

## 2026-10-01 추가 — 알림 채널 정리: 알림톡 12종 → 8종, 화면 알림은 Realtime (사장님 결정)

알림 전체(알림톡 12건 + 화면 종 배지 3항목 + 고객 배송 벨)를 "받는 사람이 그 순간 화면을 보고 있는가"로 나눠 채널을 정했다.

| 분류 | 항목 | 처리 |
|---|---|---|
| 알림톡 **유지** (고객용, 화면 안 보는 상황·전달 확실해야 함) | `receivablesReminder` 미수금 독촉 · `creditLimitIncreased` 외상 가능 · `retailerBlockedRetailer` 거래 제한 · `retailerResumedRetailer` 거래 재개 | 그대로 |
| 알림톡 **→ 웹푸시 예정** (공급사용) | `orderNew` · `orderEdited` · `cancelRequest` · `creditExceeded` | 웹푸시 구현 전까지는 알림톡 유지. 지금은 대표 1명 번호로만 가고 직원은 못 받는데, 웹푸시면 직원 전원이 받는다 |
| 알림톡 **제거 → 대시보드 알림함** (내부 기록, 급하지 않음) | 여신 한도 변경 · 거래처 정지 · 거래처 재개 (대표에게 "누가 했는지" 통지하던 3종) | 템플릿·발송 함수·호출부 삭제(2026-10-01). 알림함은 같은 날 2단계로 완료 — **새 표 없음**, `audit_log`(013 트리거)에서 RPC `list_wholesaler_internal_notices`(마이그 188)로 최근 14일·10건을 읽어 종 🔔 패널 "최근 알림" 칸에 표시. 대표·매니저만(RPC 게이트, 직원은 빈 배열). 빨간 숫자(할 일)에는 안 섞고 이 기기에서 안 본 항목이 있으면 종 옆 **파란 점**만(localStorage, 서버 읽음 저장 없음 — 사장님 A안). `wholesaler_retailers`도 Realtime 발행에 추가. 테스트 `tests/integration/internal-notices.itest.ts`(권한·문구·이력 3,000건 부하 400ms 상한) |
| 알림톡 **제거** | 고객 외상 주문 거절 안내 | 고객이 그 순간 화면에서 거절 문구를 이미 본다. 삭제 |
| 화면 알림 **Realtime** | 종 배지 3항목(`lib/supplier/todo-counts.ts`) · 고객 미니샵 배송 벨 | 30초 주기 조회 → `orders`·`inbound_scans` 변화 구독(마이그 187, `lib/hooks/use-realtime-refresh.ts`). 종 배지는 5분 안전망 주기만 남김 |
| 추가 **안 함** | 배송 시작 알림톡 | "진짜 배송 알림은 배송기사가 보내준다"(사장님). 재제안 금지 |

- Realtime은 **화면이 열려 있을 때만** 갱신된다 — 폰 꺼져 있을 때 알리는 "푸시"는 별개(웹푸시, 홈 화면 앱 설정 미결 건과 같이 진행). 고객은 카톡 인앱 브라우저로 들어와 웹푸시가 안 되므로 고객용 알림톡은 대체 불가.
- Supabase Realtime 무료 한도(동시 접속 200·월 메시지 200만·초당 100)로 현재 규모엔 충분. 받은 행은 쓰지 않고 "바뀌었다" 신호로만 쓰고 값은 서버에 다시 묻는다(RLS·계산은 서버 한 곳). 누가 어떤 행의 변화를 받는지는 기존 RLS SELECT 정책 그대로 — `tests/integration/realtime-bell.itest.ts`가 "내 업체는 오고 남의 업체 세션엔 안 온다"를 로컬 Realtime으로 확인한다.
- Realtime 삭제(DELETE) 이벤트는 필터 때문에 안 온다(삭제 행의 키만 보냄). 실패 주문 정리(`discard_unfulfilled_order`)처럼 삭제로 숫자가 줄어드는 경우는 화면 이동·탭 복귀·5분 안전망이 메운다.
- 아래 문서의 "12개 템플릿"·"도매 7·소매 5" 숫자는 이 결정 이전 기록이다. 현재는 8개(공급사용 4·고객용 4).

## 2026-09-30 추가 — 플랫폼 대표 채널(기본값) + 공급사 개별 등록(독립) 병행 (사장님 결정)

아래 "잠긴 설계 결정" 중 **"플랫폼은 대행사 계정을 대신 관리하지 않는다"는 이제 절대 규칙이 아니라 기본값 우선순위 문제로 바뀌었다.** 결정 배경: 알림톡 12개 템플릿을 수신자로 나눠보면 도매 쪽(주문 이벤트, 빈도 높음) 7개·소매 쪽(계정 상태 변화, 빈도 낮음) 5개고 **대량 방송(브로드캐스트) 기능 자체가 코드에 없다** — `dispatchAlimtalk`는 12번 다 "이벤트 1건 = 수신자 1명"만 호출한다. 그래서 "공급사마다 카카오 채널+비즈뿌리오 가입을 각자 시키는" 투스탑 온보딩 마찰을 낮추기 위해, 플랫폼이 대표 채널 하나를 운영해 **미등록 공급사에게 기본 제공**하고, 원하는 공급사는 언제든 자기 계정을 등록해 독립하는 하이브리드로 바꿨다.

- **우선순위**: `wholesalers.alimtalk_*`(공급사 개별 등록)가 있으면 항상 그게 우선. 없으면 `ALIMTALK_PLATFORM_*` 환경변수(플랫폼 대표 채널, `.env.example` 참고)로 폴백한다. 구현: `lib/notifications/alimtalk.ts`의 `loadCredentials()`/`isAlimtalkConfiguredForWholesaler()`, 폴백 헬퍼 `loadPlatformCredentials()`.
- **비용**: 플랫폼 채널을 쓰는 공급사분은 발송 요금이 사장님 비즈뿌리오 청구서로 잡힌다(종량제 — 방송이 없어 폭증 위험은 없지만 주문량에 비례해 꾸준히 늘어남). 구독료에 녹여 넣을지는 미정.
- **개인정보처리방침 연동 — 아직 안 고침**: `app/privacy/page.tsx` 5조는 현재 "비즈뿌리오는 공급사가 직접 계약(회사가 위탁한 것 아님)"으로 명시돼 있다. `ALIMTALK_PLATFORM_*` 환경변수를 실제로 채워서 플랫폼 채널이 살아나는 순간, 비즈뿌리오를 그 문구에서 빼서 "회사가 위탁"하는 정식 목록(Supabase·Vercel 등과 같은 자리)으로 옮겨야 한다. 개인정보 관련 진행 중인 변호사 자문(질문 8·13 등, CLAUDE.md 참고)에도 이 건을 같이 포함시킬 것.
- **아직 안 한 것**: 사장님의 실제 카카오 채널 개설 + 비즈뿌리오 가입 + 템플릿 12개 승인(아래 "공급사 온보딩 절차"와 같은 순서, 이번엔 플랫폼 명의로 1번만). 환경변수는 비어 있어 지금은 폴백이 항상 `not_configured`로 조용히 넘어간다.

### 배경
기존엔 `ALIMTALK_API_KEY`라는 플랫폼 공용 환경변수를 전제로 한 스텁 코드만 있었고, 키가 있어도 실제 HTTP 발송 로직이 없어 항상 콘솔 로그(mock)만 남겼다. 하지만 사업 구조가 "플랫폼은 발송 연동만 대행하고, 알림톡 발송대행사(비즈뿌리오)와의 계약은 공급사 각자가 1:1로 체결"하는 방식으로 확정되어, 플랫폼 공용 키가 아니라 **공급사별 자격정보**를 저장하는 구조로 다시 설계했다. (2026-09-30: 위 추가 항목대로 플랫폼 공용 키가 "폴백"으로 부활했다 — 다만 예전 스텁과 달리 공급사 개별 등록이 항상 우선한다.)

### 잠긴 설계 결정 (재검토 금지)
- **대행사는 비즈뿌리오로 고정**: 여러 대행사를 고를 수 있게 하는 플러그인 구조는 지금 안 만든다. 대신 `wholesalers.alimtalk_provider` 컬럼을 미리 둬서(현재 값은 항상 `'bizppurio'`), 나중에 다른 대행사를 지원하게 되면 `dispatchAlimtalk` 안에 분기 하나만 추가하면 되게 해뒀다 — 스키마 재설계 불필요.
- **비밀번호는 절대 평문 저장 안 함**: 비즈뿌리오 인증이 계정+비밀번호(Basic auth)로 24시간짜리 토큰을 매번 재발급받는 방식이라 평문 저장 압박이 있었지만, 유출 시 그 공급사 명의로 메시지 발송/과금될 수 있어 AES-256-GCM으로 암호화한 값만 저장한다(`lib/security/credential-crypto.ts`, `CREDENTIAL_ENCRYPTION_KEY`). 단방향 해시는 못 쓴다 — 발송 시점에 원문이 다시 필요하기 때문. (플랫폼 자체의 대표 채널 자격정보는 예외 — DB가 아니라 Vercel 환경변수에 평문으로 둔다, 위 2026-09-30 항목 참고.)
- **플랫폼은 공급사의 대행사 계정을 대신 관리하지 않는다**: 공급사가 자기 계정을 등록한 뒤엔 그 비밀번호 재설정 같은 기능을 플랫폼이 대신할 수 없다(우리 계정이 아니므로) — 공급사가 비즈뿌리오에서 직접 재설정하고 우리 설정 화면에 새 비밀번호를 다시 입력하는 것으로 충분하다. (플랫폼 대표 채널 자체는 당연히 플랫폼이 관리한다 — 이 규칙은 "공급사 개별 계정"에만 적용된다.)
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
- **(2026-09-30 신규)** 사장님의 플랫폼 대표 채널 개설(카카오 채널 → 비즈뿌리오 가입 → 템플릿 12개 승인 → `.env.example`의 `ALIMTALK_PLATFORM_*` 값을 Vercel에 입력) — 아직 착수 전. 입력되는 순간 개인정보처리방침 5조 수정도 같이 해야 함(위 추가 항목 참고).
- **(2026-09-30 신규)** "플랫폼이 공급사 대신 채널 개설을 대행"하는 서비스 여부는 비즈뿌리오 쪽 정책 확인 필요 — 사장님이 비즈뿌리오 영업팀에 직접 문의하기로 함(코드로 확인 불가한 외부 정책 사안).

### 보안 점검 — 자격정보 컬럼 노출 수정 (2026-09-24, 마이그레이션 110)
`wholesalers` SELECT 정책이 연결 거래처·소속 직원(staff 포함)에게 행 전체를 보여주고 컬럼 권한도 열려 있어, API 직접 호출로 `alimtalk_*`(계정·암호화 비밀번호·발신프로필키·템플릿 코드)와 `pg_secret_key_encrypted`를 읽을 수 있었다. 또 매니저가 설정을 저장하면 UPDATE 정책(사장 본인만)에 막혀 0행인데 화면에는 "저장됨"이 떴다.
- 110: anon·authenticated의 `wholesalers` 테이블 SELECT를 회수하고 위 7개 컬럼을 뺀 나머지 컬럼에만 컬럼 단위 SELECT를 재부여. 사장 본인도 세션으로는 못 읽는다.
- 서버는 `lib/security/wholesaler-credentials.ts`(service_role)로 읽고 쓴다: 알림톡·PG 설정 조회/저장 액션, 토스 시크릿키를 읽는 3곳(결제 승인 콜백, 주문 취소 환불, 재대조). 저장 액션은 기존대로 `requireOrgRole(["owner","manager"])` 뒤에 실행되므로 매니저 저장도 실제로 반영된다.
- **`wholesalers`에 컬럼을 추가하면 세션이 읽어야 하는 컬럼은 그 마이그레이션에서 `GRANT SELECT (컬럼) ON public.wholesalers TO anon, authenticated`를 같이 줘야 한다(기본은 안 보임). 세션 클라이언트에서 `wholesalers`를 `select('*')`로 읽으면 권한 오류 — 컬럼을 명시할 것.** `scripts/db-test-alimtalk-credentials.sql`(25건)이 누락을 잡는다.
- 남은 것: 직원(staff)도 설정 화면에서 계정·발신프로필키(비밀번호 제외)는 보인다(미수금 화면 리마인드 버튼 노출 판단에 쓰임, 기존 동작 유지).

## 발송 로그 + 플랫폼 채널 발송비 안분 청구 (2026-09-30, 마이그 183)

- 약관 제5조 5~7항(사장님 결정): 구독료 청구 시작일(`wholesalers.billing_starts_at`)부터 3개월은 플랫폼이 부담(시작일 미지정·체험 기간은 실비도 없음), 이후 플랫폼 대표 채널 총 발송비를 공급사별 접수 건수 비율로 **안분** 청구. 자체 계정 발송분은 제외. 변호사 자문서 8-4절(16·17번)에 검토 요청 등재.
- `alimtalk_send_log`(공급사·템플릿·채널 platform/own·status sent/error/not_configured·error_code·messagekey·refkey). `dispatchAlimtalk`가 기록(`recordSendLog`), 기록 실패는 발송 결과에 영향 없음. 수신번호·본문은 저장 안 함, 서버(service_role)만 쓰고 super_admin만 읽음, 자동 삭제 없음(개인정보 없음).
- **status=sent는 비즈뿌리오 "접수"이지 수신자 도착이 아니다.** 결과 리포트 조회(`/v2/report`)는 미구현이라 안분은 접수 건수 기준. 실제 청구서와 건별로 맞추려면 messagekey로 리포트 조회를 붙여야 한다.
- 월 집계(플랫폼 채널·sent만): `select l.wholesaler_id, count(*) from alimtalk_send_log l join wholesalers w on w.id=l.wholesaler_id where w.billing_starts_at is not null and l.created_at >= w.billing_starts_at + interval '3 months' and l.channel='platform' and l.status='sent' and l.created_at >= date_trunc('month', now() - interval '1 month') and l.created_at < date_trunc('month', now()) group by 1;` — 집계 화면은 아직 없음(3개월 안에 필요).
- 대표 채널 환경변수(`ALIMTALK_PLATFORM_*`)를 실제로 넣는 시점에 개인정보처리방침 5조 "공급사가 직접 계약" 표기를 고칠 것(자문서 17번).
