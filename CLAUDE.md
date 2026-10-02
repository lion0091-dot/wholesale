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

- [docs/alimtalk-integration.md](docs/alimtalk-integration.md) — 기존 스텁(플랫폼 공용 키 가정)을 공급사별 자격정보(비즈뿌리오 1:1 계약) 구조로 전면 재설계. 잠긴 설계 결정(비밀번호 AES 암호화 저장, 설정 화면 owner/manager 전용), 비즈뿌리오 API 스펙, 코드 전부 완료. 실계정 미검증. **2026-09-30 추가(사장님 결정)**: "플랫폼은 대행사 계정을 대신 관리하지 않는다"가 절대 규칙에서 기본값 우선순위로 바뀜 — 공급사 개별 등록(`wholesalers.alimtalk_*`)이 항상 우선하되, 없으면 플랫폼 대표 채널(`ALIMTALK_PLATFORM_*` 환경변수, 아직 비어있음)로 폴백. 대량 방송 기능이 코드에 없어(전부 이벤트 1건=수신자 1명) 비용 폭증 위험은 낮지만 종량제 비용 자체는 발생. 환경변수 채워 실제 가동 시 `app/privacy/page.tsx` 5조(비즈뿌리오를 "공급사가 직접 계약"→"회사가 위탁"으로 이동) 동시 수정 필수, 아직 안 함.

## 재고 재설계 "재고는 박스, 상품은 조건" (2026-10-01, 설계안·승인 대기, 코드 없음)

- [docs/stock-redesign-boxes-and-conditions.md](docs/stock-redesign-boxes-and-conditions.md) — 등급 섞인 로트 박스가 첫 개체 등급으로 정밀 상품 재고에 들어가는 거짓 재고(실조회 `L02011163016114`로 확정) 해결. 박스 꼬리표(조회로만 채움, 로트는 구성 순회·"혼합") + 상품=조건(NULL=상관없음, 같은 박스가 여러 상품 재고에 동시 집계) + 접는 트리 재고 화면 + 쪼개기(지육→부위 박스) + 발주 대조는 부위·중량만. **승인 전엔 코드 손대지 말 것.** 원칙: 현장 수작업은 실중량뿐, 유저가 구조를 이해할 필요 없음.

## 알림 채널 정리 — 알림톡 8종·화면 알림 Realtime (2026-10-01, 별도 기능)

- [docs/alimtalk-integration.md](docs/alimtalk-integration.md) 맨 위 "2026-10-01 추가" 절 — 알림 14건을 "받는 사람이 그 순간 화면을 보는가"로 나눠 채널 확정. 알림톡 12종→8종(내부 통지 3종은 대시보드 알림함 예정, 고객 외상 거절은 삭제), 공급사용 4종은 웹푸시로 대체 예정(미착수), 종 배지·고객 배송 벨은 Realtime(마이그 187, `lib/hooks/use-realtime-refresh.ts`). ② 알림함 완료(마이그 188, 새 표 없이 `audit_log` 재사용, `lib/supplier/internal-notices.ts`, 대표·매니저만, 숫자 대신 파란 점). ③ 웹푸시 완료(마이그 189 `push_subscriptions`, `web-push` 의존성, `lib/notifications/wholesaler-alerts.ts`가 "켠 브라우저 있으면 푸시만, 없으면 알림톡" 선택, VAPID 키 없으면 버튼 숨김·알림톡만). **배송 시작 알림톡은 추가하지 않는다(배송기사가 알림)**. 입고 화면도 Realtime(`inbound-live-refresh.tsx`).

## 플랫폼 구독료 (거래처 수 비례 종량제) (feat/platform-admin-allowlist 브랜치 위에서 진행, 별도 기능)

- [docs/platform-subscription-billing.md](docs/platform-subscription-billing.md) — 공급사가 플랫폼에 내는 구독료(거래처 1곳당 월 5,000원, 거래중 상태만 카운트) + 무료체험 30일 + 연체/해지/체험만료 시 `/dashboard` 접근 차단(`/billing-locked`로 리다이렉트). 결제 자동화는 미정 — 지금은 `/admin/suppliers`에서 super_admin 수동 확인/전환.

## Downloads 폴더 패치 3개 보류 (2026-09-16, Vercel 배포 우선 진행 중)

