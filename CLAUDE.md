## Platform Admin Allowlist (feat/platform-admin-allowlist)

- [docs/platform-admin-allowlist.md](docs/platform-admin-allowlist.md) — 아키텍처, 잠긴 설계 결정, 핵심 DB 함수 레퍼런스, 관련 애플리케이션 파일, 5단계 롤아웃 상태(현재 Step 4 진행 중), 검증 관련.
- [docs/staff-login-separation.md](docs/staff-login-separation.md) — 내부 스태프 로그인(`/staff-login`) vs 공급사 로그인(`/login`) 분리, `signup_channel` 가드. 같은 브랜치의 별도 기능.

## 가입 시 개인정보 동의 시점 정렬 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/supplier-signup-pii-consent.md](docs/supplier-signup-pii-consent.md) — 카카오 가입 직후 동의 전에 개인정보가 저장되던 문제와 수정 내역. 바이어 쪽 동의 화면 부재는 후속 과제로 남음.

## wholesaler_retailers RLS 정책 누락 (심각 버그, 별도 발견)

- [docs/wholesaler-retailers-rls-fix.md](docs/wholesaler-retailers-rls-fix.md) — RLS 정책이 0개라 카탈로그/발주/고객관리가 전부 막혀있던 문제와 수정. 실계정 라이브 재검증 아직 안 함.

## 거래명세서 PDF 생성 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/transaction-statement-pdf.md](docs/transaction-statement-pdf.md) — 세금계산서와는 별개인 거래명세서(법정 증빙서류 아님) 서버사이드 PDF 생성. 아키텍처, 잠긴 설계 결정(주소 미등록 시 발행 차단, 한글 폰트는 Git LFS가 아닌 일반 git blob으로 커밋 — Vercel 500 버그로 뒤집음), 검증 상태(실계정 라이브 미검증), 남은 과제.

## 국세청 사업자등록정보 진위확인 API 연동 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- data.go.kr 국세청_사업자등록정보 진위확인 API로 입점 승인 심사를 실제 국세청 데이터와 대조하도록 변경. 체크섬(형식) 검증만으로는 실존하지 않는 가짜 번호도 승인 버튼이 활성화되던 문제를 해결. 개업일자(`business_start_date`) 컬럼 신규 추가, 기존 승인대기 공급사는 재제출 필요.

## 계산서(면세) 작성 도우미 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/tax-invoice-draft.md](docs/tax-invoice-draft.md) — 세금계산서 자동발행(Post-MVP, 미착수)과는 별개로, 홈택스 수동 입력을 돕는 계산서(면세) 작성 초안 PDF 도우미. 과세/면세 판단 근거(잠긴 결정), 아키텍처, 남은 과제.

## 계산서(면세) 국세청 실제 발행/정정 — 팝빌 연동 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/tax-invoice-nts-filing.md](docs/tax-invoice-nts-filing.md) — 위 작성 도우미(PDF만)에서 한 단계 더 나아가 팝빌(ASP)로 실제 국세청 접수까지 대행. 알림톡과 달리 플랫폼-파트너 1건 계약 구조(공급사별 계약 아님), 최초발행+정정신고(수정사유 6종) 지원. 잠긴 설계 결정, SDK 의존성 예외 허용 사유, 미검증 항목(팝빌 계약 전이라 실호출 전무).

## PG(토스페이먼츠) 결제 연동 + 고객별 결제수단 관리 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/pg-payment-integration.md](docs/pg-payment-integration.md) — 직접정산/외상에 PG(카드) 결제 추가 + 공급사가 거래처별로 결제수단을 켜고 끄는 허용목록. 알림톡과 동일한 "공급사가 PG사와 개별 가맹계약" 구조. 잠긴 설계 결정("결제 확정 후에만 주문 생성" — 유령 주문 알림 방지, 취소 시 환불 성공해야만 상태 전이 허용). 토스페이먼츠 계정 미발급이라 실호출 전무.

## 대문 개편 + 고객사 입점 희망 리드 수집 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/landing-page-and-retailer-leads.md](docs/landing-page-and-retailer-leads.md) — 개발용 대시보드 링크 나열이던 대문을 실제 소개 화면으로 개편. "매칭"은 알고리즘이 아니라 관리자가 리드 목록(`/admin/retailer-leads`)을 보고 공급사에 수동으로 의뢰하는 구조(잠긴 결정). 리드 제출은 비로그인 허용, 조회/상태관리는 super_admin 전용.

