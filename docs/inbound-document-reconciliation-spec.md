# 29단계 B — 명세서 ↔ 실물 박스 사무실 대조 화면 스펙

작성 2026-09-25. DB 뼈대(마이그레이션 118)와 이 문서는 Fable 세션에서 만들었고, **화면·서버 액션·테스트 구현은 이 문서를 스펙으로 삼아 별도(Sonnet) 세션에서 한다.** 판단이 필요한 건 전부 여기 적어두었다 — 구현 세션은 여기 없는 결정을 새로 내리지 말고 사장님께 묻는다.

관련: `docs/livestock-inbound-tracking.md` 29단계·29단계 보강 절, `supabase/migrations/20260930000115~118_*.sql`.

## 1. 잠긴 결정 (바꾸지 않는다)

1. **재고는 스캔이 만든다.** 이 화면은 대조·집계용이다. 박스를 줄에 붙이거나 떼는 것은 재고 원장에 아무 영향이 없다. 상품이 정해지지 않은 박스(PENDING_MAPPING·EXCEPTION)는 예전과 똑같이 **상품 지정**(`resolveMappingAction`)을 해야 재고에 들어간다 — 이 화면은 그 상품 지정을 사무실에서 할 수 있게 같은 버튼을 두는 것뿐이다.
2. **애매한 배정은 사무실에서** (사장님 결정 2026-09-25). 현장 스캔은 해당 줄이 하나로 정해질 때만 자동으로 붙이고(`auto_link_scan_to_document_line`), 나머지는 이 화면에 남긴다. 현장 화면에 줄 고르기 UI를 추가하지 않는다.
3. **자동은 하나일 때만.** 후보가 여럿이면 프로그램이 고르지 않는다. 번호 없는 줄은 제안만 하고 사람이 확정한다.
4. **재고 단위는 로트.** 로트↔개체 연결(116)은 조회용 다리이고 개체별 재고를 만들지 않는다.
5. **마감은 사람이 누른다.** 미입고 줄이 남아 있으면 사유 한 줄 필수(`CLOSE_NOTE_REQUIRED`).
6. 설정 변경·화면 분기(PC/모바일 다른 동작)는 사장님 확인 후에만. 이 화면은 사무실용이라 PC 우선이지만 모바일에서 깨지지 않게만 한다.

## 2. DB가 이미 제공하는 것 (118)

| 함수/표 | 용도 | 권한 |
|---|---|---|
| `inbound_document_line_scans` | 줄↔박스 연결표. 박스 하나는 줄 하나에만(`scan_id UNIQUE`). 직접 INSERT/DELETE 불가, SELECT는 문서 권한 | RLS SELECT |
| `document_line_match_status(line_id)` → `(expected, linked, status)` | 줄 상태 계산. `AWAITING / PARTIAL / COMPLETE / OVER`. 예정 = 수량 칸(없으면 1), VOIDED 박스는 안 셈 | authenticated |
| `link_scan_to_document_line(scan_id, line_id, 'MANUAL')` | 붙이기(다른 줄에 붙어 있었으면 옮김). 오류: `DOCUMENT_NOT_PENDING`, `SCAN_VOIDED`, `SCAN_NOT_FOUND`, `FORBIDDEN` | authenticated |
| `unlink_scan_from_document_line(scan_id)` | 떼기. 오류 `DOCUMENT_NOT_PENDING` | authenticated |
| `auto_link_scan_to_document_line(scan_id)` | 현장 스캔 직후 자동 배정(이미 `recordScanAction`이 부름). 화면에서 직접 부를 일 없음 | authenticated |
| `relink_pending_scans_to_documents()` | 명세서 저장 직후(이미 `saveInboundDocumentAction`이 부름): 상품 거슬러 확정 + 최근 30일 미배정 박스 자동 배정 | authenticated |
| `match_document_lines_for_traces(wholesaler_id, trace_nos[])` | 찍힌 번호들 → 해당 줄(같은 번호·두 칸·로트↔개체). **후보 줄 계산에 쓴다** | authenticated |
| `close_inbound_document(document_id, note)` | 마감. 미입고 있으면 note 필수, `CLOSE_NOTE_REQUIRED:<n>`. note는 `inbound_documents.note`에 `[마감 시각] …`으로 덧붙음 | authenticated |
| `reopen_inbound_document(document_id)` | CLOSED → PENDING | authenticated |
| 트리거 `trg_unlink_voided_scan` | 박스 취소 시 연결 자동 삭제 | — |
| `record_inbound_scan_base` 수정 | 대조 중 명세서에 자리가 남은 줄이 있으면 같은 번호·같은 중량 연속 스캔에 중복 창을 띄우지 않음 | — |

