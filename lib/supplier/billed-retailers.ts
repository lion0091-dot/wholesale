/**
 * 구독료 과금 대상 거래처 집계 — "당월 실발주(주문 발생) 거래처 수" 기준.
 *
 * 잠긴 설계 결정 (2026-09-18, active 상태 기준에서 전환):
 * - 이전엔 wholesaler_retailers.status='active'(거래중 관계)를 기준으로 과금했는데,
 *   이러면 발주가 한 건도 없는 "유령" 거래처도 계속 과금 대상이 되고, 공급사가
 *   거래중지/재개를 반복해 관계 상태만 조작하면 과금을 회피할 수 있다는 문제가 있었다.
 * - 이번 달(KST 달력 기준, 1일 00:00 ~ 다음달 1일 00:00 직전) 취소(cancelled)가 아닌
 *   주문이 1건이라도 있었던 거래처만 과금 대상으로 센다. [[retailer-suspend-permission]]
 *   (거래중지/재개 권한)의 원래 목적이던 "과금 회피 방지"는 이 전환으로 자동 해소된다
 *   — 이번 달 주문 자체가 없으면 애초에 과금이 안 되기 때문이다. 다만 그 기능 자체는
 *   불량거래처 관리용으로 계속 유효하다.
 * - middleware(Edge 런타임)에서는 이 모듈을 import하지 않는다 — createClient()가
 *   next/headers에 의존하는 서버 전용 모듈이기 때문. 접근 차단 판정(lib/supplier/billing.ts
 *   의 isBillingBlocked)은 subscription_status/trial_started_at/billing_starts_at만 보고,
 *   실발주 집계와는 무관하게 동작한다 — 금액 "표시"만 이 모듈을 쓴다.
 */

import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 이번 달(KST 달력 기준) 경계를 UTC ISO 문자열로 반환. timestamptz는 절대 시각이라 이 값으로 정확히 비교된다. */
export function currentBillingMonthRangeUtc(now: Date = new Date()): { startUtc: string; endUtc: string } {
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const startKst = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), 1, 0, 0, 0);
  const endKst = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth() + 1, 1, 0, 0, 0);

  return {
    startUtc: new Date(startKst - KST_OFFSET_MS).toISOString(),
    endUtc: new Date(endKst - KST_OFFSET_MS).toISOString(),
  };
}

/** 특정 공급사의 이번 달 실발주(취소 제외) 거래처 수. */
export async function countBilledRetailers(
  supabase: SupabaseServerClient,
  wholesalerId: string
): Promise<number> {
  const { startUtc, endUtc } = currentBillingMonthRangeUtc();

  const { data } = await supabase
    .from("orders")
    .select("retailer_id")
    .eq("wholesaler_id", wholesalerId)
    .neq("status", "cancelled")
    .gte("ordered_at", startUtc)
    .lt("ordered_at", endUtc);

  return new Set(((data ?? []) as Array<{ retailer_id: string }>).map((row) => row.retailer_id)).size;
}

/** 전체 공급사의 이번 달 실발주 거래처 수 — wholesaler_id별 집계 (관리자 목록 화면용). */
export async function countBilledRetailersForAllSuppliers(
  supabase: SupabaseServerClient
): Promise<Record<string, number>> {
  const { startUtc, endUtc } = currentBillingMonthRangeUtc();

  const { data } = await supabase
    .from("orders")
    .select("wholesaler_id, retailer_id")
    .neq("status", "cancelled")
    .gte("ordered_at", startUtc)
    .lt("ordered_at", endUtc);

  const seen = new Set<string>();
  const counts: Record<string, number> = {};

  for (const row of (data ?? []) as Array<{ wholesaler_id: string; retailer_id: string }>) {
    const key = `${row.wholesaler_id}:${row.retailer_id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    counts[row.wholesaler_id] = (counts[row.wholesaler_id] ?? 0) + 1;
  }

  return counts;
}
