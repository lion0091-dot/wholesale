# 공급사·고객 간 데이터 섞임 — 방어·감지·복구 런북 (2026-10-02)

입고·출고·발주·배송·미니샵·재고는 전부 `wholesaler_id`(공급사)·`retailer_id`(고객)로 갈린다. 이게 한 번이라도 섞이면 사고다. 이 문서는 (1) 어떻게 막고 (2) 어떻게 알아채고 (3) 터졌을 때 무엇을 하는지, 그리고 (4) 아직 비어 있는 것을 적는다.

## 1. 방어 3겹

| 겹 | 내용 | 위치 |
|---|---|---|
| RLS | 공개 테이블 45개 전부 켜짐. 공급사·고객은 자기 행만 읽고 쓴다 | 각 표 정책 |
| RPC 게이트 | SECURITY DEFINER 함수는 `can_access_wholesaler`/`can_manage_wholesaler` 등으로 소속 검사 | 097·098·102 |
| **참조 소속 가드(200)** | 공급사 소유 표가 다른 공급사 소유 표를 가리키는 컬럼 12개 표(22쌍)에 `enforce_tenant_refs` 트리거. A 행이 B의 상품·박스·거래처·원장을 가리키면 `TENANT_REF_MISMATCH` | 마이그 200 |

200을 만든 이유: 공급사 A가 B의 상품 ID로 맞춤단가를 만들 수 있었고, B 미니샵 가격 조회와 주문 검증 트리거가 그 값을 썼다(운영 DB 섞인 행 0건 확인 후 수정).
**새 규칙:** 공급사 소유 표에 다른 공급사 소유 표를 가리키는 FK 컬럼을 추가하면, 같은 마이그레이션에서 `enforce_tenant_refs('컬럼:부모표')` 트리거를 건다. 안 걸면 `tests/integration/tenant-isolation.itest.ts`가 실패한다(카탈로그 기반 검사).

### ERD 분류 (2026-10-02, 카탈로그 기준 45개 표)

| 분류 | 표 | 방어 |
|---|---|---|
| **A. 공급사 소유**(`wholesaler_id`) 28개 | products, orders, inbound_scans, stock_ledger, custom_prices, purchase_* 등 | RLS + 마이그 200 소속 가드(22쌍) |
| **C. 조직 소유** 2개 | organization_staff, organization_staff_invites | 조직 RLS |
| **D1. 부모를 통해서만 소속이 정해지는 자식 표** | order_items(주문·상품), inbound_import_rows(작업·박스), hot_deal_quota_reservations(서버 전용) | order_items는 `trg_order_items_integrity`, inbound_import_rows는 마이그 201 가드 + 구조 검사 |
| **D2. 여러 공급사가 같이 쓰는 표(의도)** | retailers(고객 신원만; 공급사별 값은 wholesaler_retailers에 분리), wholesalers, profiles(본인·슈퍼관리자만), master_livestock(공공 이력 캐시, 읽기 공개), market_price_snapshots, product_categories | 읽기 정책이 연결된 거래처로만 제한(retailers), 쓰기는 서버 전용 |
| **D3. 슈퍼관리자 전용** | audit_log, access_log, retailer_match_requests, platform_admin_allowlist, platform_events | `get_current_role()='super_admin'` |

**공유 구조의 핵심:** 고객(`retailers`) 한 행을 여러 공급사가 같이 보지만, 신원(상호·사업자번호·주소)만 들어 있고 여신한도·미수금·메모·정지사유 같은 공급사별 값은 전부 연결 표(`wholesaler_retailers`)에 있다. 그래서 공급사끼리 서로의 고객 거래 조건을 볼 수 없다. 새 표를 만들 때 "한 행을 여러 공급사가 공유하는가"를 먼저 정하고, 공유한다면 공급사별 값은 연결 표에 둔다.

## 2. 감지

- **매일 05:30(KST 아님, UTC)** `/api/cron/check-tenant-consistency`가 `tenant_consistency_violations()`(23항목)를 부른다. 섞임이 한 건이라도 있으면 HTTP 500 → Vercel 크론 실행이 실패로 표시되고 로그에 `[cron check-tenant-consistency] 공급사 간 데이터 섞임 감지: [...]`가 남는다.
- 수동 점검: `npx supabase db query --file <sql> --linked`로 `select * from public.tenant_consistency_violations() where violations > 0;` (service_role 전용 함수라 SQL 편집기·CLI에서만).
- **한계:** 크론 실패를 사람이 보지 않으면 소용없다 — Vercel 알림(이메일/슬랙) 설정은 대표님이 해야 한다. [미완료]

## 3. 터졌을 때 (순서)

