/**
 * 관리자용 플랫폼 전체 통계(월별 구독자/구독료 추이) — 기존 데이터만으로 재구성한다.
 * 새 스키마 없이 wholesalers.created_at(가입 시점)과 orders.ordered_at(실발주 이력)만
 * 사용하므로 언제든 임의 과거 구간을 다시 계산할 수 있다.
 *
 * 잠긴 단순화 결정: 이벤트 할인·일할 계산은 과거 달 재구성에는 반영하지 않는다(그 두
 * 기능 자체가 최근에 생겼고, 과거 시점 기준을 되짚기엔 근거 데이터가 마땅치 않다) —
 * "구간별 누진 단가 기준 정가"만 보여준다.
 */

import type { createClient } from "@/lib/supabase/server";
import { computeMonthlyFee } from "@/lib/supplier/billing";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toKstDate(isoUtc: string): Date {
  return new Date(new Date(isoUtc).getTime() + KST_OFFSET_MS);
}

function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 'YYYY-MM'의 KST 달력 월 경계를 UTC ISO로. lib/supplier/billed-retailers.ts와 같은 원칙. */
function monthRangeUtc(monthKey: string): { startUtc: string; endUtc: string } {
  const [year, month] = monthKey.split("-").map(Number);
  const startKst = Date.UTC(year, month - 1, 1, 0, 0, 0);
  const endKst = Date.UTC(year, month, 1, 0, 0, 0);

  return {
    startUtc: new Date(startKst - KST_OFFSET_MS).toISOString(),
    endUtc: new Date(endKst - KST_OFFSET_MS).toISOString(),
  };
}

/** startMonth~endMonth(둘 다 'YYYY-MM', 포함) 사이 모든 월 키를 오름차순으로. */
export function enumerateMonthKeys(startMonth: string, endMonth: string): string[] {
  const [startYear, startMonthNum] = startMonth.split("-").map(Number);
  const [endYear, endMonthNum] = endMonth.split("-").map(Number);
  const keys: string[] = [];
  let year = startYear;
  let month = startMonthNum;

  while (year < endYear || (year === endYear && month <= endMonthNum)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return keys;
}

export interface MonthlyPlatformStat {
  /** 'YYYY-MM' (KST 기준) */
  month: string;
  /** 이 달에 새로 가입한 공급사 수 */
  newSupplierCount: number;
  /** 이 달 말 기준 누적 가입 공급사 수("구독자 추이" 기본 지표) */
  cumulativeSupplierCount: number;
  /** 이 달 전체 공급사 구독료 합계(구간별 누진 단가 기준 정가, 할인·일할 미반영) */
  totalMonthlyFee: number;
}

export async function getMonthlyPlatformStats(
  supabase: SupabaseServerClient,
  startMonth: string,
  endMonth: string
): Promise<MonthlyPlatformStat[]> {
  const monthKeys = enumerateMonthKeys(startMonth, endMonth);

  if (monthKeys.length === 0) {
    return [];
  }

  const rangeStartUtc = monthRangeUtc(monthKeys[0]).startUtc;
  const rangeEndUtc = monthRangeUtc(monthKeys[monthKeys.length - 1]).endUtc;

  const [{ data: wholesalers }, { data: orders }] = await Promise.all([
    supabase.from("wholesalers").select("created_at").lt("created_at", rangeEndUtc),
    supabase
      .from("orders")
      .select("wholesaler_id, retailer_id, ordered_at")
      .neq("status", "cancelled")
      .gte("ordered_at", rangeStartUtc)
      .lt("ordered_at", rangeEndUtc),
  ]);

  const wholesalerMonthKeys = ((wholesalers ?? []) as Array<{ created_at: string }>)
    .map((row) => monthKeyOf(toKstDate(row.created_at)))
    .sort();

  const newByMonth = new Map<string, number>();
  for (const key of wholesalerMonthKeys) {
    newByMonth.set(key, (newByMonth.get(key) ?? 0) + 1);
  }

  // 월 → (wholesaler_id → 그 달에 실발주한 거래처 id 집합)
  const billedRetailersByMonth = new Map<string, Map<string, Set<string>>>();

  for (const order of (orders ?? []) as Array<{
    wholesaler_id: string;
    retailer_id: string;
    ordered_at: string;
  }>) {
    const key = monthKeyOf(toKstDate(order.ordered_at));

    if (!billedRetailersByMonth.has(key)) {
      billedRetailersByMonth.set(key, new Map());
    }

    const byWholesaler = billedRetailersByMonth.get(key)!;

    if (!byWholesaler.has(order.wholesaler_id)) {
      byWholesaler.set(order.wholesaler_id, new Set());
    }

    byWholesaler.get(order.wholesaler_id)!.add(order.retailer_id);
  }

  let cumulative = 0;
  let cursor = 0;

  return monthKeys.map((key) => {
    while (cursor < wholesalerMonthKeys.length && wholesalerMonthKeys[cursor] <= key) {
      cumulative += 1;
      cursor += 1;
    }

    const byWholesaler = billedRetailersByMonth.get(key);
    const totalMonthlyFee = byWholesaler
      ? Array.from(byWholesaler.values()).reduce(
          (sum, retailerSet) => sum + computeMonthlyFee(retailerSet.size),
          0
        )
      : 0;

    return {
      month: key,
      newSupplierCount: newByMonth.get(key) ?? 0,
      cumulativeSupplierCount: cumulative,
      totalMonthlyFee,
    };
  });
}
