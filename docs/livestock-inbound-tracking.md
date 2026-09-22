# 축산물 이력 입고 시스템 (바코드 스캔 + 박스 단위 재고)

### 배경
별도 스펙(축산물 도매업체용 SaaS — 입고 및 이력 검증)으로 들어온 요구. 창고 현장에서 바코드/카메라로 이력번호를 찍으면 축산물이력제 공공 API와 대조해 검증하고 입고를 자동화한다. 기존 `products.stock_quantity`는 **사람이 손으로 고치는 표시용 숫자**였고(`app/dashboard/products/actions.ts:289`가 유일한 갱신 경로), 주문이 확정돼도 차감되지 않았다 — 즉 재고 자동화가 아예 없던 상태에서 출발한다.

### 스택 결정 (2026-09-22)
원 스펙은 Node/Express(또는 NestJS) + Prisma/TypeORM 별도 백엔드를 전제했지만 **기존 Next.js + Supabase 위에 얹는 쪽을 채택**했다.

- 카카오 로그인/세션, `/staff-login`↔`/login` 분리, `middleware.ts` 가드를 그대로 재사용한다.
- 테넌트 식별자를 새로 만들지 않는다 — `wholesalers.id`가 곧 `company_id`다.
- **가장 큰 이유는 RLS**다. Prisma는 보통 service_role로 붙어 RLS를 우회하므로 테넌트 격리를 앱 코드가 매 쿼리마다 다시 책임져야 한다. 이 저장소는 RLS 정책 누락으로 이미 한 번 크게 데였다(`docs/wholesaler-retailers-rls-fix.md`).
- 대가: Supabase JS는 다중 문장 트랜잭션을 지원하지 않아 **입출고 핵심 로직이 TypeScript가 아니라 PL/pgSQL(RPC)로 간다**. 이 저장소가 이미 20곳 넘게 쓰는 패턴이라(`apply_credit_order`, `complete_supplier_signup` 등) 새로운 방식은 아니다.

### 잠긴 설계 결정

**1. 재고의 실제 단위는 이력번호가 아니라 "박스 한 개"(`inbound_scans.id`)다.**
이력번호는 고기의 신원이지 우리 창고의 물건 한 개가 아니다. 소 한 마리(개체번호 12자리)에서 등심 박스가 여럿 나오고, 묶음번호(15자리)는 애초에 여러 마리를 묶은 번호다. 그래서 `trace_no`에 UNIQUE를 걸 수 없고, 중복 스캔을 이력번호로 막을 수도 없다.

**2. 수량은 `stock_ledger`(원장)에만 쓰고 `products.stock_quantity`는 그 합계로 파생시킨다.**
취소는 행 삭제가 아니라 반대 부호 행 추가(역분개)다. `products`의 `CHECK (stock_quantity >= 0)`가 "이미 팔려나간 입고를 취소"하는 불가능한 상태를 막는 가드로 동작한다. 동시 스캔에서 lost update가 나지 않도록 read-modify-write 대신 `SUM(qty_delta)` 재계산을 쓴다.

**3. `products` 스키마는 변경하지 않는다.**
부위는 `products.subcategory`(20260930000022에서 이미 추가됨, 소: 안심·등심·채끝…, 돼지: 삼겹살·목살…), 축종은 `products.category`로 이미 있다. `stock_quantity`는 컬럼을 그대로 두고 **"누가 쓰느냐"만** 원장으로 바꾼다 — 8개 파일이 이 컬럼을 읽고 있어(`shop-view.tsx`, `product-table.tsx`, `catalog-types.ts`, `products/page.tsx` 등) 컬럼을 없애면 전부 고쳐야 하고 얻는 게 없다. **미니샵·발주 화면은 코드 변경 없이 그대로 돈다.**

**4. 이력번호 → 상품 매핑은 "부위 우선 + 못 채우면 되묻고 학습"이다.**
`master_livestock.part_name`으로 `trace_product_map`을 조회해 자동 매핑하고, 못 찾으면 `PENDING_MAPPING`으로 남겨 사용자에게 한 번 묻는다. 답하면 `trace_product_map`에 저장돼 다음부터 안 묻는다. 등급까지 일치하는 매핑을 등급 무관(`grade IS NULL`) 매핑보다 우선한다.

