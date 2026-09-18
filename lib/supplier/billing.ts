/**
 * 플랫폼 구독료 — 거래처(소매) 수 비례 종량제.
 *
 * 잠긴 설계 결정:
 * - 거래중(active)인 거래처 1곳당 월 5,000원.
 * - 신규 가입 후 30일 무료 체험, 이후 미결제 시 백오피스 접근 차단.
 * - 결제 자동화(빌링키 등)는 미정 — super_admin이 /admin/suppliers에서
 *   subscription_status를 수동으로 바꾸는 방식으로 우선 운영한다.
 */

export const MONTHLY_FEE_PER_RETAILER = 5000;
export const TRIAL_DAYS = 30;

const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

export function computeMonthlyFee(activeRetailerCount: number): number {
  return activeRetailerCount * MONTHLY_FEE_PER_RETAILER;
}

export function isTrialExpired(subscriptionStatus: string, trialStartedAt: string): boolean {
  return subscriptionStatus === "trial" && Date.now() - new Date(trialStartedAt).getTime() > TRIAL_MS;
}

/** 연체/해지/체험만료 — 셋 중 하나라도 해당하면 백오피스 접근이 막힌다. */
export function isBillingBlocked(subscriptionStatus: string, trialStartedAt: string): boolean {
  return (
    subscriptionStatus === "overdue" ||
    subscriptionStatus === "cancelled" ||
    isTrialExpired(subscriptionStatus, trialStartedAt)
  );
}

/** 체험 종료까지 남은 일수(음수 없이 0까지). trial이 아니면 호출측에서 걸러야 한다. */
export function trialDaysRemaining(trialStartedAt: string): number {
  const remainingMs = TRIAL_MS - (Date.now() - new Date(trialStartedAt).getTime());

  return Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
}