1. **멈춘다.** 섞임이 새로 생기는 중인지 본다. 200 이후엔 DB가 막으므로 새 행이 생겼다면 트리거를 우회한 경로(서비스키·마이그레이션)다 — 어디서 썼는지부터 찾는다. 영향 공급사의 접근 차단은 공급사 상태를 정지로 바꾸는 방법이 있으나 실제 차단 범위는 **미검증**.
2. **범위를 센다.** `tenant_consistency_violations()`의 `ref`가 어느 표·컬럼인지 알려준다. 해당 쌍의 조인 쿼리(마이그 200의 함수 본문과 같은 조건)에서 `count(*)`를 `select c.*`로 바꾸면 행 목록이 나온다.
3. **복구한다.**
   - 재고 숫자: `stock_ledger`는 쌓이기만 한다. 섞인 원장 행을 확인한 뒤 `recalc_product_stock(상품id)`로 재계산한다. 박스 `remaining_weight`는 원장 합과 대조.
   - 맞춤단가·상품·주문·거래처 연결: `audit_log`에 변경 이력이 있다(이 4개 표만). 입고 박스·발주서는 이력 표가 없다 → 백업 필요.
   - 되돌릴 사본이 필요하면 **백업이 있어야 한다(4번).**
4. **재발 방지.** 원인 경로에 가드/테스트를 추가하고 `scripts/db-test-tenant-guards.sql`에 교차 시도 사례를 넣는다.

## 4. 백업 — 영업 시작 전이라 보류, **첫 실데이터 입력 전 필수** (2026-10-02 결정)

`supabase backups list`(운영 프로젝트, 2026-10-02): **백업 0건, PITR 꺼짐.** 지금은 테스트 데이터뿐(영업 미시작, 공급사 3곳·주문 0건)이라 대표님이 결제를 보류했다. 코드·마이그레이션은 GitHub에 있어 DB는 새로 만들어 복원할 수 있다.

**첫 실제 공급사에게 데이터를 입력받기 직전에 반드시 할 것:**
1. Supabase **Pro($25/월, 일일 백업 7일 보관)**로 전환 → `supabase backups list`로 백업이 실제로 생기는지 확인. (2026-10-02 공식 문서 기준)
2. **Storage 파일(사업자등록증·명세서·상품 이미지)은 백업에 포함되지 않는다** — 별도 사본 방안을 이 시점에 정한다.
3. PITR(7일 보관 월 약 $100 + Small 이상 compute 추가, 켜면 일일 백업 대체)은 주문이 실제로 쌓이기 시작할 때 다시 판단한다.

주의: **Free 플랜은 1주일 활동이 없으면 프로젝트가 자동 일시정지**된다 — 영업 시연·초기 체험 일정 전에 상태를 확인하거나 Pro로 올린다.
참고: 백업 복구는 DB 전체를 그 시점으로 되돌린다(공급사별 선택 복구 없음). 섞임 사고는 3번 절차(원장·변경 이력으로 해당 행만 수리)가 먼저이고, 백업은 비교용 사본 또는 최후 수단이다.

## 5. 검증 명령 (로컬 Docker, 전부 롤백)

```
npx vitest run --config vitest.integration.config.mts tests/integration/tenant-isolation.itest.ts
```
- 쓰기 방어 15건(`scripts/db-test-tenant-guards.sql`), 읽기 격리 전수(`db-test-read-isolation.sql`), 주문·고객 시나리오 21건(`db-test-order-customer-isolation.sql`).
- **Storage 파일 격리**(`tests/integration/storage-isolation.itest.ts`, 22건): 실제 Storage API로 다른 공급사·고객·비로그인의 읽기·목록·업로드·덮어쓰기·삭제와 경로 꼼수(`..`, 비uuid, 대문자·중괄호·하이픈 없는 id)를 시도한다. 자기 폴더 업로드 대조군 4건 포함, 정책을 느슨하게 하면 실패함을 확인. 운영 DB의 Storage 정책 18개·버킷 5개가 로컬과 해시까지 같음(2026-10-02). 공개 버킷(product-images·shop-thumbnails)은 읽기 공개가 의도다.
- 읽기 격리 전수는 로컬에 남은 데이터로 돌려서 **남의 행이 실제 존재해 의미 있던 표는 일부(2026-10-02 기준 11개)**다. 나머지는 "보이지 않음"이 데이터 부재 때문일 수 있어, 주문·품목·맞춤단가·거래처는 시나리오 스크립트가 따로 시드해서 검증한다.

## 6. 알려진 한계 (정직하게)

- 모든 표의 쓰기 교차 시도를 자동 생성하지는 못한다 — 새 표의 쓰기 방어는 위 "새 규칙"대로 사람이 가드를 걸어야 하고, 안 걸면 구조 검사가 실패해 알려 준다.
- `product_has_stock_history`, `organization_has_no_staff`는 UUID를 알면 존재 여부(boolean)만 알려 준다. 섞임은 아니나 정보 노출은 있다. 낮은 우선순위.
- 서비스키를 쓰는 서버 코드는 RLS를 우회한다. 2026-10-02에 21개 경로(크론 8 + 사용자 요청이 닿는 13)를 전부 읽고 소속이 세션·서명 토큰·검증된 행에서만 오는 것을 확인했다(결함 없음). 새 사용처는 `lib/security/service-role-usage.test.ts`가 실패로 알려 주며, 읽고 확인한 뒤 `REVIEWED`에 추가해야 한다. 낮은 위험으로 남은 것: 웹푸시 구독은 endpoint 충돌 시 덮어쓴다(endpoint는 브라우저별 비공개 주소라 추측 불가라고 판단, 미재현).
