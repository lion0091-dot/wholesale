# 입고 ↔ 발주서 연결 (마이그레이션 142·143)

입고 박스를 "지금 온 거래처"의 열린 발주서 줄과 맞춰 보고, 입고 기준(`receiving_policies`, 141)으로 받을지 정한다.

## 진행 상태

- ① DB·판정 함수: 완료(로컬). `scripts/db-test-purchase-order-receiving.sql` 통과(묶음 채움·사장님 200/25kg 시나리오 포함). **라이브 미적용.**
- 발주 관리 화면(`/dashboard/purchase-orders`): 줄마다 "받음 N kg · 남음 M kg / 다 받음", 발주서 상태 표시("입고 중"·"다 받음"). 화면 클릭 검증 안 함.
- ② 입고 스캔 화면·서버 액션 연결: 완료(로컬). 입고 스캔 화면 맨 위 "지금 온 거래처"(필수, 한 번 고르면 유지·localStorage) — 예전 매입처 글자 칸은 없어지고 고른 거래처 이름이 매입처로 기록된다. `recordScanAction`·`recordSplitScansAction`은 `supplierId`를 받고(서버 필수는 아님 — 화면이 필수로 막는다, 엑셀 입고는 안 보냄), 결과에 `po`·`status: "REJECTED"`가 실린다. 자동 생성·사무실 상품 지정·번호 바로잡기 경로도 같은 판정을 받고(`lib/livestock/scan-purchase-order.ts`), 나눠서 입고는 한 줄이라도 거절되면 전부 취소한다. 검증: `tests/integration/inbound-purchase-order.itest.ts` 7건.
- ③ 사무실 화면: 줄 고르기는 없어졌고 보류·거절 목록만 남음(미착수).

## 잠긴 결정

- 거래처를 실은 스캔만 판정한다. 안 실은 스캔(엑셀 대량 입고, 옛 호출)은 판정·제한 없음.
- **재고와 판매는 발주서와 무관하다.** 받은 박스는 발주서가 덜 찼든 무게가 안 맞든 스캔 즉시 재고가 되어 팔린다. 발주서는 받은 양을 세는 장부일 뿐이다. 예외는 거절된 박스(재고에 안 들어감)뿐이다.
- 거절한 박스는 재고·입고 기록으로 남기지 않되 "거절했다"는 사실은 `inbound_rejections`에 한 줄 남긴다(사장님 결정). 스캔은 VOIDED로 취소된다.
- **박스는 발주서 줄에 통째로 붙지 않고 수량으로 나눠 채운다**(사장님 2026-09-28, 200kg·25kg 발주서에 70+80kg 박스가 먼저 오고 77kg 박스가 나중에 오는 경우). 같은 거래처·같은 품목의 열린 발주서 줄들을 하나의 묶음으로 보고 발주일 → 작성 시각 → 줄 번호 순으로 채운다. 채움은 `purchase_order_line_scans(scan_id, line_id, weight)`에 박스별로 남는다(박스 하나가 여러 줄에 나뉠 수 있음). 그래서 입고 기준의 "배정 방식(사무실이 고름/오래된 순)" 설정과 사무실의 줄 고르기 화면은 없앴다(141의 `line_assignment` 컬럼은 142가 삭제).
- 받은 양은 파생 값: 줄에 채워진 박스 무게(취소 제외)의 합. 별도 합계 컬럼 없음.
- 초과 = 받은 양 + 박스 > 열린 발주 합계(품목별) + 허용 오차. 허용 오차는 비율 또는 kg 하나. 허용 오차 안의 초과분은 마지막에 채운 줄에 얹는다.
- 발주서에 없는 물건은 기준에 따라 REJECT(거절+기록) / HOLD(받고 `UNLISTED_HELD`, 사무실 확인).
- 발주 수량(+허용 오차)을 넘은 박스도 기준(`over_item_policy`)에 따라 REJECT(기본, 거절+기록) / HOLD(받아서 재고에 넣고 `OVER_HELD`, 사무실 확인). HOLD면 발주서 줄엔 남은 자리만 채우고 넘친 무게는 어느 줄에도 안 붙인다(결과에 `excess`).
- 줄이 다 찬 발주서만 자동 마감(`auto_closed_at`). 박스를 취소하면 그 박스의 채움이 사라지고 자동 마감됐던 발주서들이 다시 열린다(사람이 닫은 것은 그대로).
- **마감 뒤 같은 품목이 더 오면 초과(OVER)로 거절한다.** 자동 마감된 발주서에 그 품목이 있을 때만 — 사람이 닫은 발주서는 "없는 물건" 기준을 따른다.
- 상품이 정해지기 전(PENDING_MAPPING·EXCEPTION)에는 판정하지 않고, 상품이 정해지는 순간(`resolve_inbound_mapping`, 자동 생성 포함)에 같은 판정을 한다.