`inbound_documents.status`: `DRAFT`(원본만) / `PENDING`(대조 중) / `CLOSED`(마감) / `DISCARDED`(취소). 이 화면은 PENDING·CLOSED만 다룬다.

## 3. 화면: `/dashboard/inbound/documents/[id]`

기존 파일 관례: `app/dashboard/orders/[id]/page.tsx`(서버 컴포넌트가 데이터 조회 → 클라이언트 뷰에 props). 스코프는 `getSupplierScope()`, super_admin 무스코프는 `AdminScopeNotice`. 스타일은 `inbound-document-panel.tsx`의 `panelStyle/thStyle/tdStyle/linkButton/secondaryButton`을 옮겨 쓰거나 같은 값으로.

진입: `inbound-document-panel.tsx`의 "올린 명세서" 목록 각 행에 **"대조"** 링크(PENDING·CLOSED만, DRAFT·DISCARDED는 없음). 행에 줄 상태 요약 배지(예: `3/5 완료`, `마감`)를 보이면 좋다 — 목록 쿼리(`page.tsx`)에 줄별 상태 집계를 더해야 한다.

### 3.1 머리
공급처명, 서류 날짜, 문서번호, 상태 배지(대조 중 / 마감), 원본 보기(`getDocumentFileUrlAction`), 마감 메모(note).

### 3.2 줄 표 (문서의 `inbound_document_lines` 전부, `line_no` 순)
열: 줄번호 / 품목명 / 부위·등급·원산지 / 이력번호 / 묶음번호 / 내 상품(`product_id` → 이름) / 예정 수량(`document_line_expected_qty` = 수량 칸 또는 1) / **붙은 박스 n / 예정** / 상태 배지 / 표기중량 합(`labeled_weight`) vs 실중량 합(붙은 박스 `inbound_scans.weight` 합) 차이.

- 상태 색: AWAITING 회색 "대기", PARTIAL 노랑 "일부", COMPLETE 초록 "완료", OVER 빨강 "초과".
- 줄을 펼치면 붙은 박스 목록: 이력번호, 실중량, 표기중량, 찍은 시각, 상태(NORMAL/PENDING_MAPPING/EXCEPTION), 붙인 방법(자동/수동), **떼기** 버튼(`unlink_scan_from_document_line`).
- 원문 한 줄을 나눈 줄(`raw_text`에 `(이력번호 k/N)`)은 중량·금액이 첫 줄에만 있으니 중량 대조는 첫 줄에서만 표시하고 뒷줄은 "첫 줄 합계에 포함"으로 적는다.

### 3.3 안 붙은 박스 (서류에 없는 물건 후보)
대상: 이 업체 `inbound_scans` 중 `status <> 'VOIDED'`, 어느 줄에도 안 붙은 것, **기간은 서류 날짜(issued_on, 없으면 created_at) 기준 −7일 ~ +14일**. 이 범위는 임의값이다 — 화면 위에 기간 조절(날짜 두 칸)을 둔다.

박스마다 **후보 줄**을 계산한다.

1. **번호 후보**: `match_document_lines_for_traces(wholesaler, [모든 박스 번호])` 결과를 이 문서 줄로 좁힌다. 같은 번호·두 칸·로트↔개체가 전부 여기 들어온다.
2. **번호 없는 줄 제안** (`trace_no`·`lot_no`가 모두 NULL인 줄에만): 박스의 축종(`master_livestock.species_group`, 없으면 `parseTraceNumber`의 축종)이 줄 품목명의 축종 단어(`speciesMentionedIn`)와 맞고, 박스 실중량이 `줄 표기중량 ÷ 예정수량`의 **±10%** 안이면 제안. 축종을 알 수 없으면 중량만으로 제안하되 "축종 미확인" 표시. **±10%는 제안용 임의값**(입고 허용오차 ±2%와 다름) — 상수로 두고 주석에 적는다.
3. 후보가 하나든 여럿이든 **자동으로 붙이지 않는다**(현장에서 자동으로 붙을 수 있었던 건 이미 붙어 있다). 카드에 후보 줄 버튼을 나열하고 사람이 탭하면 `link_scan_to_document_line(scan, line, 'MANUAL')`.
4. 후보가 없는 박스는 "서류에 없는 물건" 구획에 따로. 그래도 줄 드롭다운으로 수동 배정은 가능해야 한다.
5. 박스가 PENDING_MAPPING·EXCEPTION이면 카드에 **상품 지정** 드롭다운(`resolveMappingAction(scanId, productId)`) — 현장 화면의 것과 같은 동작. 줄에 붙일 때 그 줄에 `product_id`가 있고 박스는 미확정이면 "이 줄 상품으로 지정할까요?" 확인 후 `resolveMappingAction`까지 이어서 호출한다(한 번에).