- [docs/deferred-drive-patches.md](docs/deferred-drive-patches.md) — 이전 세션 산출물 패치 3개(PRD/ROADMAP 8번 섹션 추가, wholesaler 구버전 화면 삭제, KNOWN_GAPS.md 신규 생성) 검토 결과 전부 stale로 판정, 적용 보류. Vercel 배포 완료 후 재검토 예정.

## 축산물 이력 입고 시스템 (바코드 스캔 + 박스 단위 재고) (별도 기능)

- [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) — 이력번호 바코드/카메라 스캔 → 공공 API 대조 검증 → 박스 단위 입고. 스택 결정(별도 백엔드 대신 기존 Next.js+Supabase에 얹음, RLS가 이유), 잠긴 설계 결정 8가지(재고 단위는 이력번호가 아닌 박스, 원장 파생 재고, `products` 스키마 무변경, 출고 박스 단위 추적, Hobby 크론 제약 우회), 입고 9종 + 출고 6종 로컬 DB 테스트 통과. **출고 자동 차감까지 완료** — 주문 확정 시 `orders` 트리거가 선입선출로 박스에서 차감하고 취소 시 원복, 재고 부족이면 확정 자체를 막는다. 원장 첫 편입 시 기존 수동 재고를 `OPENING_BALANCE`로 이관해 증발을 막는다. 공공 API 인증키 미발급이라 실호출 전무, npm 프록시 차단으로 타입체크 미실행.


## 명세서 번호 표기 경우의 수 대응 (2026-09-25, 29단계 보강) — 기능 전체 제거됨 (2026-09-28)

**명세서(전표) 구조화·자동추출·대조 화면 기능 전체를 사장님 결정으로 걷어냈다**(마이그레이션 152, 2026-09-28). 종이 원본을 실물로 보관할 것이므로 디지털 구조화가 재고 정확도에 불필요하다는 판단 — 재고·매입금액은 이미 박스 스캔(24단계) 기준으로만 계산됐다. `inbound_documents`/`inbound_document_lines`/`supplier_document_formats` 테이블, 관련 함수·화면(`/dashboard/inbound/statements`, `/dashboard/inbound/documents/[id]`)·테스트가 전부 삭제됐다. 아래 두 항목은 과거 기록이다. 남은 것: 발주서-스캔 대조(142)와 보류함(발주서 추가 생성만, [docs/purchase-order-receiving.md](docs/purchase-order-receiving.md) 참고).

- [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) 맨 아래 "29단계 보강" 절 [과거 기록] — 하이픈·0 탈락·과학표기·`로트/LOT` 헤더·한 칸에 번호 여럿(줄 나눔, 합계는 첫 줄)·부속 줄 합치기·**묶음번호 열+개체번호 열 두 칸**(`inbound_document_lines.lot_no`, 마이그레이션 115, 사전조회가 로트 구성원 대조). 묶음번호만 있는 명세서는 여전히 `trace_no`(재고 단위 = 로트). 116: 명세서는 로트·박스는 개체번호(또는 반대)일 때 `master_livestock.raw_payload`의 구성원 목록으로 잇는 다리(`document_lines_matching_trace`, 대기 목록·근거 대조 RPC 2개). **명세서 줄을 번호로 찾는 새 쿼리는 직접 `trace_no =`를 쓰지 말고 `document_lines_matching_trace()`를 쓴다.** 117: 명세서 저장 시 먼저 찍힌 미확정·예외 박스를 거슬러 확정(`relink_pending_scans_to_documents`), 스캔 시 GTIN 학습과 명세서가 다른 상품이면 `productConflict`로 알림. 115~117 라이브 미적용(113·114도), 실제 파일 미검증.
- ~~docs/inbound-document-reconciliation-spec.md~~ — **29단계 B(사무실 대조 화면) 스펙, 문서 자체가 삭제됨.** [과거 기록] DB 뼈대는 118(`inbound_document_line_scans` 연결표, 줄 상태 계산, 자동 배정은 하나일 때만, 중복 창 우회, 마감/다시 열기)로 완료·로컬 테스트 7건 통과했으나, 화면·액션은 결국 안 만든 채로 기능 자체가 제거됐다.

