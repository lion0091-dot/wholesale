# 계산서(면세) 국세청 실제 발행/정정 (팝빌 연동)

## 배경
[docs/tax-invoice-draft.md](./tax-invoice-draft.md)의 "홈택스 수동 입력 도우미"에서 한 단계 더 나아가, 국세청 인증 ASP(팝빌)를 연동해 실제로 접수까지 대행한다. 초안 도우미는 그대로 유지하고("PDF만 만들고 저장 안 함" 흐름), 그 옆에 "국세청 실제 발행" 버튼을 별도로 추가하는 방식으로 확장했다.

## ASP는 팝빌로 고정 (잠긴 결정)
바로빌 등 경쟁 ASP를 고를 수도 있었으나, 문서/SDK가 가장 충실하고 실제 사용 사례가 많은 팝빌 기준으로 코드를 짰다. 계약은 아직 안 돼 있다 — 코드는 계약 전에도 끝까지 만들어두고, 계약 후 env var만 채우면 되는 구조(다른 기능들과 동일 패턴).

## 알림톡과 다른 구조 (중요)
알림톡은 "공급사가 대행사(비즈뿌리오)와 1:1 계약"하는 구조라 공급사별 자격정보를 저장했다. 팝빌은 정반대다 — **플랫폼이 파트너 계약 1건**(`POPBILL_LINK_ID`/`POPBILL_SECRET_KEY`, 플랫폼 공용 env var)을 맺고, 그 밑에 공급사를 사업자번호 기준 "연동회원"으로 등록해 대신 발행한다. 공급사는 팝빌에 별도 가입하거나 인증서를 준비할 필요가 없다 — 최초 발행 시도 시 `ensurePopbillMember()`가 자동으로 가입시킨다(`checkIsMember` → 필요시 `joinMember`).

## 잠긴 설계 결정
- **면세 계산서만**: `taxType: "면세"` 고정. `docs/tax-invoice-draft.md`의 과세/면세 판단 근거를 그대로 따른다. 세액 컬럼 없음.
- **가입 비밀번호는 저장하지 않음**: `joinMember`에 넘기는 `PWD`는 랜덤 생성 후 버린다 — 이후 모든 API 호출은 파트너 SecretKey + CorpNum 조합으로만 이뤄지고, 팝빌 웹 포털 로그인은 이 플랫폼 흐름에 필요 없다.
- **발행/정정은 owner·manager만**: 알림톡 설정과 동일 기준(`requireOrgRole(["owner","manager"])`). 실제 세무 신고 행위라 일반 staff가 실수로 발행하면 되돌리기 어렵다.
- **취소가 아니라 정정신고**: 발행 취소(`cancelIssue`)는 당일 즉시 취소 개념이라 별도 버튼을 만들지 않았다. 대신 국세청 표준 수정사유 6종(착오정정/공급가액변동/환입/계약해제/내국신용장 사후개설/착오 이중발행)을 골라 원본과 연결된 새 계산서를 발행하는 정정신고만 지원한다.
- **발행 이력은 DB에 남긴다**: 지금까진 "PDF만 만들고 저장 안 함"이었지만, 정정 시 원본 문서를 찾아야 해서 `tax_invoice_issuances` 테이블(발행/정정 이력, 상태, 원본 참조 self-FK)을 신규로 뒀다. 호출 전에 먼저 `pending` row를 만들고 성공/실패로 갱신하는 순서라, 네트워크 타임아웃으로 응답이 끊겨도 시도 흔적이 남는다.
- **SDK 의존성 예외 허용**: 알림톡은 raw fetch로 직접 구현했지만, 팝빌은 토큰 발급에 비공개 HMAC 서명 프로토콜(`linkhub` 패키지 내부)을 써서 직접 구현 시 서명 오류 위험이 크다고 판단해 공식 SDK(`popbill`+`linkhub`, 타입 없음)를 의존성으로 추가했다. 타입은 `types/popbill.d.ts`에 우리가 쓰는 표면만 최소 선언.

