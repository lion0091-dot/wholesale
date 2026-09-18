# PG(토스페이먼츠) 결제 연동 + 고객별 결제수단 관리

## 배경
기존엔 결제수단이 "직접정산"(즉시결제, 실제로는 계좌이체 등을 플랫폼이 관여하지 않고 기록만 함)과 "외상"(여신) 두 가지뿐이었다. 여기에 실제 카드결제(PG)를 추가하고, 어떤 결제수단을 쓸 수 있는지를 공급사가 거래처별로 직접 켜고 끄는 구조로 확장했다.

## 알림톡과 같은 계약 구조 (잠긴 설계 결정)
플랫폼은 PG사와 파트너 계약을 맺지 않는다. **공급사가 토스페이먼츠와 개별 가맹계약**을 맺어 자기 클라이언트키/시크릿키를 발급받고, 우리 설정 화면(`/dashboard/invites`)에 입력하면 그 키로 결제창을 붙여준다. 플랫폼은 기술 연동만 대행하고 자금(정산/환불)에는 관여하지 않는다 — 알림톡(비즈뿌리오)과 완전히 같은 구조다. (팝빌 세금계산서와는 반대 구조 — 그쪽은 플랫폼-파트너 1건 계약.)

## 고객별 결제수단 허용목록 (잠긴 설계 결정)
- `wholesaler_retailers.allowed_payment_methods`(text[])로 공급사가 거래처마다 외상/직접정산/PG를 개별로 켜고 끈다. `/dashboard/customers`의 "결제 설정" 모달(기존 "여신 한도 수정" 모달 확장)에서 체크박스로 관리.
- 이 배열은 "공급사가 열어줬는가"만 나타낸다 — 실제 사용 가능 여부는 추가 조건이 있다: 외상은 `credit_limit > 0`이어야, PG는 공급사 자신의 PG 연동(`pg_client_key`)이 설정돼 있어야 체크아웃에 노출된다. 체크아웃 화면(`checkout-view.tsx`)이 이 교집합을 다시 계산한다.
- 기본값 `{prepaid}` — 기존 동작(옵션 안 보이고 바로 직접정산)과 동일하게 유지.

## 결제 흐름 — "결제 확정 후에만 주문 생성" (잠긴 설계 결정)
기존 `submitOrderAction`은 저장 즉시 공급사에게 알림톡을 보낸다. PG 결제도 똑같이 하면, 고객이 결제 중간에 이탈해도 공급사에게 유령 주문 알림이 갈 수 있다. 그래서 PG 결제만 다른 순서로 진행한다:

1. 체크아웃에서 "PG(카드) 결제" 선택 → `initiatePgPaymentAction`이 장바구니 검증까지만 하고 **아직 `orders`에 쓰지 않는다** — `pg_pending_payments`(임시 테이블, 30분 만료)에 장바구니 스냅샷/배송정보/기대금액을 저장하고 참조ID(`pgOrderId`)를 발급한다.
2. 프론트가 토스 결제창(v1, `TossPayments(clientKey).requestPayment('카드', {...})`)을 연다. 결제위젯(임베드)이 아니라 더 간단한 결제창(오버레이/리다이렉트) 방식을 골랐다 — 우리 체크아웃 폼을 그대로 두고 결제만 토스에 위임하는 게 목적이라 위젯 UI를 직접 렌더링할 필요가 없다.
3. 결제 완료 → 토스가 `successUrl`(`/shop/[token]/checkout/pg/success`)로 리다이렉트(`paymentKey`, `orderId`, `amount` 쿼리).
4. 이 라우트가 **금액을 반드시 대조**(URL의 amount가 아니라 `pg_pending_payments`에 저장해둔 기대 금액과 비교 — 토스 공식 경고사항, 변조 방지)한 뒤 서버에서 승인 API(`confirmPayment`)를 호출한다.
5. 승인 성공 시 그제서야 `createOrderWithItems`(기존 `submitOrderAction`과 공유하는 헬퍼, `lib/orders/create-order.ts`)로 실제 주문 생성 + 알림톡 발송. `pg_pending_payments` 행 삭제.
6. 실패(카드 거절 등, 승인 API 호출 전 단계)는 `failUrl`(`/shop/[token]/checkout/pg/fail`)로 리다이렉트 — 임시 행만 정리하고 체크아웃으로 돌려보낸다.

