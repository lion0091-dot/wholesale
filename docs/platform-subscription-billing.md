# 플랫폼 구독료 (거래처 수 비례 종량제)

## 배경
`wholesalers.subscription_status`(trial/active/overdue/cancelled) 컬럼은 원래부터 있었지만, 실제로는 대시보드 상단 뱃지 표시용일 뿐 결제를 걷는 로직도, 상태에 따라 뭔가를 제한하는 로직도 없었다. 이 작업으로 "돈을 걷는 것"과 "상태에 따라 접근을 제한하는 것" 두 가지를 실제로 만들었다.

## 가격 구조 (잠긴 설계 결정)
- 공급사(도매)가 플랫폼에 내는 구독료는 **거래처(소매) 수에 비례한 종량제**다. 정액제가 아니다.
- 과금 대상은 `wholesaler_retailers.status = 'active'`(거래중)인 거래처만 — 거래중지(blocked)는 카운트에서 제외된다. 거래중지/재개는 [[retailer-suspend-permission]](../app/dashboard/customers/) 기능으로 공급사가 직접 조작할 수 있지만, 7일 냉각기간이 있어 청구 시점만 피해 되돌리는 게 어렵다.
- 2026-09-18부터 **구간별 누진(계단식·소득세형) 단가**로 변경(초기 정액 5,000원/곳에서 전환). 구간이 올라가도 이전 구간의 곳까지 같이 오르지 않고, 그 구간에 걸린 곳만 해당 구간 단가가 적용된다.
  - 1~50곳: 곳당 5,000원
  - 51~100곳: 곳당 7,000원
  - 101곳~: 곳당 9,000원
  - 예) 60곳 = 50×5,000 + 10×7,000 = 320,000원/월
  - `lib/supplier/billing.ts`의 `FEE_TIERS` 배열 + `computeMonthlyFee()`.
- 대문(`/#subscription`)에 요금 구간표를 안내 문구로 게시.

## 무료 체험 30일 + 기존 계정 소급 방지 (잠긴 설계 결정)
- 신규 가입 시 `wholesalers.trial_started_at`이 가입 시각으로 채워지고, 이 시각 + 30일이 지나도 `subscription_status`가 여전히 `trial`이면 체험 만료로 간주한다.
- `trial_started_at`은 `created_at`을 재사용하지 않고 **별도 컬럼**으로 뒀다 — 가입일 기준으로 소급 적용하면 이미 30일이 지난 기존 계정들이 배포 즉시 한꺼번에 잠기기 때문이다. 마이그레이션(`20260930000038`)에서 `DEFAULT now()`로 컬럼을 추가해, 기존 행은 전부 "배포 시각부터 30일"로 리셋되고 신규 가입자는 실제 가입 시각을 그대로 받는다.

## 접근 차단 (잠긴 설계 결정)
- `subscription_status`가 `overdue`/`cancelled`이거나, `trial`인데 체험 30일이 지났으면 `/dashboard` 전체 접근이 막힌다.
- `middleware.ts`가 조직 소속(organization_staff) 확인 직후 `lib/supplier/billing.ts`의 `isBillingBlocked()`로 판정하고, 막히면 `/billing-locked`(대시보드 밖의 독립 라우트 — `/onboarding`과 같은 이유로 리다이렉트 루프 방지)로 보낸다.
- super_admin은 이 차단에서 예외(감독 열람 목적).
- `/billing-locked`는 사유(연체/해지/체험만료)와 "이번 달 구독료"(구간별 누진 단가로 계산, `computeMonthlyFee`)를 보여주고, 결제는 관리자에게 문의하라고 안내한다. 대문 요금 안내(`/#subscription`) 링크도 함께 노출.

## 결제 수단 (아직 미정 — 의도적 보류)
자동결제(토스페이먼츠 정기결제/빌링키)는 플랫폼 자체의 별도 가맹계약이 필요해 아직 하지 않는다. 지금은 `/admin/suppliers`에서 super_admin이 계좌이체 등으로 입금을 수동 확인한 뒤 `subscription_status`를 직접 바꾸는 방식(기존 UI 그대로, `updateSupplierSubscriptionAction`)으로 운영한다. 자동화는 나중에 별도 논의.

## 아키텍처
- `supabase/migrations/20260930000038_wholesaler_trial_started_at.sql` — `wholesalers.trial_started_at` 컬럼 추가.
- `lib/supplier/billing.ts` — 요금 계산(`computeMonthlyFee`)·체험만료 판정(`isTrialExpired`)·차단 판정(`isBillingBlocked`)·잔여일수(`trialDaysRemaining`) 공용 로직. middleware(Edge)와 서버 컴포넌트 양쪽에서 import.
- `middleware.ts` — `/dashboard` 접근 시 조직의 연결된 wholesaler를 조회해 차단 판정, 막히면 `/billing-locked`로 리다이렉트.
- `app/billing-locked/page.tsx` — 차단 안내 화면. 이미 해제됐으면 `/dashboard`로 되돌린다.
- `app/admin/suppliers/page.tsx` + `supplier-approval-list.tsx` — 공급사별 "이번 달 구독료"(구간별 누진 단가)와 체험 잔여일수/차단 여부를 목록에 표시. 거래처 수는 `wholesaler_retailers`를 `active`로 필터링해 wholesaler_id별로 집계.
- `app/page.tsx`의 `#subscription` 섹션 — 대문에 구간별 요금표(1~50/51~100/101~)를 안내 문구로 게시.

## 남은 과제
- 실제 결제 자동화(빌링키) 여부/시점 미정.
- 연체 유예기간(예: 3일) 없이 즉시 차단 — 필요시 유예기간 정책 추가 논의.
- 관리자용 "이번 달 전체 청구 예상 합계" 요약 카드는 아직 없음(공급사별 개별 표시만 있음).