## 함수

- `judge_scan_purchase_order(scan_id)` — 판정+채움. 멱등(이미 판정된 박스는 결과만 돌려줌). 결과 `ASSIGNED / UNLISTED_HELD / OVER_HELD / REJECTED / SKIPPED`. `ordered/received/remaining`은 이 박스가 채운 줄들 기준.
- `record_inbound_scan(..., p_supplier_id)` — 거래처를 받아 스캔에 기록하고 판정. 거절이면 응답 `status = 'REJECTED'`, 판정은 `po` 키에 실린다. 매입처 이름은 거래처 이름으로 채워진다(직접 준 값이 우선).
- `resolve_inbound_mapping` — 판정 결과를 `po`로 돌려주고 거절이면 `status = 'REJECTED'`. `resolve_inbound_mapping_to_order`는 거절이면 출고를 건너뛰고 `outbound: null`. `replace_inbound_scan_trace_no`는 거래처를 새 박스로 이어받고 판정한다.
- 판정 함수는 `authenticated`만 실행. 내부 함수(`refresh_purchase_order_completion`, `purchase_order_scan_progress`, 취소 트리거)는 EXECUTE 회수.

## 남은 결정·과제

- 허용 오차 %는 열린 발주 합계 기준이다 — 발주서들이 함께 닫히므로(묶음 채움) 앞 발주서가 먼저 마감돼 오차 폭이 줄어드는 일은 없다.
- 덜 온 발주서(다 채우지 못함)는 자동 마감되지 않는다 — 사람이 발주 관리의 "발주강제종결"로 닫는다(자동 마감은 "발주종결", 이름이 다르다).
- 엑셀 입고는 거래처를 안 보내 판정을 받지 않는다.

## 발주 상태 용어 (2026-09-29 정리)

- **발주종결**(초록): 시스템이 자동으로 — 발주한 양을 다 받아서 스스로 닫힘.
- **강제종결**(초록, 같은 색): 사람이 "발주강제종결" 버튼을 눌러 손으로 닫음(덜 받았어도). 공급처 결품 통보·수요 변화·전화로 끝난 걸 확인한 경우 등.
- **입고 중**(노랑): 일부만 받은 진행 중 발주서.
- **진행 중**(파랑): 아직 하나도 안 받음.

## 전표 ↔ 발주서 연결 (마이그레이션 143)

**사장님 원칙(2026-09-29):** 거래명세표(전표)는 공급처의 주장이라 틀릴 수 있고, 실물 확정은 입고 스캔뿐이다. 전표를 상품과 대조해 먼저 전표에 기록하고, 그 전표로 발주서를 정리한다. 발주에 없이 추가로 들어온 상품은 입고 기준대로 받고("일단 받고"일 때만) "미발주 상품"으로 재고에 남긴다.

**"대표의 의사결정" 원칙(사장님 2026-09-29):** 발주서가 기준이므로, 실물이 발주서에 없다고 해서 시스템이 조용히 발주서를 만들거나 고치지 않는다. **owner/manager가 "발주서 추가 생성" 버튼을 직접 눌러야만** 발주서가 사후에 만들어진다.

### 진입점 둘