## 보안 점검 — 권한 게이트 NULL 비교 버그 수정 (2026-09-24, 별도 발견)

- [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) 맨 아래 "보안 점검" 절 — plpgsql `IF a <> NULL`이 거짓으로 취급돼 고객 계정이 남의 재고를 조정하고 staff가 owner/manager 전용 RPC를 우회하던 구멍. 마이그레이션 097에서 `can_manage_wholesaler` 헬퍼 + 8개 함수 게이트 교체, 엑셀 대량입고 이중 처리 방지 포함. 098에서 후속 8건 전부 처리(공용 이력캐시 `upsert_master_livestock`은 service_role 전용 → 서버는 `lib/livestock/master-cache.ts`로만 호출, 원가(매입단가)는 관리자만 입력, 명세서 완전삭제 관리자만, 출고 스캔 `p_scan_id` 박스 지정 등). **새 RPC의 소유/권한 검사는 `<>` 비교 대신 `can_access_wholesaler` / `can_manage_wholesaler`를 쓴다.** 로컬 DB 테스트 스크립트는 첫머리에서 `upsert_master_livestock`을 테스트 세션에만 다시 GRANT한다.
- 같은 문서 "점검 1" 절 — 099: 핫딜 마이그레이션(091~094)이 `apply_order_shipment`를 옛 본문으로 되돌린 회귀 복원(079 순량 판정·그램 정밀도), 동시 확정 레이스(잠금 순서는 "박스 → 상품" 유지, `recalc_product_stock`이 상품 행을 잠근 뒤 합계를 읽음), 자동 배정된 박스 출고 스캔 거부 버그. **재고를 줄이는 새 함수는 반드시 `recalc_product_stock`을 마지막에 부르고, 상품 행을 박스보다 먼저 잠그지 않는다. 함수 본문을 다시 정의할 때는 마이그레이션 파일이 아니라 로컬 DB의 `pg_get_functiondef` 결과를 기준으로 패치한다(079 방식).**
- 같은 문서 "점검 2" 절 — 100: 확정 자동배정에서 기한 지난 박스 제외(가용량 = 쓸 수 있는 박스 + 박스 없는 재고), 세트 지정 시 수동 재고 0 요구(유령 세트 방지), 보관 구성품 제작 거부, 선입선출 보조 정렬 `trace_no`.
- [docs/pg-payment-integration.md](docs/pg-payment-integration.md) "점검 3" 절 — 101: `orders(pg_order_id)` 유니크 + `finalizePaidOrder` 멱등, 핫딜 매진 시 PG 자동 환불(A안), 크론 3개는 `CRON_SECRET` 필수(Vercel env 없으면 크론이 거부됨).
- [docs/integration-test-plan.md](docs/integration-test-plan.md) 0절 "발견해 102로 수정한 구멍" — 102: 바이어 취소요청 RLS 회귀 복원(024가 0912를 되돌렸었음), `wholesalers` 플랫폼 전용 컬럼 보호 트리거(`enforce_wholesaler_platform_columns`, super_admin 세션·서버·RPC 내부만 통과), 재고 내부함수 4개 anon·authenticated EXECUTE 회수, `reserve_hot_deal_quota` 소유·접수대기·주문당 1회, `apply_credit_order` 음수 거부. **트리거 내부용 SECURITY DEFINER 함수를 새로 만들면 anon·authenticated EXECUTE를 반드시 회수한다.** 103: 바이어 세션의 order_items INSERT를 서버 규칙(상품 소속·주문 가능·수량·소계·핫딜가/맞춤단가/기준가·총액)으로 대조하는 `enforce_order_item_integrity` 트리거(핫딜 줄은 여기서 한도 소진), `reserve_hot_deal_quota` 멱등화, 실패 주문 정리 RPC `discard_unfulfilled_order`(바이어 세션의 `orders.delete()`는 DELETE 정책이 없어 0행이었음). 테이블 RLS 격리·품목 무결성 테스트는 `scripts/db-test-access-isolation.sql`(123건). 104: 승인된 공급사 탈퇴가 프로필 트리거에 막히던 버그(내부 플래그로 감쌈), 매니저의 owner 초대 링크 생성 차단(`enforce_staff_invite_role`). 가입·초대·탈퇴 테스트는 `scripts/db-test-signup-and-accounts.sql`(80건). 105(사장님 결정): 고객 탈퇴도 미정산 외상 있으면 보류(약관 근거 조항은 사장님 정비), 직원 초대 링크 1회용, 세트 지정·해제 RPC는 owner/manager만. 상품 관리 테스트는 `scripts/db-test-product-management.sql`(62건). **profiles의 is_verified/role을 바꾸는 새 RPC는 `set_config('app.supplier_onboarding','on',true)`로 감싸야 트리거를 통과한다.** 106(사장님 결정): 공급처 명세서는 취소(DISCARDED) 처리된 것만 DB에서도 완전삭제 가능(`DOCUMENT_NOT_DISCARDED` 트리거, 서버·super_admin 통과), 엑셀 입고 행 중량 `CHECK (> 0)`. 입고 테스트는 `scripts/db-test-inbound.sql`(111건). 107(사장님 결정): 주문 상태 전이표를 DB로 옮김(`enforce_order_status_transition`, `INVALID_STATUS_TRANSITION` — **`lib/orders/status.ts`의 `ORDER_STATUS_TRANSITIONS`를 고치면 이 함수도 새 마이그레이션으로 같이 고친다**), 바이어 세션 주문 헤더 총액 < `min_order_amount` 거부(`MIN_ORDER_AMOUNT`). 바이어 세션으로 소액 주문을 시드하는 테스트는 시드 공급사 `min_order_amount`를 0으로 둔다. 출고·주문 테스트는 `scripts/db-test-orders-outbound.sql`(59건). 108: 외상 정산에서 취소 주문 제외, 바이어 취소요청 UPDATE가 결제·배송 컬럼을 원본으로 되돌림(**바이어 경로에서 취소요청 외의 컬럼을 새로 쓰게 되면 이 트리거 목록도 같이 고칠 것**). 결제·정산 테스트는 `scripts/db-test-payments-settlement.sql`(49건, `[발견]` 표시는 미수정 관찰), 서류발행은 `scripts/db-test-documents.sql`(38건). 109(사장님 결정): 계산서 발행이력은 주문당 살아 있는(pending·issued) 최초 이력 하나만(부분 유니크 `idx_tax_invoice_issuances_one_live_original`, 정정·failed·cancelled 제외), 발행이력 정책을 owner·manager로 확대(직원 제외).

