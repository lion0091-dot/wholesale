# 원가 접근 제한 (마이그레이션 208·209, 2026-10-02)

원가(매입 비용)를 누가 볼 수 있는지의 규칙과, 그 규칙을 **업체마다 다르게** 둘 수 있는 구조. 플랫폼 원칙 "도매업체마다 제각각인 요청을 수용한다"의 첫 사례다.

## 원가가 담긴 곳 (3군데)

| 위치 | 내용 | 읽는 길 |
|---|---|---|
| `inbound_scans.purchase_unit_price` / `purchase_amount` | 입고 박스별 매입단가·금액 | `get_scan_costs(uuid[])` |
| `purchase_order_lines.unit_price` | 전표 줄 단가 | `get_po_line_prices(uuid[])` (전표 한 건당 한 행, 줄번호→단가 JSON) |
| `product_purchase_prices` | 상품별 기본 매입단가 | 표 직접 조회(RLS가 `can_view_cost`) |

앞의 두 표는 **컬럼 단위로 직접 SELECT를 막았다**(DB 역할 `authenticated` 단위라 대표도 직접 못 읽는다 → 읽는 길은 위 함수뿐). 실시간(Realtime) payload에도 막은 컬럼은 실리지 않는다(로컬 실험으로 확인).

## 누가 보나 — `can_view_cost(wholesaler_id)`

대표(wholesalers 본인 또는 조직 owner)는 항상. 나머지는 **업체 정책** `wholesalers.cost_access_policy`:

| 값 | 대표 | 전표 담당 직원 | 매니저 |
|---|---|---|---|
| `OWNER_MANAGER_AND_CLERK` (**기본, 기존과 같음**) | O | O | O |
| `OWNER_AND_CLERK` | O | O | X |
| `OWNER_ONLY` | O | X | X |

일반 직원·고객·슈퍼관리자·비로그인은 어느 정책에서도 못 본다. **정책을 바꾸는 건 플랫폼 운영자(슈퍼관리자)뿐**이다(`enforce_wholesaler_platform_columns`가 막음) — 업체 대표가 스스로 열거나 닫을 수 없다. 설정 화면은 아직 없다(요청이 있을 때 SQL 또는 어드민 화면으로). 예: `update wholesalers set cost_access_policy='OWNER_AND_CLERK' where id='...'`.

## 전표 담당 직원

- `organization_staff.is_document_clerk`. **일반 직원(staff)만** 될 수 있고(매니저로 승격되면 표시가 자동으로 내려간다), 최대 인원은 `wholesalers.document_clerk_limit`(기본 2).
- 지정·해제는 대표만, `set_document_clerk(staff_id, bool)` RPC로만 가능(테이블 직접 UPDATE로 켜면 거부). 화면: 설정 → 팀원 관리.

## 이 규칙을 따르는 곳

- 전표(발주서) 입력·수정 RLS, 거래처(공급처) 등록은 전표 담당도 가능(`is_document_clerk_of`)
- 매입 정산 목록·합계(`list_inbound_purchases`·`summarize_inbound_purchases`), 단가 수정(`update_inbound_purchase`), 기본 매입단가 저장(`set_product_purchase_price`), 보류함의 "발주서 추가 생성"(`create_purchase_order_from_unlisted_scan`)
- 현장 스캔 `record_inbound_scan`: 원가를 못 보는 사람에게는 **응답에서 매입단가·금액을 뺀다**(상품 기본단가가 자동 적용되는 경로라 이전엔 직원에게 돌려주고 있었다)
- 화면: 전표관리·매입 정산은 못 보는 사람에게 안내 문구(`components/cost-access-notice.tsx`), 사이드바에서 전표관리 메뉴 숨김, 입고 화면의 박스별 매입금액·"매입단가 입력" 체크 줄은 못 보는 사람에게 안 보임
- **주문별 원가·마진 패널**(`get_order_margin`, 마이그 208)은 정책과 무관하게 **대표만**

## 지켜야 할 것

1. `inbound_scans`·`purchase_order_lines`에 **컬럼을 새로 추가하면** 마이그레이션에서 `GRANT SELECT (새컬럼) ... TO authenticated, anon`을 같이 한다. 안 하면 그 컬럼을 읽는 화면이 permission denied로 깨진다. `scripts/db-test-cost-access.sql`의 "컬럼 가드"가 누락을 잡는다. `wholesalers`도 컬럼 단위 권한이라 같다(`scripts/db-test-alimtalk-credentials.sql`).
2. 원가를 응답에 싣는 새 RPC는 `can_view_cost`로 게이트하거나 마스킹한다.
3. **성능**: 권한 판정을 행마다 다시 하면 18,000줄에서 3초가 넘는다 — `WITH me AS MATERIALIZED (...)` 또는 `(SELECT public.can_view_cost(...))`처럼 한 번만 계산한다(`tests/integration/perf-purchase-orders.itest.ts`가 잡는다). 줄 단위로 돌려주는 함수는 API 응답 상한(`max_rows=1000`)에 걸리니 한 건당 한 행으로 묶는다.
4. 업체별 정책을 늘릴 때는 기본값을 **기존 동작과 같게** 두고 원하는 업체만 바꾼다.

## 검증

- DB: `scripts/db-test-cost-access.sql`(57건) — 전표 담당 지정 규칙, 열람 가능 여부, 컬럼 직접 조회 차단, 읽기 함수, 응답 마스킹, 전표·거래처 권한, 업체별 정책, 컬럼 가드. `db-test-orders-outbound.sql` 4-H(주문 마진).
- 통합: `tests/integration/perf-purchase-orders.itest.ts`(단가 함수 성능·누락 없음). 전체 `npm run test:integration` 319건 통과.
- 로컬 브라우저로 대표·전표 담당·매니저·일반 직원 화면, 정책 전환(매니저 제외), 현장 입고 화면 오류 없음 확인.

## 남은 일

- 운영 DB 미적용(마이그 209) — 적용 후 대표·전표 담당·일반 직원 계정으로 화면 확인.
- **재고 평가금액**(남은 박스 × 매입단가, 대표 전용)은 아직 안 만들었다.
- 로그인 한 회선만 유지 = Supabase "Single session per user"(Pro 플랜, 프로젝트 전체 적용 — 고객 계정도 영향). Pro 전환 때 대시보드에서 켠다.
- 정책을 바꾸는 운영자 화면(어드민)은 요청이 있을 때.
