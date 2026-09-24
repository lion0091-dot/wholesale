# 통합테스트 시나리오 계획 (2026-09-24 시작)

[vitest-unit-tests-introduced](../lib) 단위테스트(순수 로직 102건)에서 명시적으로 뺐던
서버 액션·DB(RLS) 의존 로직을 대상으로 한다. 계산 로직이 아니라 **"진짜 DB가 그렇게
동작하는지"**(RLS 격리, 재고 차감, 결제 확정 순서 등)를 확인하는 것이 목적이라, 흉내
(mock) DB로는 의미가 없다 — 실제 Postgres가 필요하다.

## 환경

- 로컬 Docker로 Supabase 스택을 띄워서 사용(`supabase start`, `supabase/config.toml`
  2026-09-24 생성). 사장님 실제 Supabase 프로젝트와는 완전히 분리 — 테스트가 진짜
  데이터를 건드릴 위험 없음.
- 기존 마이그레이션 115개 전부 로컬에 반영 확인(39개 테이블 생성 확인, 2026-09-24).
- 카카오 로그인, 국세청, 팝빌, 비즈뿌리오 알림톡, 토스페이먼츠, 스위트트래커 등
  **외부 업체 API는 전부 흉내(mock)** — 로컬 DB로도 실제 호출은 불가능.
- 아직 구현 안 함: 서버 액션을 테스트에서 호출할 때 인증 세션을 흉내 내는 하네스
  (`lib/supabase/server.ts`의 쿠키 기반 세션 대신, 테스트용 사용자로 로그인한 JWT를
  주입하는 방식). 이 문서의 시나리오를 실제 테스트 코드로 옮기기 전에 먼저 만들어야 함.

## 진행 상태 표시

⬜ 미착수 · 🔲 하네스만 있고 시나리오 미작성 · 🟩 DB 함수(RPC/RLS) 레벨에서 통과 — 서버 액션 하네스는 아직 · ✅ 작성+통과

🟩는 2026-09-24 보안·로직 점검(마이그레이션 097~101)에서 만든 롤백형 psql 스크립트로 확인한 것이다. 서버 액션 한 겹(입력 검증·역할 게이트·문구)은 안 거치지만, RLS와 RPC 게이트는 실제 DB에서 그대로 검증된다. 스크립트 이름은 각 항목 끝에 적었다.

---

## 0. 공통 (권한·보안 — 전 기능에 걸림)

- 🟩 로그인 안 한 세션(anon)으로 테이블 조회·수정, 재고·핫딜·외상 RPC 호출 → 전부 거부 (`db-test-access-isolation.sql`). 서버 액션 레벨은 ⬜.
- 🟩 공급사 A 세션으로 공급사 B의 데이터(상품/주문/품목/거래처/거래관계/회사정보/직원목록)를 조회·수정·삭제 시도 → 0건/0행 (`db-test-access-isolation.sql`). RPC 쪽은 B사 직원이 A사 상품 재고조정·박스 매입단가·명세서 부위 조회 시도 전부 거부 (`db-test-tenant-gate-null.sql`). **고객(식당) 계정이 연결 공급사 재고를 조정할 수 있던 실제 구멍(NULL 비교)을 이 과정에서 발견해 097로 수정함.**
- 🟩 스태프가 사장님(owner) 전용 기능 호출 → 거부 — 테이블: 상품 등록·가격·삭제, 여신한도, 회사 설정, 자기 역할 승격, 직원 추가·제거 (`db-test-access-isolation.sql`); RPC: 재고조정·보관·매입단가·판매가 일괄·스캔 시 단가 입력·명세서 완전삭제 (`db-test-tenant-gate-null.sql`). 매니저는 상품·여신만 허용, 회사 설정은 사장 전용. 직원초대/정산 서버 액션은 ⬜.
- 🟩 매니저가 자기 역할을 owner로 승격 시도 → 0행 (`db-test-access-isolation.sql`). 사장 강등·제거(`canAssignRole`)는 서버 액션 레벨이라 ⬜.
- 🟩 조직 미소속 사용자(고객 계정)가 공급사 RPC 호출 → 전부 거부 (`db-test-tenant-gate-null.sql`). 대시보드 서버 액션 레벨은 ⬜.
- 🟩 관리자(super_admin)와 공급사 분리 — 공급사가 자기 role을 super_admin으로 변경·플랫폼 청구서 조회·다른 프로필 조회 → 거부, 관리자는 전체 열람·승인/구독 변경 가능 (`db-test-access-isolation.sql`)
- 🟩 바이어와 공급사 분리 — 바이어는 거래중 공급사의 활성 상품·자기 주문만, 남의 주문·재고원장·직원목록 0건, 상품가·미수금·배송중 주문 수정 0행, 접수대기 주문 금액 위조·직접 확정 거부, 취소요청 시 함께 보낸 금액·배송지 위조값 무시 (`db-test-access-isolation.sql`)
- ⬜ super_admin 아닌 계정이 관리자 전용 액션 호출 → 거부 (서버 액션 레벨)
- ⬜ 정지/탈퇴 처리된 계정으로 접근 시도 → 거부