## 자체 세트 상품(BOM) — 제거됨 (2026-09-26, 사장님: "세트 상품은 없는 개념")

- 23단계에서 만든 세트(자체 상품코드·세트번호·구성 이력번호 역추적)를 전부 걷어냈다. 마이그레이션 122(표 4개·함수 9개·트리거 삭제, 거래명세서·라벨·재고 요약 함수를 세트 없이 재작성, CHECK에서 세트 값 제거, 소 유니크 인덱스의 "단위가 세트면 제외" 우회 제거). 라이브에는 세트 데이터가 0건이었다. [docs/livestock-inbound-tracking.md](docs/livestock-inbound-tracking.md) 23단계 절은 과거 기록이다.

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

- [docs/product-identity-by-species.md](docs/product-identity-by-species.md) — 소 = 축종+부위+등급+원산지가 키(중복 등록 거부·등록 후 잠금, 상품명은 "부위 등급" 자동 조합, 축종은 화면 [소] 태그). 돼지(축종+부위+원산지)·닭/오리(축종만)는 결정 대기 — `lib/products/identity-key.ts` 표에 한 줄 추가하면 됨. 입고 자동 생성(마이그레이션 113)도 같은 규칙. 이력번호 12자리 첫 자리가 축종코드(소0·돼지1·닭2·계란3·오리5). 소 외 축종은 이력번호 파싱 출처(농장·도축장)가 키(마이그레이션 114, `products.trace_key`, 자동 생성 경로만) — 명세서 기반 부위 보조 채움(114 당시)은 152(2026-09-28)로 제거됨, 지금은 이력조회 값만 쓴다. 113·114·121 라이브 적용됨(121 = 소 DB 유니크 인덱스, 세트 상품은 단위 "세트"로 제외 — 상세는 docs 문서). **2026-09-28 추가**: 수입소고기는 품종·등급 개념 자체가 없음을 실제 API 조회로 확인, 원산지가 "국내산"일 때만 폼이 품종·등급을 필수로 요구하도록 수정(`isDomesticOrigin()`, DB는 이미 NULL을 올바르게 처리하고 있어 마이그레이션 불필요) — 상세는 docs 문서 맨 위.