**5. 출고는 박스 단위로 추적한다.**
수량만 차감하면 "어느 거래처에 어느 소를 팔았는지"를 영영 알 수 없고, 나중에 붙여도 이미 나간 주문은 소급이 안 된다. `stock_ledger.inbound_scan_id`가 그 연결고리다. 목적은 두 가지 — 축산물 이력법상 거래내역 기록·보관(정확한 의무 범위·보관기간은 **시행규칙 확인 필요**, 아직 확인 안 함)과, 이미 있는 거래명세서 PDF(`docs/transaction-statement-pdf.md`)에 이력번호를 찍어 식당에 증명서를 자동 제공하는 것. **소매(식당) 화면은 두 방식이 완전히 동일하다** — 박스는 식당에 노출되지 않는다.

**6. 모든 쓰기는 SECURITY DEFINER RPC를 통한다.**
재고 관련 테이블에는 SELECT 정책과 SELECT GRANT만 준다. 원장을 우회해 재고를 직접 고치는 경로가 존재하지 않는다. 예외는 엑셀 업로드 큐(`inbound_import_jobs/rows`) — 재고에 직접 영향을 주지 않는 적재 단계라 수백 행을 RPC로 한 건씩 넣는 낭비를 피해 RLS 정책으로 직접 쓰기를 허용한다.

**7. 마스터는 미리 채울 수 없다 — 스캔 시점 Lazy Loading 캐시다.**
축산물이력제 API는 전체 덤프를 주지 않는다(이력번호를 알아야 조회 가능). 그래서 "플랫폼이 매일 마스터를 일괄 적재"하는 구조는 성립하지 않는다. 처음 들어온 이력번호는 반드시 한 번 API를 타고, 그 다음부터 캐시 히트다.

**8. Vercel Hobby라 크론 기반 큐 소화를 쓸 수 없다.**
`vercel.json`의 크론 슬롯 2개가 이미 소진됐고 Hobby는 하루 1회가 최대 빈도다(`app/api/cron/market-price-sync/route.ts:12` 주석에 같은 제약이 기록돼 있다). 엑셀 대량 업로드는 **브라우저가 `processChunk`를 반복 호출해 20건씩 소화하는 클라이언트 주도 방식**으로 간다 — 각 요청이 짧아 실행시간 제한을 안 건드리고, 진행률이 보이며, 창을 닫아도 job이 DB에 남아 이어서 처리된다.
> 참고: Vercel Hobby는 약관상 비상업적 용도 전용이다. 구독 과금(`docs/platform-subscription-billing.md`)을 실제로 시작하는 시점에는 Pro로 올려야 한다 — 이 입고 시스템 때문이 아니라 기존 과금 기능 때문이다.

### 아키텍처

```
바코드/카메라 스캔
   │
   ├─ master_livestock 조회 (캐시 히트 → 즉시)
   │
   ├─ 미스 → 공공 API 호출 → upsert_master_livestock()
   │
   └─ record_inbound_scan()  ← 한 트랜잭션
         ├ 이력 못 찾음        → EXCEPTION       + exception_log
         ├ 이력 O, 상품 미확정 → PENDING_MAPPING + exception_log  → 사용자에게 되묻기
         └ 이력 O, 상품 확정   → NORMAL + stock_ledger(+) + 재고 재계산
```

### 테이블 (`supabase/migrations/20260930000053_livestock_inbound_core.sql`)

| 테이블 | 역할 |
|---|---|
| `master_livestock` | 공공 API 응답 캐시. 플랫폼 공용(업체 구분 없음), `raw_payload jsonb`에 원본 전문 보관 |
| `trace_product_map` | 축종+부위+등급 → 우리 상품 매핑 학습 (업체별) |
| `inbound_scans` | **박스 한 개 = 한 행.** 재고의 실제 단위. `remaining_weight`로 선입선출 출고 |
| `stock_ledger` | 입출고 원장. 재고의 유일한 진실. 멱등 유니크 인덱스로 재시도 중복 차단 |
| `livestock_exception_log` | 검증 실패 건(`NOT_FOUND`/`API_ERROR`/`INVALID_FORMAT`/`UNMAPPED_PRODUCT`) |
| `inbound_import_jobs` / `_rows` | 엑셀 업로드 청크 큐 |

### RPC