### 3.4 요약 띠
줄 수 / 완료 / 일부 / 대기 / 초과, 안 붙은 박스 수, 표기중량 합 vs 실중량 합 총차이. **미입고 목록**(AWAITING·PARTIAL 줄)은 "공급처에 보낼 문구 복사" 버튼 — 기존 `inbound-document-panel.tsx`의 supplierRequests 복사 패턴 재사용.

### 3.5 마감 / 다시 열기
- 마감 버튼 → 미입고가 있으면 사유 입력 모달(필수) → `close_inbound_document`. 오류 `CLOSE_NOTE_REQUIRED:n`은 "미입고 n줄이 있어 사유가 필요합니다"로.
- 마감 상태에서는 붙이기·떼기 버튼 비활성 + "다시 열기"(`reopen_inbound_document`).
- 완전 삭제·취소 처리는 기존 목록 화면에 있으니 여기 두지 않는다.

## 4. 서버 액션 (`app/dashboard/inbound/document-actions.ts`에 추가)
`"use server"` 파일이라 **async 함수만 export**(tsc로 못 잡고 build에서 깨짐 — `use-server-export-build-check` 메모). 전부 `resolveDocumentScope()`로 스코프 확인 후 RPC, 오류 코드는 사람 말로 바꿔서 `RbacError`.

- `linkScanToDocumentLineAction(scanId, lineId)`
- `unlinkScanFromDocumentLineAction(scanId)`
- `closeInboundDocumentAction(documentId, note)`
- `reopenInboundDocumentAction(documentId)`
- (상품 지정은 기존 `actions.ts`의 `resolveMappingAction` 그대로 import)

## 5. 데이터 조회 (서버 컴포넌트)
- 문서: `inbound_documents` 단건(스코프 업체 확인, 없으면 `notFound()`).
- 줄: `inbound_document_lines` + `products(name)`; 상태는 줄마다 `document_line_match_status` RPC를 N번 부르지 말고 **연결표를 통째로 읽어**(`inbound_document_line_scans` + `inbound_scans`) 서버에서 세는 게 낫다. 계산 규칙은 함수와 같아야 한다(예정 = `GREATEST(1, round(quantity))`, VOIDED 제외).
- 안 붙은 박스: `inbound_scans`(기간·VOIDED 제외) 중 `inbound_document_line_scans`에 없는 것. 후보는 3.3.

## 6. 테스트 (Sonnet이 작성)
통합테스트(`tests/integration/inbound.itest.ts` 또는 새 파일 `documents.itest.ts`, 하네스 `createDocumentLine`에 `quantity`·`documentId` 옵션 있음). 118 자체의 동작(자동 배정·중복 창 우회·취소 시 해제·마감 사유·거슬러 배정) 7건은 이미 `inbound.itest.ts` "명세서 줄 ↔ 박스 연결" 절에 있다. 추가할 것:

1. 서버 액션 4개 — 정상·타 업체 문서 거부·마감 문서 거부.
2. 번호 없는 줄 제안 계산(순수 함수로 뽑아 `vitest` 단위테스트): 축종 일치·±10%·축종 미확인.
3. 줄 상태 집계(서버 계산)가 `document_line_match_status`와 같은 값을 내는지 1건.

## 7. 스펙에 없는 것 (하지 않는다)
- 재고 확정 시점 변경, 임시 재고, 저울 연동, 명세서 저장 시 상품 자동 생성, 현장 화면의 줄 고르기 UI, GS1 AI(10) 자체 로트 연결, 실제 PDF·엑셀 검증.

## 8. 경우의 수 뼈대 (구현 세션이 이 표를 채워 문서 끝에 붙인다)

구현 완료(2026-09-25, Sonnet 세션). 코드로 실제 확인한 경로만 적는다 — `document_lines_matching_trace`(116)의
네 갈래 매칭 조건과 `auto_link_scan_to_document_line`(118)의 "후보 1개일 때만 자동" 규칙을 그대로 따라갔다.

범례: **자동** = 스캔 즉시 `auto_link_scan_to_document_line`이 후보가 정확히 하나일 때만 붙임(§1-3).
**사무실** = 이 화면(§3.3)에서 후보 버튼을 보고 사람이 `link_scan_to_document_line(MANUAL)`로 붙임.
칸 형식: *배정 → 상품 결정 → 사무실에 남는 것 → 재고 확정 시점*.