## 검증 규칙 — 배포 전 점검 방식 (2026-09-26 확정, 별도 규칙)

- [docs/verification-rules.md](docs/verification-rules.md) — 배포 전에 단위·통합·빌드에 더해 **찐오류 점검(재현되는 것만) · 규모 부하 측정(줄 수천·박스 수천, 화면 로드/주기 호출 함수) · 따라가기 끊김 점검(카드 상태 표)**을 한다. 테스트가 통과해도 규모·안내 흐름 문제는 안 잡히기 때문. 함수를 다시 짜면 옛 함수와 결과를 양방향 비교, 새 성능 가드는 옛 느린 버전으로 되돌려 실패하는지 확인. 카드 상태나 주기 호출 DB 함수를 추가하면 `inbound-next-step.matrix.test.ts`·`tests/integration/perf-guard.itest.ts`에 넣는다.

## 입고 ↔ 발주서 연결 (2026-09-28, 별도 기능)

- [docs/purchase-order-receiving.md](docs/purchase-order-receiving.md) — 입고 박스를 "지금 온 거래처"의 열린 발주서 줄과 맞춰 입고 기준(141)으로 받을지 판정(마이그 142, 라이브 적용·배포 완료). 초과 박스도 "일단 받고 사무실 확인"(over_item_policy HOLD) 선택지 있음. 발주 상태 용어: 자동 마감 "발주종결", 사람이 손으로 닫는 "강제종결". 전표↔발주서 연결(마이그 143)은 152(2026-09-28)로 전표 쪽만 걷어냈다 — 보류함 화면(`/dashboard/inbound/holds`)에서 owner/manager가 "발주서 추가 생성"을 누르면 이제 발주서만 사후 등록된다(전표는 더 이상 같이 안 만든다, 대표의 의사결정 원칙은 유지). 실화면 클릭 검증 전무.

## 수입축산물 이력 조회 — data.mafra.go.kr 실연동 (2026-09-28, 별도 기능)

**2026-10-01 사장님 결정: 아래 수동 조회 화면(`/dashboard/inbound/imported-lookup`)·`searchImportedTraceAction`·입고 탭 "수입육 조회"는 제거했다**(meatwatch.go.kr 조회오픈서비스 실시간 연동으로 대체 예정). `lib/livestock/meatwatch-client.ts`의 API 클라이언트는 남겨 뒀다.

`lib/livestock/meatwatch-client.ts` — 수입육 이력은 `meatwatch.go.kr` 별도 기업심사가 아니라 **data.mafra.go.kr(농림축산식품부 공공데이터포털)**에서 키를 발급받아 실주소·실호출로 검증 완료(경로 방식 `/openapi/{API_KEY}/json/{GRID_ID}/{시작}/{끝}?IMPORT_DE=...`가 정상 동작, 쿼리스트링으로 API_KEY 넘기는 방식은 실패). **이 API는 이력번호로 직접 조회가 안 되고 수입일자(IMPORT_DE, 필수)로만 그날 목록을 받을 수 있다** — 그래서 국내산(mtrace)과 달리 현장 스캔 자동조회에는 안 붙였다(하루치 최대 몇백 건을 실시간 스캔 타임아웃 안에 다 훑는 건 무리). 대신 수입일자를 아는 사무실 직원이 직접 조회하는 화면 `/dashboard/inbound/imported-lookup`(보류함과 같은 급, PC 전용 탭)을 새로 만들었다 — 날짜+선택 필터로 조회해 목록에서 번호를 눈으로 대조한다, 조회 결과는 저장 안 함. `lib/livestock/mtrace-client.ts`의 기존 `meatwatch` TraceSource(REST 번호검색 가정)는 이 실제 API와 구조가 안 맞아 여전히 미사용 죽은 코드로 남아 있다. `.env.example`에 `MEATWATCH_API_BASE`·`MEATWATCH_GRID_ID` 추가(기본값 있어 보통 안 건드려도 됨). 실호출 검증 완료, 화면 클릭 검증은 아직.