## 자동환불 (잠긴 설계 결정)
취소 승인(`updateOrderStatusAction`이 어떤 상태에서든 `cancelled`로 전이할 때) 시, 주문이 `payment_method='pg'`이고 `payment_status='paid'`이면 **환불이 성공해야만 상태 전이를 허용**한다. 환불 API(`cancelPayment`) 호출이 실패하면 예외를 던져 상태 변경 자체를 막는다 — "취소 처리는 됐는데 환불은 안 됨" 사고를 방지하기 위함이다. 환불 성공 시 같은 UPDATE에서 `payment_status`를 `refunded`로 함께 바꾼다.

## 아키텍처
- `supabase/migrations/20260930000034_pg_payments.sql` — `wholesalers.pg_provider/pg_client_key/pg_secret_key_encrypted`, `wholesaler_retailers.allowed_payment_methods`, `orders.payment_status/pg_payment_key/pg_order_id`, 신규 테이블 `pg_pending_payments`(RLS 포함).
- `lib/payments/tosspayments-client.ts` — 토스 결제 승인/취소 API 클라이언트. 알림톡과 같은 이유로 SDK가 아니라 raw fetch(시크릿키 Basic Auth가 단순해서 SDK 의존성이 불필요 — 팝빌과 달리 비공개 서명 프로토콜이 없음).
- `lib/orders/create-order.ts` — `createOrderWithItems`/`buildOrderNumber`. `submitOrderAction`(직접정산/외상)과 PG 성공 콜백이 공유한다.
- `app/actions/pg-settings.ts` + `app/dashboard/invites/pg-settings-form.tsx` — 공급사 PG 자격정보 설정(owner/manager 전용, 알림톡 설정과 동일 패턴). 시크릿키는 `credential-crypto.ts`로 암호화.
- `app/dashboard/customers/actions.ts`(`updateCreditLimitAction` 확장) + `customer-table.tsx` — 고객별 결제수단 체크박스.
- `app/shop/[shop_token]/checkout/pg/actions.ts` — `initiatePgPaymentAction`(결제 준비, pending 저장).
- `app/shop/[shop_token]/checkout/pg/success/route.ts` — 승인 콜백(`runtime = "nodejs"`, Node crypto 의존). 금액 대조 → 승인 → 주문 생성 → 알림톡.
- `app/shop/[shop_token]/checkout/pg/fail/route.ts` — 실패 콜백, pending 정리.
- `app/dashboard/orders/actions.ts`(`updateOrderStatusAction` 확장) — 취소 승인 시 자동환불.
- `types/tosspayments.d.ts` — 브라우저 SDK(`window.TossPayments`) 최소 타입 선언(공식 타입 패키지 없음).

## 미검증 / 추정치로 채운 부분 (실계정 전까지 확인 불가)
- 결제창 successUrl/failUrl 리다이렉트 쿼리 파라미터 이름(`paymentKey`/`orderId`/`amount`, `code`/`message`/`orderId`) — 공식 문서 검색 결과 기준, 실계정 미검증.
- 승인/취소 API 응답 필드명(`paymentKey`/`orderId`/`status`/`totalAmount`/`approvedAt`).
- `requestPayment('카드', ...)` 호출 시 팝업/리다이렉트 UX가 실제로 어떻게 동작하는지.

## 검증 상태
- `tsc --noEmit`, `next build` 통과.
- `pg_pending_payments` 등 스키마는 라이브 DB에 적용 확인됨(2026-09-18).
- **토스페이먼츠 계정 미발급** — `POPBILL`과 달리 이건 공급사가 각자 가입해야 해서, 플랫폼 차원의 테스트 계정도 아직 없다. 위 "미검증" 항목 전부 공급사 1곳이라도 실계정 연동 후 재확인 필요.
- 체크아웃 실계정 클릭 확인 안 함.

## 남은 과제
- 공급사 1곳 실계정으로 전체 흐름(결제 준비 → 결제창 → 승인 → 주문생성 → 취소 → 자동환불) 실호출 검증.
- 부분환불 미지원 — `cancelPayment`는 항상 전액 취소만 지원(`cancelAmount` 생략). 부분 취소/부분 반품 시나리오는 범위 밖.
- `pg_pending_payments` 만료 행 정리 배치 없음 — 지금은 재고/락에 영향 없는 순수 메타데이터라 방치해도 무해하다고 판단해 크론을 안 만들었다. 행 수가 많아지면 나중에 추가 검토.
- "여신 한도 임시 상향 + 자동 원복" 같은 기능 없음 — 지금은 한도를 올리면 영구 변경이라, 예외 처리 후 되돌리는 걸 사람이 기억해야 한다(감사로그는 남음).