## 배송 조회 스위트트래커 연동 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/delivery-tracking.md](docs/delivery-tracking.md) — 운송장 발급/배송비 정산은 대행하지 않고 스위트트래커 API로 조회만 대행. 잠긴 설계 결정(정산 비관여, 상태 캐싱 안 함, Server Action 패턴), 아키텍처. API 키 미발급(2026-09-17 기준)이라 실조회 미검증 — 문서·코드 준비만 완료.

## 배송의뢰서 자동 생성 (delivery-tracking 연장, 별도 기능)

- [docs/delivery-request-document.md](docs/delivery-request-document.md) — 운송장 발급 대행 원칙은 유지한 채, 주문 데이터로 가격 없는 배송의뢰서 PDF를 자동 생성(거래명세서 PDF 파이프라인 재사용). 택배사 API 자동발급은 문서/계약 없어 보류, 목록 화면 일괄 처리도 미착수.

## 축산물 경락가격 위젯 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/market-price-widget.md](docs/market-price-widget.md) — ROADMAP §1 공공 시세 API 연동. 원매가 참고란 옆에 오늘 전국 평균 경락가(소/돼지)를 보여주는 참고용 위젯. DB 테이블·API 클라이언트·크론·조회 액션·UI 위젯까지 코드 전부 완료(커밋 전). KAPE API 키만 미발급 — 발급 전엔 위젯이 "시세 데이터 없음" 안내로 안전하게 폴백.

## 카카오 알림톡 실제 발송 연동 (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/alimtalk-integration.md](docs/alimtalk-integration.md) — 기존 스텁(플랫폼 공용 키 가정)을 공급사별 자격정보(비즈뿌리오 1:1 계약) 구조로 전면 재설계. 잠긴 설계 결정(비밀번호 AES 암호화 저장, 플랫폼이 대행사 계정 관리 안 함, 설정 화면 owner/manager 전용), 비즈뿌리오 API 스펙, 코드 전부 완료. 실계정 미검증.

## 플랫폼 구독료 (거래처 수 비례 종량제) (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/platform-subscription-billing.md](docs/platform-subscription-billing.md) — 공급사가 플랫폼에 내는 구독료(거래처 1곳당 월 5,000원, 거래중 상태만 카운트) + 무료체험 30일 + 연체/해지/체험만료 시 `/dashboard` 접근 차단(`/billing-locked`로 리다이렉트). 결제 자동화는 미정 — 지금은 `/admin/suppliers`에서 super_admin 수동 확인/전환.

## Downloads 폴더 패치 3개 보류 (2026-09-16, Vercel 배포 우선 진행 중)

- [docs/deferred-drive-patches.md](docs/deferred-drive-patches.md) — 이전 세션 산출물 패치 3개(PRD/ROADMAP 8번 섹션 추가, wholesaler 구버전 화면 삭제, KNOWN_GAPS.md 신규 생성) 검토 결과 전부 stale로 판정, 적용 보류. Vercel 배포 완료 후 재검토 예정.

## 축산물 이력 입고 시스템 (바코드 스캔 + 박스 단위 재고) (별도 기능)

- [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) — 이력번호 바코드/카메라 스캔 → 공공 API 대조 검증 → 박스 단위 입고. 스택 결정(별도 백엔드 대신 기존 Next.js+Supabase에 얹음, RLS가 이유), 잠긴 설계 결정 8가지(재고 단위는 이력번호가 아닌 박스, 원장 파생 재고, `products` 스키마 무변경, 출고 박스 단위 추적, Hobby 크론 제약 우회), 입고 9종 + 출고 6종 로컬 DB 테스트 통과. **출고 자동 차감까지 완료** — 주문 확정 시 `orders` 트리거가 선입선출로 박스에서 차감하고 취소 시 원복, 재고 부족이면 확정 자체를 막는다. 원장 첫 편입 시 기존 수동 재고를 `OPENING_BALANCE`로 이관해 증발을 막는다. 공공 API 인증키 미발급이라 실호출 전무, npm 프록시 차단으로 타입체크 미실행.


## 명세서 번호 표기 경우의 수 대응 (2026-09-25, 29단계 보강)