## 개인정보 수명주기·접속기록·법률자문 (2026-09-30, 별도 기능)

- 가입 미완료 30일 자동삭제(마이그 165 공급사·166 고객, 크론 `purge-unconsented-accounts`), 탈퇴 익명화(000·001·168·171: 이메일·카카오 식별자 정리, 고객 상호·사업자번호는 유지), 탈퇴 5년 후 개인정보 자동 파기(167·169·170, 주간 크론 `purge-expired-personal-data`: 대표자명·주소·자격정보·주문 배송지·변경이력 복사본·발주처 연락처, **명세서 파일·주문번호·금액·이력번호는 유지**), 입점 문의 1년 삭제(170), 접속기록 `access_log`(171: 로그인·관리자 화면 진입, 2년 보관 후 삭제, 슈퍼관리자만 조회). 기간 상수는 `withdrawn_data_retention()`·`match_request_retention()`·`access_log_retention()` 한 곳씩. 로컬 테스트: `scripts/db-test-purge-withdrawn.sql`(20건), `db-test-stale-*.sql`. **5년·1년·2년은 대표 결정이며 법령 원문 미확인 — 변호사 자문서(claude.ai 문서 "장터 개인정보 보호 현황 및 법률자문 요청사항", Word 사본은 사장님 바탕화면) 질문 8·13 답 후 확정.**
- [docs/data-breach-response.md](docs/data-breach-response.md) — 유출 대응 절차 초안(변호사 확인 전).
- 접속기록 범위는 로그인과 관리자 화면 진입뿐이다. 공급사 대시보드의 개인정보 조회·다운로드는 아직 기록하지 않는다(필요하면 `lib/security/access-log.ts`의 `recordAccess` 호출을 추가).


## 공급사·고객 간 데이터 섞임 방어 (2026-10-02, 별도 기능)

- [docs/tenant-isolation-runbook.md](docs/tenant-isolation-runbook.md) — 맞춤단가 교차 소유 구멍 발견·수정(마이그 200: 22쌍 참조 컬럼에 `enforce_tenant_refs` 트리거, `tenant_consistency_violations()` 일일 크론). 새 규칙: **공급사 소유 표가 다른 공급사 소유 표를 FK로 가리키면 같은 마이그레이션에서 가드 트리거를 건다**(안 걸면 `tenant-isolation.itest.ts` 실패). 터졌을 때 복구 순서. **운영 프로젝트 백업 0건·PITR 꺼짐 — 영업 시작 전이라 보류, 첫 실데이터 입력 전에 Pro($25) 전환 필수(런북 4절).**

## 크론 실행 상태 확인 (2026-10-02, 별도 기능)

- [docs/cron-health.md](docs/cron-health.md) — Vercel 크론은 실패해도 재시도·알림이 없고 누락 시 로그도 안 남아, 크론마다 `cron_runs`에 결과를 남기고 `/admin/cron-health`가 "오래 성공 없음"을 빨간색으로 표시(마이그 204). 새 크론은 `withCronHeartbeat`로 감싸고 `CRON_JOBS`에 추가(테스트가 강제). 운영 DB 적용 전, 알림 푸시는 미결정.

## 주문 알림 지킴이 + Realtime 인증 버그 수정 (2026-10-02, 별도 기능)

- [docs/order-alert-guard.md](docs/order-alert-guard.md) — 카카오 채널 승인 전이라 웹푸시가 유일한 주문 알림 채널 → 꺼져 있으면 빨간 줄(A), 첫 방문 안내 창(B), 화면 열린 동안 새 주문 소리·알림 창(F). 같이 발견: 브라우저 Realtime이 토큰 없이 붙어 변화를 못 받던 버그를 `authorizeRealtime()`으로 수정. 운영 화면 확인 전.

## 공급사 가입→승인→첫 고객 초대 "지금 할 일" 카드 (2026-10-02, 별도 기능)

- [docs/onboarding-next-step-card.md](docs/onboarding-next-step-card.md) — 대시보드 맨 위 카드 하나가 사업자 정보 제출·국세청 불일치 수정·심사 중·승인 대기 손님·첫 고객 초대까지 안내. 알림톡 없이 화면이 직접 알려 주는 것이 목적. 로컬 브라우저 확인, 운영 화면 확인 전.