1. **전표 대조 화면**(`/dashboard/inbound/documents/[id]`) — 전표에 거래처(`inbound_documents.supplier_id`)를 한 번 골라 두면(문서당 한 번), 그 전표에 이어진 박스 중 발주서에 못 붙은 만큼(`scan_unassigned_weight`)에 "발주서 추가 생성" 버튼이 뜬다. 전표는 이미 있으니 새로 안 만들고 발주서만 사후 등록한다(`create_purchase_order_from_document_scan`).
2. **보류함 화면**(`/dashboard/inbound/holds`, 새 화면) — 발주서에 없는 물건(`UNLISTED_HELD`)·초과로 받은 물건(`OVER_HELD`)으로 재고엔 들어갔지만 전표가 없는 박스 목록. "발주서 추가 생성"을 누르면 발주서와 **전표를 둘 다** 만든다(`create_purchase_order_from_unlisted_scan`). 받지 않은 물건(`inbound_rejections`) 최근 이력도 읽기 전용으로 같이 보여준다.

두 진입점 모두 공용 내부 함수 `create_retroactive_purchase_order(scan_id, supplier_id, ordered_on)`를 쓴다: 이미 실물이 다 온 것을 사후에 기록하는 것이라 새 발주서는 그 자리에서 바로 자동 마감(발주종결)된다.

### 잠긴 결정

- 전표에 거래처를 붙이는 건 `set_document_supplier` — owner/manager만, 대조 중이든 마감이든 상관없이 바꿀 수 있다.
- "발주서 추가 생성"은 owner/manager만(`can_manage_wholesaler`, TS 액션에서도 이중 확인). 직원은 못 누른다.
- 보류함 경로는 스캔에 이미 전표가 이어져 있으면 거부한다(`SCAN_ALREADY_ON_DOCUMENT`) — 그럴 땐 전표 대조 화면에서 처리한다.
- 새로 만든 발주서 줄의 수량은 "발주서에 아직 안 붙은 무게"만큼이다(`scan_unassigned_weight` = 스캔 무게 − 이미 다른 발주서 줄에 채워진 무게). `UNLISTED_HELD`는 전체, `OVER_HELD`는 넘친 만큼만.
- 스펙(축종·부위·등급·원산지·품종)은 스캔이 붙은 상품에서 그대로 복사한다.

### 함수

- `scan_unassigned_weight(scan_id)` — 내부 헬퍼.
- `create_retroactive_purchase_order(scan_id, supplier_id, ordered_on)` — 공용 내부, `can_manage_wholesaler` 게이트.
- `create_purchase_order_from_document_scan(scan_id)` — 진입점 1. `authenticated`.
- `create_purchase_order_from_unlisted_scan(scan_id)` — 진입점 2. `authenticated`.
- `set_document_supplier(document_id, supplier_id)` — `authenticated`.

### 검증

- `scripts/db-test-document-purchase-order-link.sql` — 로컬 통과(등록·초과분만 등록·멱등 가드·권한(FORBIDDEN)·격리·전표 거래처 없음/미이음 가드).
- `tests/integration/document-purchase-order-link.itest.ts` — 5건 통과(액션 이음새, 직원 거부, 보류함/전표 경로 교차 가드).
- `lib/livestock/retroactive-purchase-order.test.ts` — 결과 파싱 단위 테스트.
- 화면 클릭 검증 안 함. 라이브 미적용.

### 남은 과제

- 전표 대조 화면의 거래처 선택은 대조 화면에서만 가능하다 — 전표 올리기/직접 입력 화면(29단계 A, `inbound-document-panel.tsx`)에는 아직 추가하지 않음(이미 큰 화면이라 리스크 통제 목적, 선택 사항으로 보류).
- 보류함 화면은 데스크톱 전용 탭(사무 화면 원칙).

## 배포 순서

발주 관리 화면이 `purchase_order_line_scans`를 조회하므로 **라이브 DB에 142를 먼저 적용한 뒤** 코드를 배포한다(142는 추가형이라 옛 코드와 함께 있어도 안전). 143도 같은 이유로 라이브 적용을 코드 배포보다 먼저 한다 — 142·143을 한 번에 순서대로 적용하면 된다.