- [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) 맨 아래 "29단계 보강" 절 — 하이픈·0 탈락·과학표기·`로트/LOT` 헤더·한 칸에 번호 여럿(줄 나눔, 합계는 첫 줄)·부속 줄 합치기·**묶음번호 열+개체번호 열 두 칸**(`inbound_document_lines.lot_no`, 마이그레이션 115, 사전조회가 로트 구성원 대조). 묶음번호만 있는 명세서는 여전히 `trace_no`(재고 단위 = 로트). 116: 명세서는 로트·박스는 개체번호(또는 반대)일 때 `master_livestock.raw_payload`의 구성원 목록으로 잇는 다리(`document_lines_matching_trace`, 대기 목록·근거 대조 RPC 2개). **명세서 줄을 번호로 찾는 새 쿼리는 직접 `trace_no =`를 쓰지 말고 `document_lines_matching_trace()`를 쓴다.** 117: 명세서 저장 시 먼저 찍힌 미확정·예외 박스를 거슬러 확정(`relink_pending_scans_to_documents`), 스캔 시 GTIN 학습과 명세서가 다른 상품이면 `productConflict`로 알림. 115~117 라이브 미적용(113·114도), 실제 파일 미검증.

## 보안 점검 — 권한 게이트 NULL 비교 버그 수정 (2026-09-24, 별도 발견)

- [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) 맨 아래 "보안 점검" 절 — plpgsql `IF a <> NULL`이 거짓으로 취급돼 고객 계정이 남의 재고를 조정하고 staff가 owner/manager 전용 RPC를 우회하던 구멍. 마이그레이션 097에서 `can_manage_wholesaler` 헬퍼 + 8개 함수 게이트 교체, 엑셀 대량입고 이중 처리 방지 포함. 098에서 후속 8건 전부 처리(공용 이력캐시 `upsert_master_livestock`은 service_role 전용 → 서버는 `lib/livestock/master-cache.ts`로만 호출, 원가(매입단가)는 관리자만 입력, 명세서 완전삭제 관리자만, 출고 스캔 `p_scan_id` 박스 지정 등). **새 RPC의 소유/권한 검사는 `<>` 비교 대신 `can_access_wholesaler` / `can_manage_wholesaler`를 쓴다.** 로컬 DB 테스트 스크립트는 첫머리에서 `upsert_master_livestock`을 테스트 세션에만 다시 GRANT한다.
- 같은 문서 "점검 1" 절 — 099: 핫딜 마이그레이션(091~094)이 `apply_order_shipment`를 옛 본문으로 되돌린 회귀 복원(079 순량 판정·그램 정밀도), 동시 확정 레이스(잠금 순서는 "박스 → 상품" 유지, `recalc_product_stock`이 상품 행을 잠근 뒤 합계를 읽음), 자동 배정된 박스 출고 스캔 거부 버그. **재고를 줄이는 새 함수는 반드시 `recalc_product_stock`을 마지막에 부르고, 상품 행을 박스보다 먼저 잠그지 않는다. 함수 본문을 다시 정의할 때는 마이그레이션 파일이 아니라 로컬 DB의 `pg_get_functiondef` 결과를 기준으로 패치한다(079 방식).**
- 같은 문서 "점검 2" 절 — 100: 확정 자동배정에서 기한 지난 박스 제외(가용량 = 쓸 수 있는 박스 + 박스 없는 재고), 세트 지정 시 수동 재고 0 요구(유령 세트 방지), 보관 구성품 제작 거부, 선입선출 보조 정렬 `trace_no`.
- [docs/pg-payment-integration.md](docs/pg-payment-integration.md) "점검 3" 절 — 101: `orders(pg_order_id)` 유니크 + `finalizePaidOrder` 멱등, 핫딜 매진 시 PG 자동 환불(A안), 크론 3개는 `CRON_SECRET` 필수(Vercel env 없으면 크론이 거부됨).
- [docs/integration-test-plan.md](docs/integration-test-plan.md) 0절 "발견해 102로 수정한 구멍" — 102: 바이어 취소요청 RLS 회귀 복원(024가 0912를 되돌렸었음), `wholesalers` 플랫폼 전용 컬럼 보호 트리거(`enforce_wholesaler_platform_columns`, super_admin 세션·서버·RPC 내부만 통과), 재고 내부함수 4개 anon·authenticated EXECUTE 회수, `reserve_hot_deal_quota` 소유·접수대기·주문당 1회, `apply_credit_order` 음수 거부. **트리거 내부용 SECURITY DEFINER 함수를 새로 만들면 anon·authenticated EXECUTE를 반드시 회수한다.** 103: 바이어 세션의 order_items INSERT를 서버 규칙(상품 소속·주문 가능·수량·소계·핫딜가/맞춤단가/기준가·총액)으로 대조하는 `enforce_order_item_integrity` 트리거(핫딜 줄은 여기서 한도 소진), `reserve_hot_deal_quota` 멱등화, 실패 주문 정리 RPC `discard_unfulfilled_order`(바이어 세션의 `orders.delete()`는 DELETE 정책이 없어 0행이었음). 테이블 RLS 격리·품목 무결성 테스트는 `scripts/db-test-access-isolation.sql`(123건). 104: 승인된 공급사 탈퇴가 프로필 트리거에 막히던 버그(내부 플래그로 감쌈), 매니저의 owner 초대 링크 생성 차단(`enforce_staff_invite_role`). 가입·초대·탈퇴 테스트는 `scripts/db-test-signup-and-accounts.sql`(80건). 105(사장님 결정): 고객 탈퇴도 미정산 외상 있으면 보류(약관 근거 조항은 사장님 정비), 직원 초대 링크 1회용, 세트 지정·해제 RPC는 owner/manager만. 상품 관리 테스트는 `scripts/db-test-product-management.sql`(62건). **profiles의 is_verified/role을 바꾸는 새 RPC는 `set_config('app.supplier_onboarding','on',true)`로 감싸야 트리거를 통과한다.** 106(사장님 결정): 공급처 명세서는 취소(DISCARDED) 처리된 것만 DB에서도 완전삭제 가능(`DOCUMENT_NOT_DISCARDED` 트리거, 서버·super_admin 통과), 엑셀 입고 행 중량 `CHECK (> 0)`. 입고 테스트는 `scripts/db-test-inbound.sql`(111건). 107(사장님 결정): 주문 상태 전이표를 DB로 옮김(`enforce_order_status_transition`, `INVALID_STATUS_TRANSITION` — **`lib/orders/status.ts`의 `ORDER_STATUS_TRANSITIONS`를 고치면 이 함수도 새 마이그레이션으로 같이 고친다**), 바이어 세션 주문 헤더 총액 < `min_order_amount` 거부(`MIN_ORDER_AMOUNT`). 바이어 세션으로 소액 주문을 시드하는 테스트는 시드 공급사 `min_order_amount`를 0으로 둔다. 출고·주문 테스트는 `scripts/db-test-orders-outbound.sql`(59건). 108: 외상 정산에서 취소 주문 제외, 바이어 취소요청 UPDATE가 결제·배송 컬럼을 원본으로 되돌림(**바이어 경로에서 취소요청 외의 컬럼을 새로 쓰게 되면 이 트리거 목록도 같이 고칠 것**). 결제·정산 테스트는 `scripts/db-test-payments-settlement.sql`(49건, `[발견]` 표시는 미수정 관찰), 서류발행은 `scripts/db-test-documents.sql`(38건). 109(사장님 결정): 계산서 발행이력은 주문당 살아 있는(pending·issued) 최초 이력 하나만(부분 유니크 `idx_tax_invoice_issuances_one_live_original`, 정정·failed·cancelled 제외), 발행이력 정책을 owner·manager로 확대(직원 제외).