## 아키텍처
- `supabase/migrations/20260930000033_tax_invoice_issuance.sql` — `tax_invoice_issuances` 테이블 신규 + `wholesalers.popbill_member_id`/`popbill_joined_at` 컬럼.
- `types/popbill.d.ts` — 팝빌 SDK 최소 타입 선언(`TaxinvoiceForm`, `TaxinvoiceService` 등).
- `lib/popbill/client.ts` — SDK Promise 래퍼(`checkIsMember`/`joinMember`/`registIssue`/`getInfo`/`cancelIssue`). `POPBILL_LINK_ID`/`POPBILL_SECRET_KEY`/`POPBILL_IS_TEST` env var로 전역 설정(프로세스당 1회).
- `lib/popbill/modify-codes.ts` — 수정사유 코드/라벨. 클라이언트 컴포넌트에서도 안전하게 import하도록 `lib/popbill/client.ts`(Node 전용 `popbill` SDK 의존)와 분리된 순수 데이터 파일로 뒀다 — 합쳐두면 웹팩이 클라이언트 번들에 SDK 전체를 끌고 들어간다(빌드 시 실제로 걸렸던 문제).
- `lib/popbill/taxinvoice.ts` — 비즈니스 로직: `ensurePopbillMember`(공급사 자동가입), `mapToTaxinvoiceForm`(`StatementData` → 팝빌 필드, `lib/orders/statement.ts` 재사용), `issueTaxInvoice`(최초발행), `issueTaxInvoiceCorrection`(정정발행).
- `app/dashboard/orders/[id]/tax-invoice/issue-action.ts` — Server Action 3종(`issueTaxInvoiceAction`/`issueTaxInvoiceCorrectionAction`/`listTaxInvoiceIssuancesAction`), owner/manager 가드.
- `components/tax-invoice-draft-panel.tsx` — 기존 "PDF 미리보기" 도우미 패널 안에 발행 이력 목록 + "국세청에 실제 발행"/"정정신고" 버튼 추가.

## 미검증 / 추정치로 채운 부분 (실계정 전까지 확인 불가)
- `originalTaxinvoiceKey`에 원본의 `popbill_mgt_key`를 그대로 넘기는 게 맞는지 — 팝빌 공식 문서가 JS 렌더링 SPA라 접근하지 못했고, 공개 SDK 예제 코드(GitHub)의 필드명 추정으로 짰다.
- `checkIsMember` 응답의 `itemCode`/`isMember` 필드명, `joinMember`의 `ID` 생성 규칙(길이/문자 제한).
- `registIssue` 성공 응답의 `ntsconfirmNum` 필드명.
- 팝빌 포인트 과금(건당 차감) — 포인트 부족 시 에러 처리 로직은 아직 없음(발행 실패로만 잡힘).

## 검증 상태
- `tsc --noEmit`, `next build` 통과 (클라이언트 번들 누수 버그 발견 후 수정 완료).
- `tax_invoice_issuances` 테이블/컬럼은 라이브 DB에 적용 확인됨(2026-09-18, `select popbill_member_id from wholesalers` NULL 무오류 확인).
- **팝빌 파트너 계약 안 함** — `POPBILL_LINK_ID`/`POPBILL_SECRET_KEY` 미설정 상태라 실호출 자체를 못 해봄. 위 "미검증" 항목 전부 계약 후 재확인 필요.
- 화면 실계정 클릭 확인 안 함.

## 남은 과제
- 팝빌 파트너 가입(LinkID/SecretKey 발급) + 포인트 충전 — 이것만 하면 나머지는 이미 동작하는 구조.
- 실계정 발급 후 `ensurePopbillMember`/`registIssue`/`issueTaxInvoiceCorrection` 실호출 재검증, 특히 위 "미검증" 목록.
- 포인트 부족 등 팝빌 고유 에러코드의 사람이 읽기 쉬운 메시지 변환(알림톡의 `KNOWN_BIZPPURIO_ERROR_CODES`와 동일 패턴으로 나중에 추가).
- `NEXT_PUBLIC_COMPANY_*` 류 env var처럼 운영 배포 시 Vercel에 `POPBILL_LINK_ID`/`POPBILL_SECRET_KEY`/`POPBILL_IS_TEST=false` 등록 필요.