**이 절을 만들다 발견해 102로 수정한 구멍 (2026-09-24, `20260930000102_access_isolation_fixes.sql`):**

1. 바이어 취소 요청이 DB에서 전부 막혀 있었음 — 024(직원 RLS)가 주문 UPDATE 정책을 옛 모양(pending만, WITH CHECK 없음)으로 되돌려 0912의 수정이 사라짐. 접수대기 주문도 취소요청이 정책 위반. 0912 모양 + 024 직원 조건으로 복원.
2. 공급사 사장이 자기 회사의 승인상태·구독상태·무료체험/청구 시작일·국세청검증·사업자번호·소유계정을 본인 세션으로 직접 UPDATE 가능 → `enforce_wholesaler_platform_columns` 트리거(super_admin 세션·서버·RPC 내부만 통과).
3. 트리거 내부용 재고 함수 4개(apply/reverse_order_shipment, recalc_product_stock, release_hot_deal_quota)가 anon·authenticated에 열려 있어 주문 ID만 알면 비로그인으로 남의 재고 차감·원복 가능 → EXECUTE 회수.
4. `reserve_hot_deal_quota`에 소유·상태 검사·중복 방지 없음 → 주문 소유자(또는 service_role)만, 접수대기만, 주문당 1회(`hot_deal_quota_reservations` PK).
5. `apply_credit_order`가 음수 금액 허용 → 바이어가 자기 미수금 0으로 → 0 이하 거부.

**103으로 이어서 수정 (`20260930000103_order_item_integrity.sql`, 사장님 (a)안 확정):**

6. 바이어가 orders/order_items를 직접 INSERT해 총액·단가를 위조할 수 있었음(서버 액션의 카탈로그 재해석 우회). `enforce_order_item_integrity` BEFORE INSERT 트리거가 바이어 세션(`auth.role()` = authenticated/anon)의 품목을 서버와 같은 규칙으로 대조한다 — 상품이 주문 공급사 것·주문 가능, 수량>0, 소계=round(단가×수량), 핫딜 줄은 핫딜가+한도 안(이 자리에서 판매량 소진·예약), 일반 줄은 그 고객의 활성 맞춤단가 중 하나 아니면 기준가, 품목 소계 합이 총액을 넘으면 거부. 헤더만 넣는 건 검증할 게 없어 통과된다(빈 주문은 무해). `reserve_hot_deal_quota`는 이미 예약된 주문이면 no-op(멱등) — 바이어 경로에선 트리거가, service_role 경로에선 RPC가 소진한다. `create-order.ts`는 품목을 상품 ID 순으로 넣어(상품 행 잠금 순서 고정) 데드락을 피한다.
7. `create-order.ts`·`submitOrderAction`이 품목 저장·핫딜 소진·외상 잔액 실패 시 `orders.delete()`로 헤더를 지우던 것이 바이어 세션에서는 0행(orders DELETE 정책 없음)이라 실패 주문이 접수대기로 남았음 → `discard_unfulfilled_order` RPC(소유자·접수대기·재고 미이동, 소진된 핫딜 한도는 반환)로 교체.

