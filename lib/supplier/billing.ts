/**
 * 플랫폼 구독료 — 거래처(소매) 수 비례 종량제, 구간별 누진(계단식·소득세형) 단가.
 *
 * 잠긴 설계 결정:
 * - 거래중(active)인 거래처 수 기준. 구간이 올라가도 그 구간에 걸린 만큼만 높은
 *   단가가 적용된다(cliff 방식 아님) — 51번째 거래처가 생겼다고 앞의 50곳 단가까지
 *   같이 뛰지 않는다.
 *   - 1~50곳: 곳당 5,000원
 *   - 51~100곳: 곳당 7,000원
 *   - 101곳~: 곳당 9,000원
 *   예) 60곳 = 50×5,000 + 10×7,000 = 320,000원
 * - 신규 가입 후 30일 무료 체험, 이후 미결제 시 백오피스 접근 차단.
 * - 결제 자동화(빌링키 등)는 미정 — super_admin이 /admin/suppliers에서
 *   subscription_status를 수동으로 바꾸는 방식으로 우선 운영한다.
 */

/** 구간 상한(threshold)과 그 구간의 곳당 단가. 마지막 구간은 상한 없음(Infinity). */
export const FEE_TIERS = [
  { threshold: 50, rate: 5000 },
  { threshold: 100, rate: 7000 },
  { threshold: Infinity, rate: 9000 },
] as const;

export const TRIAL_DAYS = 30;

const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

export function computeMonthlyFee(activeRetailerCount: number): number {
  let remaining = activeRetailerCount;
  let previousThreshold = 0;
  let fee = 0;

  for (const tier of FEE_TIERS) {
    if (remaining <= 0) {
      break;
    }

    const countInTier = Math.min(remaining, tier.threshold - previousThreshold);

    fee += countInTier * tier.rate;
    remaining -= countInTier;
    previousThreshold = tier.threshold;
  }

  return fee;
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