## 자체 세트 상품(BOM) + 이력 역추적 (축산물 이력 입고 시스템 위, 23단계)

- [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) 23단계 — 도매업체가 임의로 묶은 세트에 자체 상품코드(`BND-0001`)와 세트번호(`SET-YYMMDD-NNN`)를 발행하고, 그 박스에 실제로 들어간 정부 이력번호를 1:N으로 묶어 남긴다(`bundle_assembly_sources`). 잠긴 결정 8가지(세트 상품도 그냥 `products` 한 행, 세트 박스도 `inbound_scans` 한 행, 재고 단위는 kg이 아닌 "세트 1개", 이력번호 없는 재고로는 세트를 못 만든다, 기한 지난 박스 제외, 중첩 세트 금지). 거래명세서·라벨은 세트를 구성 이력번호로 전개한다. DB 테스트 19종 통과, 실계정 미검증.

## 입고 실중량 검수 + 매입금액 자동 산정 (24단계)

- [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) 24단계 — 표기중량(바코드)과 실중량(저울)을 따로 받아 차이를 기록하고, 매입금액을 실중량 기준으로 자동 산정한다. 허용 오차 ±2%(`inbound_weight_tolerance()` ↔ `lib/livestock/weight-variance.ts`), 매입금액은 GENERATED 컬럼, 원가라 바이어에게 열지 않는다. `/dashboard/purchases` 매입 정산 화면. DB 테스트 12종 통과. **저울 직접 연동은 미구현(사람이 입력)**, npm 차단으로 타입체크 미실행.

