# 배송 조회 (스위트트래커 연동)

## 배경
공급사가 주문 상태를 수동으로 "배송중"/"완료"로만 바꿀 수 있고 실제 운송장번호 조회가 없던 문제.
사용자 결정: 우리 플랫폼은 운송장 발급/배송비 정산을 대행하지 않는다 — 공급사가 택배사와 직접
계약해 이미 발송한 운송장번호를 입력하면, 스위트트래커(SweetTracker) 조회 전용 API로 배송 상태만
보여준다. 정산은 기존처럼 도매업자와 택배사 사이에서 직접 이뤄진다(우리 플랫폼은 관여 안 함).

## 잠긴 설계 결정
- **정산/운송장 발급 대행 아님, 조회만**: API 키 하나로 상태 조회만 하고, 배송비/결제는 절대 우리
  플랫폼을 거치지 않는다. 이 원칙을 깨는 방향(예: 배송비 정산 기능 추가)으로 확장하지 말 것.
- **상태 캐싱 안 함**: `orders.courier_code`/`tracking_number`만 저장하고, 배송 상태 자체는 저장하지
  않는다. "배송 조회" 버튼을 열 때마다 라이브 API를 호출한다(`StatementPreviewButton`과 동일한
  지연 로딩 패턴). API 호출량이 문제되면 그때 캐싱 컬럼을 추가로 검토.
- **Server Action, Route Handler 아님**: 이 코드베이스는 JSON을 반환하는 외부 API 호출을 전부
  Server Action으로 처리한다(`lib/verification/nts-business.ts` 관례). PDF처럼 iframe에 스트리밍할
  필요가 없어 Route Handler를 새로 만들지 않았다.

## 아키텍처
- **DB**: `supabase/migrations/20260930000030_orders_tracking_columns.sql` — `orders.courier_code`,
  `orders.tracking_number` (둘 다 nullable TEXT). RLS/트리거 변경 없음 — 기존 UPDATE 정책이 소유
  공급사/조직 직원에게 이미 무제한 쓰기를 허용한다.
- **API 클라이언트**: `lib/verification/sweettracker.ts` — `nts-business.ts`와 동일 스타일(절대
  throw 안 하고 `{status, message}` discriminated result 반환). `KOREAN_COURIERS` 상수로 택배사
  코드 목록을 관리(`companylist` API를 매번 호출하지 않음).
- **공급사 UI**: `app/dashboard/orders/[id]/tracking-panel.tsx` — 택배사 select + 운송장번호 input +
  저장(`updateOrderTrackingAction`), 저장되면 조회 토글 버튼(`fetchOrderTrackingStatusAction`).
- **바이어 UI**: `app/shop/[shop_token]/orders/order-history-view.tsx`의 `TrackingLookupButton` —
  `fetchBuyerTrackingStatusAction`(`app/shop/[shop_token]/actions.ts`)으로 조회. 운송장번호가
  저장된 주문에서만 노출.
- **설정 필요 폴백**: `isSweetTrackerConfigured()`가 false면(= `SWEETTRACKER_API_KEY` 미설정) 조회
  버튼 대신 안내 문구만 보여준다(`ALIMTALK_API_KEY` 없을 때의 "테스트 발송" 폴백과 동일 패턴).
  운송장번호 입력/저장 자체는 키 유무와 무관하게 항상 가능하다.

## 배포 상태 (2026-09-17)
라이브 DB에 마이그레이션(`20260930000030_orders_tracking_columns.sql`) 적용 확인 후
`claude/markdown-accounts-recevable-ah816p` → `master` fast-forward 병합 + push 완료(`714a1f9`).

## 남은 과제 / 미확정 사항
- **API 키 미발급** (2026-09-17 기준) — 사용자가 tracking.sweettracker.co.kr에서 발급 후
  `SWEETTRACKER_API_KEY`를 `.env.local`/Vercel 환경변수에 설정해야 실제 조회가 동작한다.
- **스위트트래커 정확한 엔드포인트/파라미터/응답 필드명 미검증** — `lib/verification/sweettracker.ts`는
  일반적으로 알려진 형식(`t_key`/`t_code`/`t_invoice`, `trackingDetails` 배열)으로 작성했으나, 키
  발급 후 공식 문서 기준으로 재검증 필요. 실제 응답과 다르면 이 파일만 고치면 된다(호출부는 안
  건드려도 됨).
- **택배사 코드표 정확한 값 미검증** — `KOREAN_COURIERS`(CJ대한통운/한진/롯데/로젠/우체국/경동)도
  공식 코드표로 재확인 필요.
- 라이브 마이그레이션 미적용 — 사용자가 Supabase SQL Editor에서 직접 적용 예정.
- 실계정 라이브 검증 안 함(로컬 프로덕션 빌드로 UI 렌더링만 확인).