| 함수 | 역할 |
|---|---|
| `resolve_current_wholesaler_id()` | owner와 초대 직원 계정 모두에서 `wholesaler_id`를 얻는다. `get_current_wholesaler_id()`는 owner만 인식한다(20260930000024 참고) |
| `upsert_master_livestock(...)` | API 응답 적재. 공급사 계정만 호출 가능(공용 캐시 오염 방지). 재조회가 부분 응답이어도 기존 값을 지우지 않는다 |
| `record_inbound_scan(...)` | 스캔 + 원장 + 재고 + 예외를 한 트랜잭션으로 |
| `resolve_inbound_mapping(...)` | 미확정 건에 상품 지정 → 재고 확정 + 매핑 학습 |
| `void_inbound_scan(...)` | 역분개. 일부라도 출고된 박스는 `PARTIALLY_SHIPPED`로 차단 |
| `recalc_product_stock(...)` | 내부 전용(`REVOKE EXECUTE FROM PUBLIC`). 원장 합계로 `stock_quantity` 재계산 |

### 검증 상태 (2026-09-22)
로컬 Postgres 16에 **전체 마이그레이션 체인을 처음부터 적용**하고(Supabase `auth`/`storage` 스키마는 스텁) 기능 테스트 9종을 돌려 전부 통과:

1. 미등록 이력번호 스캔 → `EXCEPTION` + `exception_log(NOT_FOUND)`, 재고 변동 없음
2. 마스터 적재 후 스캔 → `PENDING_MAPPING` (매핑 없음)
3. 매핑 확정 → `NORMAL`, 재고 8.20, `trace_product_map` 학습됨
4. 같은 부위 재스캔 → 학습된 매핑으로 자동 `NORMAL`, 재고 15.70
5. 박스 2행으로 분리 유지 확인 (설계 결정 1번)
6. 입고 취소 → `INBOUND_VOID(-7.50)` 역분개, 재고 8.20 복귀
7. 부분 출고된 박스 취소 → `PARTIALLY_SHIPPED`로 차단
8. 테넌트 격리 — B사가 A사 입고/원장 0건, 공용 마스터는 2건 조회
9. 남의 상품에 입고 시도 → `PRODUCT_NOT_FOUND`로 차단

**미검증:**
- 실제 Supabase 인스턴스에 적용 안 함 (로컬 스텁 환경에서만 검증)
- **공공 API 실호출 전무** — 축산물이력제 인증키 미발급. 응답 필드명·구조 전부 미확정이라 `raw_payload jsonb`로 원본을 보관하는 방어 설계를 깔아둠

### 남은 과제
1. **공공 API 커넥터** (`lib/livestock/mtrace-client.ts`) — 인증키 발급 후 실응답으로 파싱 검증 필요. 특히 **부위(`part_name`)가 응답에 오는지**가 매핑 자동화율을 좌우한다. 이력번호가 개체 단위라 안 올 가능성이 있고, 그 경우 되묻는 빈도가 높아진다. 냉장/냉동 구분은 이력 데이터에 아예 없다.
2. **국내산/수입 API 라우팅 규칙** — 스캔된 번호가 소·돼지 API 대상인지 수입쇠고기 API 대상인지 판별하는 자릿수·접두어 기준 미정. 판별 불가 시 순차 호출 폴백 필요.
3. **캐시 TTL** — `fetched_at`만 두고 재조회 주기 규칙은 아직 없다. 등급·가공 정보가 나중에 갱신될 수 있어 영구 캐시는 위험.
4. **묶음번호 1:N 전개** — 묶음(15자리)이 개별 이력번호 여러 건을 포함하는 경우 마스터에 어떻게 펼쳐 저장할지 미정.
5. **공공 API 호출량 제어** — 서버리스는 인스턴스가 분산돼 메모리 기반 전역 레이트리밋이 불가능. 일일 한도를 지키려면 카운터 테이블이 필요.
6. **출고 연결 (`apply_order_shipment`)** — 가장 위험한 구간. 기존 주문 확정/취소/부분취소(`order_active_amount`)와 PG 환불 경로마다 역분개가 필요하다. 이게 붙기 전까지 재고는 입고만 자동이고 출고는 수동이라 오차가 남는다(지금도 같은 상태).
7. **중복 스캔 방지 정책** — 박스 단위 식별자 기반 dedupe 규칙 미정(이력번호+중량+시각 근접도 등).
8. **오프라인 대응** — 냉동창고 전파 불량 시 IndexedDB 로컬 큐 + 복구 시 동기화(PWA). 웹인 이상 스택과 무관한 별도 과제.