## 통합테스트 시나리오 계획 (2026-09-24 시작, 별도 기능)

- [docs/integration-test-plan.md](docs/integration-test-plan.md) — 단위테스트(순수 로직)에서 뺐던 서버 액션/RLS 의존 로직 대상. 영역별 정상+오류 시나리오 목록, 로컬 Docker Supabase 환경(사장님 실제 프로젝트와 분리), 서버 액션 인증 하네스는 아직 미착수. 계획 도중 PG 결제 콜백 유실 버그를 발견해 별도로 수정함(아래 항목).

## PG 결제 승인 콜백 유실 시 복구 안전망 (통합테스트 계획 도중 발견, 별도 수정)

- 결제는 승인됐는데 콜백(`checkout/pg/success/route.ts`)이 브라우저 이탈 등으로 끝까지 못 가면 주문이 영영 안 생기던 문제. `lib/payments/pg-reconcile.ts` 신규(토스 orderId 조회로 재대조+복구) + 고객 주문내역 재방문 시 즉시확인 + 매일 크론(`/api/cron/reconcile-pg-payments`) 이중 안전망. 토스 실계정 미발급이라 실호출 미검증(기존 PG 연동과 동일 상태).

## 작업 성격별 모델 사용 기준 (2026-09-23, 사장님 확정)

Claude Max 요금제는 잔량 조회 API가 없어 실시간 동적 라우팅은 불가능 — 대신 작업 성격 기준의 고정 규칙.

**격상은 굉장히 보수적으로 판단한다.** ②·③은 예외이지 기본이 아니다 — 애매하면 격상하지 말고 Sonnet 5로 진행하고, 결과가 실제로 부족했을 때만 그 다음 단계로 올린다. "이 정도면 어려운 편이니 미리 Opus로" 식의 선제적 격상은 하지 않는다.

**① Sonnet 5 (기본값 — 대부분의 작업)**
- 스펙이 명확한 신규 기능 추가
- 원인을 코드에서 특정할 수 있는 버그 수정
- 기존 동작을 유지한 채 구조만 정리하는 리팩터링
- 패턴이 명확한 대량 기계적 수정 (여러 파일에 걸친 동일 패턴 적용/제거)
- 문서 작성·정리, 일반적인 코드 리뷰

**② Opus 5로 격상 — 아래 신호가 나오면**
- 같은 문제를 2번 이상 잘못 고치거나 결과가 계속 애매할 때
- 트레이드오프를 깊이 따져야 하는 설계 결정(DB 스키마, 대규모 아키텍처 방향)
- 요구사항 자체가 모호해서 여러 시나리오를 스스로 추론해야 할 때
- 보안 관련 코드(RLS 정책, 권한 로직) 검토 — 실수 비용이 큼
- 동시성·트랜잭션 관련 버그(레이스 컨디션 등 추론이 까다로운 것)

**③ Fable 5.1 — 아주 가끔, 진짜 크고 장기적인 작업만**
- 처음부터 새 시스템/마이그레이션을 설계하는 대형 아키텍처 결정
- 몇 시간짜리 자율 작업이라 중간중간 스스로 판단을 계속 내려야 하는 경우
- 여러 유효한 접근법 중 최적을 찾으려 깊은 추론이 필요한 경우

**④ 서브에이전트(Agent 도구) 위임 시**
- 단순 탐색·대량 기계적 편집: 기본(가벼운) 모델로 충분
- 복잡한 판단이 들어가는 위임만 Opus로 개별 지정

## 축종별 상품 정체성 키 (소 구현됨, 별도 기능)

- [docs/product-identity-by-species.md](docs/product-identity-by-species.md) — 소 = 축종+부위+등급+원산지가 키(중복 등록 거부·등록 후 잠금, 상품명은 "부위 등급" 자동 조합, 축종은 화면 [소] 태그). 돼지(축종+부위+원산지)·닭/오리(축종만)는 결정 대기 — `lib/products/identity-key.ts` 표에 한 줄 추가하면 됨. 입고 자동 생성(마이그레이션 113)도 같은 규칙 + 명세서 기반 등급 채움. 이력번호 12자리 첫 자리가 축종코드(소0·돼지1·닭2·계란3·오리5). 소 외 축종은 이력번호 파싱 출처(농장·도축장)+명세서 부위가 키(마이그레이션 114, `products.trace_key`, 자동 생성 경로만). 라이브 마이그레이션 113·114 미적용.