**잔여(낮음):** PG 결제 경로는 결제창을 열 때 저장한 단가로 주문을 만드는데, 그 사이 공급사가 기준가·맞춤단가를 바꾸면 승인 후 품목 저장이 PRICE_MISMATCH로 실패한다(결제는 됐고 주문은 없음 → 재대조 크론이 매일 재시도하며 같은 이유로 실패). 실계정 검증 때 확인할 것.

## 1. 가입·로그인

- ⬜ 카카오 로그인 3종(공급사/고객/직원) 처음부터 끝까지 정상 흐름 — 외부 OAuth라 실계정 필요. DB 쪽(로그인 직후 프로필 생성 → 온보딩/미니샵 가입/초대 수락)은 🟩 (`db-test-signup-and-accounts.sql`)
- 🟩 개인정보 동의 전에는 정보가 저장 안 됨(잠긴 결정) — 로그인 직후 프로필 이름·전화 비어 있고, 온보딩 동의 순간에 이름·전화·동의시각이 한 번에 기록. 바이어는 "카카오 회원" 자리표시자로 시작, 동의 RPC는 고객 계정만 (`db-test-signup-and-accounts.sql`)
- ⬜ 사업자번호 체크섬 자체가 틀림 → 제출 거부 (`isValidBusinessNumber`는 서버 액션·관리자 승인 액션 레벨. DB는 10자리만 봄 🟩)
- 🟩 체크섬은 맞는데 국세청에 실존하지 않음 → 승인 안 됨 — 국세청 결과 기록·승인 플래그 RPC는 super_admin만, 공급사 본인 호출·잘못된 결과값 거부, 승인 뒤 사업자번호 재제출 거부, 재제출 시 국세청 상태 unchecked로 리셋 (`db-test-signup-and-accounts.sql`). 승인 액션의 `nts_verification_status === "match"` 서버 검사는 코드 확인만.
- ⬜ 국세청 API 타임아웃/에러 응답 시 승인 대기 상태 유지 (외부)
- 🟩 이미 다른 공급사가 쓰는 사업자번호로 재가입 시도 → 거부 (온보딩·재제출 둘 다, `db-test-signup-and-accounts.sql`)
- ⬜ 사업자등록증 파일이 이미지/PDF 아니거나 8MB 초과 → 거부 (서버 액션)
- ⬜ 승인 대기 상태에서 대시보드 기능 접근 시도 → 차단 — 앱 게이트. DB 수준에선 승인 전 상품 등록이 됨(정보, `db-test-signup-and-accounts.sql`). 승인 전엔 미니샵 링크가 안 열려(`claim_shop_access`가 active만) 실질 피해 없음.
- 🟩 직원 초대 링크 만료/취소/없는 토큰/**이미 사용됨** → 거부 — 105에서 1회용으로 확정(사장님 결정). 사용된 링크는 미리보기도 안 뜬다. 여러 명은 링크를 여러 개 (`db-test-signup-and-accounts.sql`)
- 🟩 계정 종류 안 섞임 — 고객·다른 회사 사장/직원의 직원 초대 수락 거부, 공급사·관리자의 미니샵 가입 거부, 고객·스태프 채널 계정의 온보딩 거부, 수락한 직원은 그 회사 데이터만 (`db-test-signup-and-accounts.sql`). "초대받은 이메일과 다른 사람" 시나리오는 이메일 기반 초대가 아니라 성립 안 함.
- ⬜ 30일 쿨다운 안 지났는데 초대 재발송 시도 → 거부 (거래처 초청장 SMS 쪽, 서버 액션)
- 🟩 탈퇴 시 기록 보존 — 고객 탈퇴는 프로필·식당 정보만 익명화하고 주문·품목·미수금 기록 유지, 공급사 탈퇴는 미수금 있으면 거부·상호/사업자번호 유지·closed, 닫힌 회사 링크로 가입 불가. **고객 탈퇴도 105부터 미정산 외상이 있으면 보류**(사장님 결정 1안, 이용약관 근거 조항은 사장님 정비) — 정산 후 탈퇴됨 (`db-test-signup-and-accounts.sql`)

**이 절을 만들다 발견해 104로 수정 (`20260930000104_withdraw_and_invite_role_fixes.sql`):**

1. 승인된 공급사의 사업 종료(탈퇴)가 안 됐음 — `withdraw_wholesaler_account`가 `profiles.is_verified`를 내리는데 `enforce_profile_role_immutable`이 막음(앱은 본인 세션으로 호출 → "사업 종료 처리에 실패했습니다"). 승인 플래그 함수와 같은 내부 플래그로 감쌈.
2. 매니저가 owner 초대 링크를 만들 수 있었음(RLS가 역할을 안 보고 `canAssignRole`은 앱 레벨) → `enforce_staff_invite_role` 트리거(INSERT·UPDATE OF role).

**105 (`20260930000105_withdraw_hold_invite_single_use_bundle_gate.sql`, 사장님 결정):** 고객 탈퇴 미수금 보류, 초대 링크 1회용(`used_count = 0`만 유효, 수락 시 행 잠금), 세트 지정·해제 RPC owner/manager 게이트(2절 발견).

## 2. 상품 관리

- ⬜ 축종+상품명+원산지 조합 중복 생성 시도 → 거부 — **앱(서버 액션)에서만 막고 DB 유니크 없음**(정보, `db-test-product-management.sql`). 본인 데이터만 어지럽히는 수준이라 DB 제약은 보류.
- ⬜ 저장 후 잠긴 필드(축종/원산지) 변경 시도 → 거부 — 위와 같음(폼 읽기전용 + 서버 액션이 그 컬럼을 안 보냄, DB 잠금 없음).
- 🟩 이미 거래(주문/입고) 기록 있는 상품 완전삭제 시도 → DB가 FK로 막음(order_items·stock_ledger RESTRICT). `product_has_stock_history`로 앱이 보관 유도. 보관하면 판매 꺼짐·고객에게 안 보임·주문 불가, 해제 시 판매는 꺼진 채 복귀 (`db-test-product-management.sql`)
- 🟩 세트 조립: 원재료 재고 부족 → 실패 (`db-test-product-bundles.sql` — 점검 1의 자동배정 박스 스캔 수정으로 이 스크립트가 끝까지 통과하게 됨)
- 🟩 세트 조립: 유통기한 지난 박스 제외 / 보관 처리된 구성품 → 차단 (`db-test-fifo-bundle-integrity.sql`)
- 🟩 세트 조립: 세트 안에 세트(중첩) → 차단 — 세트를 구성품으로(NESTED_BUNDLE), 구성품을 세트로(COMPONENT_CANNOT_BE_BUNDLE) 양방향. 구성품 없음·자기 자신·수량 0·남의 상품·거래 기록 있는 상품·중복 지정도 거부, 세트 단위 강제, 축종·원산지 상속, 다른 회사의 수정·해제 거부 (`db-test-product-management.sql`). **직원(staff)이 세트를 지정·해제할 수 있던 것은 105에서 owner/manager로 제한**(조립·해체는 창고 작업이라 직원 유지).
- 🟩 세트 조립: 이력번호 없는 재고로 조립 시도 → 차단 — 박스만 세며, 수동 재고가 남은 상품은 세트 지정 자체를 거부(100) (`db-test-fifo-bundle-integrity.sql`)
- 🟩 거래처별 개별가격 — 등록·같은 식당 같은 상품 중복 거부(유니크)·매니저 켜고 끄기·직원은 조회만·다른 회사 격리, 꺼진 개별가격은 주문에 못 쓰고(103) 켜면 기준가 대신 개별가격만 통과, 기준가 일괄변경(정상/0원/남의 상품 분리 집계, 보관 상품 제외, 활성화 옵션) (`db-test-product-management.sql`). 0원/음수는 CHECK(>=0)와 RPC(>0)로 거부.
- 🟩 다른 공급사 상품ID로 접근 시도 → 거부 (`db-test-tenant-gate-null.sql`, `db-test-access-isolation.sql`)
- 🟩 핫딜 판매한도 도달 후 추가 주문 시 자동 차단 — 품목 트리거·reserve 둘 다 HOT_DEAL_QUOTA_EXCEEDED (`db-test-access-isolation.sql`). 카탈로그가 기준가로 되돌아가는 건 앱 레벨.
- 🟩 발주정지 — 재고 0이면 자동 정지(out_of_stock), 재입고돼도 유지(잠긴 결정 3), 정지 중엔 재고 있어도 주문 불가(103), 수동 재개·수동 정지·잘못된 사유값 거부 (`db-test-product-management.sql`). "핫딜 끄면 발주정지 자동 해제(재고 0이면 유지)"는 서버 액션 로직이라 코드 확인만.
- ⬜ 판매가 일괄등록 CSV 형식 깨짐/필수 칸 없음 → 에러 처리 (서버 액션)
- ⬜ (정상) 상품 생성/수정/삭제(보관) 기본 흐름 (서버 액션 하네스)

## 3. 입고

- ⬜ 바코드/이력번호가 정부 조회에서 확인 안 됨(가짜·오탈자) → FAILED 처리
- ⬜ 이미 입고 처리된 박스 중복 스캔 → 거부
- ⬜ 실중량-표기중량 오차 ±2% 초과 → 기록/경고
- ⬜ 정부 API 인증키 미설정 → 안전 폴백(DONE 처리)
- ⬜ 정부 API 타임아웃/5xx 응답 → FAILED 처리, 재시도 가능
- ⬜ 로트는 등록됐는데 특정 개체만 미등록 → 정확한 개체번호로 안내(회귀 확인)
- ⬜ 명세서 취소 후 재개 로직이 더는 안 건드림(회귀 확인)
- ⬜ 명세서 취소 후 복원하면 대기 상태로 되살아남(회귀 확인)
- ⬜ 같은 명세서를 동시에 두 번 처리 요청 → 결과 안전하게 기록(회귀 확인)
- ⬜ 같은 이력/로트번호가 여러 줄에 걸침 → 대표 한 줄만 조회 대상(회귀 확인)
- ⬜ 명세서에 품목·중량·단가 등 필수항목 누락 → gap 판정
- ⬜ 명세서 합계와 줄 합계 불일치 → gap 판정
- ⬜ 8MB 넘는 파일 업로드 → 거부
- ⬜ 취소 안 한 서류 완전삭제 시도 → 차단(먼저 취소 필요)
- ⬜ 존재하지 않는 문서ID로 조작 시도 → 거부
- ⬜ 엑셀 대량 입고 중 행 데이터 오류(빈 값/잘못된 형식) → 에러 처리
- 🟩 엑셀 대량 입고 같은 행을 두 창이 동시에 처리 → 두 번째 입고 거부 (097 유니크, `db-test-tenant-gate-null.sql`)
- 🟩 명세서 줄에 남의 공급사 상품 ID 저장 시도 → RLS 거부 / 로그인 공급사 계정이 공용 이력 캐시에 직접 쓰기 → 거부 (098, `db-test-tenant-gate-null.sql`)
- ⬜ (정상) 박스 스캔 → 이력 대조 → 재고 반영 기본 흐름
- ⬜ (정상) 명세서 업로드는 재고를 만들지 않음(설계 원칙 확인)

## 4. 출고·주문

- 🟩 재고보다 많은 수량 주문 확정 → `INSUFFICIENT_STOCK` 거부 (`db-test-order-stock-regression.sql` T3). 발주 생성 단계의 거부(서버 액션 `validateCart`)는 ⬜.
- ⬜ 발주정지 상품 주문 시도 → 거부
- ⬜ 최소발주금액 미달을 서버가 걸러내는지(화면 조작 우회 가정) — 코드 확인은 끝남(점검 4: 두 주문 경로 모두 서버에서 `wholesalers.min_order_amount`로 재검증), 테스트만 남음
- 🟩 같은 상품을 동시에 두 주문이 확정하려는 경쟁 상태 → 하나만 성공, 표시 재고 = 원장 합계 (`db-test-order-stock-concurrency.sh`, psql 두 세션 실제 경쟁). **이 항목을 만들다가 재계산 함수의 스냅샷 레이스와 091~094 회귀를 발견해 099로 수정함.**
- ⬜ 이미 취소/완료된 주문을 다시 취소·재확정 시도 → 거부(`ORDER_STATUS_TRANSITIONS`)
- 🟩 다른 공급사의 주문ID로 접근 시도 → 조회 0건·수정 0행 (`db-test-access-isolation.sql`)
- ⬜ 재고 0인 상품 주문 시도 → 거부
- 🟩 유통기한 지난 박스는 확정 자동배정에서도 제외, 기한 지난 박스만 있으면 재고 부족으로 거부 (100, `db-test-fifo-bundle-integrity.sql`). 출고 스캔의 `BOX_EXPIRED`는 `db-test-best-before.sql`이 다루지만 뒤쪽이 stale(피킹 목록 컬럼 변경)이라 ⬜.
- 🟩 확보 대기 주문에 입고 즉시 배정 후 확정 → 한 번만 차감 / 8.205kg 박스 확정 성공 / 배정만 된 주문 취소 원복 (`db-test-order-stock-regression.sql`)
- 🟩 (정상) 발주 → 확정 시 선입선출 박스 차감 → 피킹 목록대로 자동배정 박스를 찍어도 거부되지 않음 (`db-test-outbound-scan.sql`, `db-test-picking-list.sql`, `db-test-finalize-shipment.sql`)

## 5. 결제·정산

- ⬜ 카드 결제 실패 시 주문이 생성 안 됨(유령주문 방지, 잠긴 결정)
- 🟩 **결제 성공 콜백·재대조가 겹쳐도 같은 결제로 주문이 두 번 안 생김** — 101에서 `orders(pg_order_id)` 유니크 + `finalizePaidOrder` 멱등 처리로 해결. DB 유니크는 `db-test-pg-idempotency.sql`로 확인, 서버 경로(콜백 두 번 호출)는 토스 실계정 발급 후 ⬜.
- ⬜ 결제는 성공했는데 성공 콜백이 한 번도 안 옴 → **복구 장치는 이미 있음**(`lib/payments/pg-reconcile.ts`, 주문내역 재방문 + 매일 크론, 커밋 8d8c406). 이 줄의 "장치가 없음" 표현은 낡은 것. 실계정 발급 후 재현 테스트만 남음.
- ⬜ 핫딜 매진 상태에서 PG 결제 승인 → 주문 대신 자동 환불 + 안내 (101, 점검 3 A안) — 실계정 필요
- ⬜ 환불 API 실패 시 취소 상태로 안 바뀜(잠긴 결정). 환불 성공 후 상태 변경이 0건이어도 `payment_status='refunded'`가 남는지 함께 확인(101)
- ⬜ 이미 환불된 건 재환불 시도 → 거부
- ⬜ 체험만료/연체 상태에서 실제로 대시보드 접근이 막히는지(`/billing-locked` 리다이렉트)
- ⬜ 허용 안 된 거래처로 결제수단 사용 시도 → 거부
- ⬜ (정상) 외상 거래처 정산(수납) 처리

## 6. 서류발행

- ⬜ 사업장 주소 미등록 상태에서 명세서 발행 시도 → 차단(잠긴 결정)
- ⬜ 이미 발행된 계산서 중복발행 시도 → 거부
- ⬜ 정정신고 사유 없이 정정 시도 → 거부
- ⬜ 팝빌 API 실패/미설정 상태에서 발행 시도 → 에러 처리
- ⬜ 금액 0원/음수 발행 시도 → 거부
- ⬜ (정상) 거래명세서/계산서/배송의뢰서 발행 기본 흐름

## 7. 알림톡

- ⬜ 자격정보 미설정 상태에서 발송 시도 → 안내만 뜨고 실패 안전 처리
- ⬜ 비즈뿌리오 API 오류 응답 처리
- ⬜ 잘못된 전화번호 형식 → 거부

## 8. 관리자

- ⬜ 일반 계정이 관리자 전용 액션 직접 호출 → 거부
- ⬜ 이미 승인된 공급사 재승인 시도 → 멱등 처리 확인
- ⬜ 정지된 공급사가 계속 API 호출 시도 → 거부

---

## 검토했지만 이 프로젝트엔 없어서 제외한 항목

외부 검토 의견 중 실제 코드와 대조해서 뺀 것들 (2026-09-24):

- **휴면 계정 전환 / 동일 계정 다른 기기 로그인 제한** — 그런 기능 자체가 없음
- **부분 취소/반품**(10박스 중 3박스만 반품) — 주문 취소는 전체 단위뿐, 부분 반품 기능 없음
- **배송지 변경 제한 시점** — 애초에 주문 후 배송지를 바꾸는 기능이 없음(생성 시 고정)
- **부가세 면세/과세 혼합 상품 처리** — 이 플랫폼은 축산 도소매라 전부 면세로 고정
  (팝빌 연동에 `taxType: "면세"` 하드코딩, [tax-invoice-vat-exempt-decision](tax-invoice-vat-exempt-decision.md) 참고).
  과세 상품 자체가 없어 혼합 계산 시나리오가 성립하지 않음.

## DB 레벨 스크립트 한 번에 돌리기 (2026-09-24 추가)

전부 로컬 Docker DB 대상이고 롤백형이다(`db-test-order-stock-concurrency.sh`만 고유 ID 시드를 넣고 끝에 지운다).

```
for s in db-test-tenant-gate-null db-test-access-isolation db-test-signup-and-accounts db-test-product-management db-test-order-stock-regression db-test-fifo-bundle-integrity db-test-pg-idempotency; do
  (echo "begin;"; cat scripts/$s.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - | grep -E "FAIL|pass \|" ; done
bash scripts/db-test-order-stock-concurrency.sh
```

오래돼 깨진 스크립트: `db-test-livestock-inbound.sql`(중복 스캔 가드 이전 작성), `db-test-best-before.sql`(피킹 목록 반환 컬럼 변경). 고치거나 지우기 전까지 결과를 믿지 말 것.

## 다음 단계

1. 서버 액션 테스트용 인증 하네스 구축(테스트 사용자 로그인 → JWT를 `lib/supabase/server.ts`
   자리에 주입하는 방식, 프로덕션 코드는 안 건드림) — 🟩 항목들은 그 하네스로 "서버 액션 한 겹"만 덧씌우면 ✅가 된다
2. 영역 하나(추천: 3.입고 또는 4.출고·주문 — 돈·재고 직결)를 먼저 끝까지 만들어 검증
3. 통과하면 나머지 영역 순서대로 확장
4. 5번의 PG 콜백 유실 건은 테스트로 재현까지만 하고, 실제 수정 여부는 별도로 결정