가로(명세서 줄 형태) — C1 번호 하나 / C2 번호 하나·수량 N / C3 한 줄 번호 여럿→나눈 줄 / C4 묶음번호만
(trace_no에 로트번호) / C5 묶음+개체 두 칸(trace_no=개체, lot_no=로트) / C6 번호 없음.

세로(박스가 찍은 번호) — R1 줄과 같은 번호 / R2 줄의 번호가 로트이고 박스는 그 구성원 개체 / R3 박스가 찍은 게
로트번호이고 줄은 그 구성원 개체 / R4 GS1 GTIN 동반(이력번호와 별개 경로) / R5 번호가 이력조회·로트조회
둘 다 안 걸림(사실상 모든 박스 스캔은 번호가 필수라 "번호 자체가 없음"은 없다 — 대신 "매칭 안 되는 번호").

| | C1 번호 하나 | C2 번호 하나·수량N | C3 나눈 줄 | C4 묶음번호만 | C5 묶음+개체 두 칸 |
|---|---|---|---|---|---|
| **R1 같은 번호** | 자동(후보 1) → 학습맵 있으면 즉시, 없으면 대기(PENDING_MAPPING) → 미확정이면 상품지정 카드만 → 스캔 즉시(상품 확정 시). 근거: §1-1·§1-3, 118§4 | 자동(자리 남은 동안, 118§6 중복창 우회) → C1과 동일 → 자리 다 찼는데 또 찍히면 OVER로 사무실에 남음 → 각 박스 스캔 즉시 | 자동(그 번호가 속한 나뉜 줄 하나만 후보) → C1과 동일 → 표기중량·금액은 첫 줄 합계에만 있어 화면이 "첫 줄 합계에 포함" 표시 → 스캔 즉시. 근거: document-parser.ts 분리 로직 | 박스가 로트 바코드 자체를 찍은 드문 경우 — 자동(후보 1) → C1과 동일 → — → 스캔 즉시 | 자동(trace_no=개체번호로 같음) → C1과 동일 → — → 스캔 즉시. 근거: 115 |
| **R2 줄=로트, 박스=구성원** | 해당 없음(줄이 로트가 아님) | 해당 없음 | 해당 없음 | 자동(후보 1, `lot_member_trace_nos`로 구성원 확인) → 상품 결정은 그 로트 줄 기준 동일 → 로트 구성원 미등록이면 사전조회가 이미 걸러 공급처 확인 요청(document-actions.ts) → 스캔 즉시. 근거: 116 `document_lines_matching_trace` 세 번째 조건 | lot_no가 로트 → 자동(후보 1) → 동일 → — → 스캔 즉시. 근거: 116 |
| **R3 박스=로트, 줄=구성원** | 흔치 않음(박스는 보통 개체 단위 스캔) — 후보가 있으면 자동, C1과 동일 | 동일 | 동일 | 해당 없음(줄 자체가 로트라 줄=로트, 박스=로트 방향은 R1) | 두 칸 서식에서 개체번호(trace_no)가 그 로트의 구성원 — 자동(후보 1) → 동일 → — → 스캔 즉시. 근거: 116 네 번째 조건 |
| **R4 GS1 GTIN 동반** | 이력번호 매칭은 R1과 동일(GTIN은 별개 축) → 상품은 이력 매핑이 우선, `learn_gtin_product`는 보조 학습(resolveMappingAction 호출 시에만 저장) → GTIN 학습과 명세서가 다른 상품을 가리키면 `productConflict`로 스캔 화면이 알림(사무실 화면 범위 밖) → 스캔 즉시. 근거: actions.ts productConflict | 동일 | 동일 | 동일 | 동일 |
| **R5 매칭 안 되는 번호** | 이력조회 실패 → EXCEPTION, 명세서 매칭도 없음 → 자동 배정 안 됨(후보 0) → 사무실 "안 붙은 박스"에 후보 없음으로 남음, 수동 드롭다운으로만 배정 가능 → 상품 지정 시점(사무실에서 지정해야) | 동일 | 동일 | 동일 | 동일 |

**C6 번호 없는 줄**은 위 R1~R5(번호 매칭)의 대상이 아니다 — 박스가 어떤 번호를 찍든 이 줄과는 번호로 못 잇는다.
대신 §3.3-2의 제안(축종+표기중량÷예정수량 ±10%)만 적용되고, **자동 배정은 절대 없다**(잠긴 결정 §1-2·§1-3) —
사무실 화면에 항상 "제안" 배지로만 뜨고 사람이 눌러야 붙는다. 근거: `lib/livestock/document-reconciliation.ts`
`suggestDocumentLinesForScan`.
