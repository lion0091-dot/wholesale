/**
 * 플랫폼 구독료 청구서 확정(스냅샷) 계산 — app/api/cron/finalize-subscription-invoices가
 * 매달 1일 이 계산 결과를 platform_subscription_invoices에 한 번만 저장한다. 저장된
 * 이후엔 원본(orders 등)이 바뀌어도 다시 계산하지 않는다(잠긴 결정, 마이그레이션
 * 20260930000043 주석 참고).
 */

import type { createClient } from "@/lib/supabase/server";
import { computeFinalFee, computeMonthlyFee, computeProrationRatio } from "@/lib/supplier/billing";
import { countBilledRetailers, monthRangeUtc } from "@/lib/supplier/billed-retailers";
import { listActiveEventsForMonth, resolveDiscountForWholesaler } from "@/lib/supplier/platform-events";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export interface WholesalerBillingRow {
  id: string;
  billing_starts_at: string | null;
}

export interface ComputedInvoice {
  wholesalerId: string;
  billedRetailerCount: number;
  fullMonthFee: number;
  amount: number;
}

/**
 * 지정한 공급사 목록에 대해 특정 달('YYYY-MM')의 확정 청구액을 계산한다(저장은 하지 않음).
 * billing_starts_at이 그 달이 끝나기 전에 시작되지 않은 공급사는 애초에 청구 대상이
 * 아니므로 결과에서 제외한다.
 */
export async function computeInvoicesForMonth(
  supabase: SupabaseServerClient,
  wholesalers: WholesalerBillingRow[],
  billingMonthKey: string
): Promise<ComputedInvoice[]> {
  const range = monthRangeUtc(billingMonthKey);
  const rangeEndMs = new Date(range.endUtc).getTime();

  const billable = wholesalers.filter(
    (wholesaler) => wholesaler.billing_starts_at && new Date(wholesaler.billing_starts_at).getTime() < rangeEndMs
  );

  if (billable.length === 0) {
    return [];
  }

  const eventsSnapshot = await listActiveEventsForMonth(supabase, range);

  return Promise.all(
    billable.map(async (wholesaler) => {
      const billedRetailerCount = await countBilledRetailers(supabase, wholesaler.id, range);
      const fullMonthFee = computeMonthlyFee(billedRetailerCount);
      const prorationRatio = computeProrationRatio(wholesaler.billing_starts_at as string, range);
      const { discountRate } = resolveDiscountForWholesaler(wholesaler.id, eventsSnapshot);
      const amount = computeFinalFee(fullMonthFee, prorationRatio, discountRate);

      return { wholesalerId: wholesaler.id, billedRetailerCount, fullMonthFee, amount };
    })
  );
}
