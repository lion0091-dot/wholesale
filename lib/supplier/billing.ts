/**
 * 플랫폼 구독료 — 거래처(소매) 수 비례 종량제, 구간별 누진(계단식·소득세형) 단가.
 *
 * 이 파일은 순수 계산 함수만 담는다(middleware Edge 런타임에서도 import되므로
 * next/headers 등 서버 전용 의존성 금지). "과금 대상 거래처 수를 실제로 세는" 로직은
 * lib/supplier/billed-retailers.ts(서버 컴포넌트 전용)에 있다 — 2026-09-18부터
 * wholesaler_retailers.status='active' 기준에서 **이번 달 실발주(주문 발생) 거래처 수**
 * 기준으로 전환됨(자세한 배경/이유는 그 파일 주석 참고).
 *
 * 잠긴 설계 결정:
 * - 구간이 올라가도 그 구간에 걸린 만큼만 높은 단가가 적용된다(cliff 방식 아님) —
 *   51번째 거래처가 생겼다고 앞의 50곳 단가까지 같이 뛰지 않는다.
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

export interface FeeTierBreakdown {
  /** "1~50곳" 또는 마지막 구간이면 "101곳~" */
  rangeLabel: string;
  /** 이 구간에 걸린 거래처 수 */
  count: number;
  rate: number;
  subtotal: number;
}

/** 구간별 적용 내역 (청구서 화면에서 "50곳 × 5,000원 + 10곳 × 7,000원" 식으로 보여주는 용도) */
export function computeFeeBreakdown(retailerCount: number): FeeTierBreakdown[] {
  let remaining = retailerCount;
  let previousThreshold = 0;
  const breakdown: FeeTierBreakdown[] = [];

  for (const tier of FEE_TIERS) {
    if (remaining <= 0) {
      break;
    }

    const countInTier = Math.min(remaining, tier.threshold - previousThreshold);

    if (countInTier > 0) {
      const rangeLabel =
        tier.threshold === Infinity
          ? `${previousThreshold + 1}곳~`
          : `${previousThreshold + 1}~${tier.threshold}곳`;

      breakdown.push({ rangeLabel, count: countInTier, rate: tier.rate, subtotal: countInTier * tier.rate });
    }

    remaining -= countInTier;
    previousThreshold = tier.threshold;
  }

  return breakdown;
}

export function computeMonthlyFee(retailerCount: number): number {
  return computeFeeBreakdown(retailerCount).reduce((sum, tier) => sum + tier.subtotal, 0);
}

/**
 * 첫 과금월(billing_starts_at이 속한 달)의 일할 비율. 월 중간에 과금이 시작되면
 * "시작일 ~ 그 달 말일"만큼만 비례 청구하고, 그 다음 달부터는 항상 1(전액)이다.
 * 달 경계는 호출측이 lib/supplier/billed-retailers.ts의 currentBillingMonthRangeUtc()로
 * 구한 KST 달력 월 경계를 그대로 넘겨야 한다(이 파일은 middleware Edge에서도 쓰이므로
 * next/headers 의존 모듈을 직접 import하지 않는다).
 */
export function computeProrationRatio(
  billingStartsAt: string,
  monthRangeUtc: { startUtc: string; endUtc: string }
): number {
  const startsAtMs = new Date(billingStartsAt).getTime();
  const monthStartMs = new Date(monthRangeUtc.startUtc).getTime();
  const monthEndMs = new Date(monthRangeUtc.endUtc).getTime();

  // 과금 시작일이 이번 달 1일 이전(이미 지난 달부터 과금 중)이면 전액.
  if (startsAtMs <= monthStartMs) {
    return 1;
  }

  // 과금 시작일이 이번 달 이후(아직 도래 전)면 호출측(isBillingBlocked)에서 이미
  // 차단하지 않도록 걸렀겠지만, 방어적으로 0을 반환한다.
  if (startsAtMs >= monthEndMs) {
    return 0;
  }

  return (monthEndMs - startsAtMs) / (monthEndMs - monthStartMs);
}

/**
 * 일할 비율 + 이벤트 할인율(%, lib/supplier/platform-events.ts)을 함께 적용한 최종 청구액.
 * 두 조정을 한 번에 곱해서 반올림 한 번만 하도록 모아둔 것 — 각각 따로 반올림하면
 * 둘 다 적용되는 달에 오차가 누적될 수 있다.
 */
export function computeFinalFee(
  fullMonthFee: number,
  prorationRatio: number,
  discountRatePercent: number
): number {
  return Math.round(fullMonthFee * prorationRatio * (1 - discountRatePercent / 100));
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

export interface BillingInvoiceMessageInput {
  businessName: string;
  representativeName: string;
  month?: number;
  billedCount: number;
  /** 최종 청구액(일할 계산·이벤트 할인이 적용됐다면 적용 후 금액) */
  monthlyFee: number;
  /** 일할/할인 적용 전 원래 한 달치 금액. monthlyFee와 다르면 안내 문구에 병기한다. */
  fullMonthFee?: number;
  siteOrigin?: string;
  bankAccountInfo?: string | null;
}

/**
 * 플랫폼 슈퍼관리자가 공급사 대표에게 발송하는 당월 구독료 청구서 문자 템플릿 생성.
 */
export function buildBillingInvoiceMessage({
  businessName,
  representativeName,
  month = new Date().getMonth() + 1,
  billedCount,
  monthlyFee,
  fullMonthFee,
  siteOrigin = "",
  bankAccountInfo,
}: BillingInvoiceMessageInput): string {
  const accountLine = bankAccountInfo ? `■ 입금 계좌: ${bankAccountInfo}\n` : "";
  const billingUrl = siteOrigin ? `${siteOrigin}/dashboard/billing` : "/dashboard/billing";
  const isAdjusted = fullMonthFee !== undefined && fullMonthFee !== monthlyFee;
  const feeLine = isAdjusted
    ? `■ 이번 달 구독료: ${monthlyFee.toLocaleString("ko-KR")}원 (정가 ${fullMonthFee!.toLocaleString("ko-KR")}원에서 일할 계산·이벤트 할인 적용)`
    : `■ 이번 달 구독료: ${monthlyFee.toLocaleString("ko-KR")}원 (구간별 누진 단가 적용)`;

  return `[미트파트너스] ${month}월 플랫폼 이용 구독료 청구 안내

${businessName} ${representativeName} 대표님, 안녕하세요.
이번 달 플랫폼 이용 구독료 산정 내역을 안내해 드립니다.

■ 당월 실발주 거래처: ${billedCount}곳
${feeLine}
${accountLine}■ 입금 기한: 매월 말일까지

상세 내역은 공급사 관리 대시보드(구독료 청구서)에서 확인하실 수 있습니다.
👉 청구서 상세 확인: ${billingUrl}

감사합니다. 미트파트너스 운영팀 드림`;
}
