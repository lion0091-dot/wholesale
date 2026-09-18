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
 * - `billing_starts_at`(NULL 가능)이 지정 안 됐거나 아직 도래 전이면, 체험만료/연체/
 *   해지 여부와 무관하게 접근 차단을 절대 하지 않는다. 지금 당장은 공급사별로
 *   실제 과금 시작 시점을 잡기 어려워서, super_admin이 나중에 개별적으로 날짜를
 *   지정하면 그때부터 기존 체험/연체 로직이 적용되는 구조로 뒀다.
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

/**
 * 연체/해지/체험만료 — 셋 중 하나라도 해당하면 백오피스 접근이 막힌다.
 * 단, billingStartsAt이 null이거나 아직 도래하지 않았으면 그 어떤 경우에도 차단하지
 * 않는다 — 과금 자체가 아직 "켜지지" 않은 상태이기 때문이다.
 */
export function isBillingBlocked(
  subscriptionStatus: string,
  trialStartedAt: string,
  billingStartsAt: string | null
): boolean {
  if (!billingStartsAt || Date.now() < new Date(billingStartsAt).getTime()) {
    return false;
  }

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
